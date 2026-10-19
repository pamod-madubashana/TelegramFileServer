import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A file's thumbnail, painted in two passes.
 *
 * The server advertises a cheap `low` preview with the listing itself, so the
 * first frame has something to show while the tile is still scrolling into
 * view. The larger `high` tier is asked for afterwards and only replaces the
 * low one once the browser has actually decoded it - a slow or missing large
 * thumbnail must never blank a tile that was already showing something.
 */
export function useProgressiveThumbnail(
  /** Cheap preview URL, already resolved and token-bearing. */
  lowUrl: string | undefined,
  /** Telegram message backing the file; no message means no thumbnail. */
  messageId: number | undefined,
): {
  thumbUrl: string | undefined;
  isFetchingThumbnail: boolean;
  dismissThumbnail: () => void;
} {
  const [thumbUrl, setThumbUrl] = useState<string | undefined>(lowUrl);
  const [isFetchingThumbnail, setIsFetchingThumbnail] = useState(
    () => !lowUrl && !!messageId,
  );
  // One upgrade attempt per row: a second pass would just re-ask the server
  // for a URL it has already refused.
  const attempted = useRef(false);

  useEffect(() => {
    attempted.current = false;
    setThumbUrl(lowUrl);
  }, [lowUrl, messageId]);

  useEffect(() => {
    if (!messageId || attempted.current) {
      return;
    }
    attempted.current = true;

    let cancelled = false;
    setIsFetchingThumbnail(!lowUrl);

    void (async () => {
      try {
        const highUrl = await invoke<string | null>(
          "tg_get_message_thumbnail",
          { messageId },
        );
        if (!highUrl || cancelled) {
          return;
        }

        // Swap only once the bytes are decoded: replacing `src` straight
        // away would flash an empty tile for the whole download.
        const preload = new Image();
        preload.onload = () => {
          if (!cancelled) {
            setThumbUrl(highUrl);
          }
        };
        preload.src = highUrl;
      } catch (error) {
        console.error(
          "Failed to load thumbnail for message",
          messageId,
          error,
        );
      } finally {
        if (!cancelled) {
          setIsFetchingThumbnail(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lowUrl, messageId]);

  /** Fall back to the file-type icon when a preview will not decode. */
  const dismissThumbnail = useCallback(() => {
    setThumbUrl(undefined);
    setIsFetchingThumbnail(false);
  }, []);

  return { thumbUrl, isFetchingThumbnail, dismissThumbnail };
}
