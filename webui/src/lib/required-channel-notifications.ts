import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { showOsNotification } from "@/lib/os-notifications";

export const REQUIRED_CHANNEL_NOTIFICATION_EVENT_NAME =
  "required-channel-post-notification";

export const REQUIRED_CHANNEL_NOTIFICATION_DELETED_EVENT_NAME =
  "required-channel-post-deleted";

export const REQUIRED_CHANNEL_NOTIFICATION_UPDATED_EVENT_NAME =
  "required-channel-post-notification-updated";

export type RequiredChannelNotificationPayload = {
  chat_id: number;
  message_id: number;
  text: string;
  preview_image?: string | null;
  formatted_text?: {
    text?: string;
    entities?: Array<{
      offset: number;
      length: number;
      type: Record<string, unknown>;
    }>;
  } | null;
  preview_image_data_url?: string | null;
  content_type?: string | null;
  created_at_ms?: number | null;
  timestamp?: number | null;
};

type RequiredChannelRecentPostDto = {
  chat_id: number;
  message_id: number;
  text: string;
  formatted_text?: RequiredChannelNotificationPayload["formatted_text"] | null;
  preview_image_data_url?: string | null;
  content_type?: string | null;
  created_at_ms?: number | null;
};

type AuthStateChangedEvent = {
  account_id: string;
  stage:
    | "Uninitialized"
    | "WaitingTdlibParameters"
    | "WaitingPhoneNumber"
    | "WaitingQrConfirmation"
    | "WaitingCode"
    | "WaitingPassword"
    | "Ready"
    | "LoggingOut"
    | "Closing"
    | "Closed";
};

export type RequiredChannelNotificationUpdatedPayload = {
  chat_id: number;
  message_id: number;
  preview_image?: string | null;
  timestamp?: number | null;
};

export type RequiredChannelNotificationDeletedPayload = {
  chat_id: number;
  message_ids: number[];
  timestamp?: number | null;
};

export type RequiredChannelNotificationItem = {
  id: string;
  chatId: number;
  messageId: number;
  text: string;
  formattedText?: RequiredChannelNotificationPayload["formatted_text"];
  previewImage?: string | null;
  contentType?: string | null;
  createdAtMs: number;
};

const STORAGE_KEY_ITEMS = "skybox_required_channel_notifications_v1";
const STORAGE_KEY_LAST_OPENED =
  "skybox_required_channel_notifications_last_opened_v1";

function isAuthNotReadyError(error: unknown): boolean {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : typeof error === "string"
        ? error
        : "";

  return (
    message.includes("Blocked background action") ||
    message.includes("TDLib is not authorized yet")
  );
}

function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function loadItems(): RequiredChannelNotificationItem[] {
  if (typeof window === "undefined") return [];
  const parsed = safeParseJson<unknown>(
    window.localStorage.getItem(STORAGE_KEY_ITEMS),
  );
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
    .map((item): RequiredChannelNotificationItem | null => {
      const chatId = Number(item.chatId);
      const messageId = Number(item.messageId);
      const text = typeof item.text === "string" ? item.text : "";
      const createdAtMs = Number(item.createdAtMs);
      if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return null;
      if (!Number.isFinite(createdAtMs)) return null;
      const id =
        typeof item.id === "string" ? item.id : `${chatId}:${messageId}`;
      const formattedText =
        typeof item.formattedText === "object" && item.formattedText !== null
          ? (item.formattedText as RequiredChannelNotificationItem["formattedText"])
          : null;
      const previewImage =
        typeof item.previewImage === "string"
          ? item.previewImage
          : typeof (item as { previewImageDataUrl?: unknown })
                .previewImageDataUrl === "string"
            ? String(
                (item as { previewImageDataUrl?: unknown }).previewImageDataUrl,
              )
            : null;
      const contentType =
        typeof item.contentType === "string" ? item.contentType : null;
      return buildNotificationItem({
        id,
        chatId,
        messageId,
        text,
        formattedText,
        previewImage,
        contentType,
        createdAtMs,
      });
    })
    .filter((item): item is RequiredChannelNotificationItem => item !== null);
}

function persistItems(items: RequiredChannelNotificationItem[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_ITEMS, JSON.stringify(items));
  } catch {
    // ignore
  }
}

function loadLastOpenedAtMs(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(STORAGE_KEY_LAST_OPENED);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

function persistLastOpenedAtMs(value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_LAST_OPENED, String(value));
  } catch {
    // ignore
  }
}

function normalizeNotificationText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getNormalizedFormattedText(
  formattedText?: RequiredChannelNotificationItem["formattedText"] | null,
): string {
  return typeof formattedText?.text === "string"
    ? normalizeNotificationText(formattedText.text)
    : "";
}

function shouldIgnoreNotificationItem(
  text: string,
  formattedText?: RequiredChannelNotificationItem["formattedText"] | null,
): boolean {
  const normalizedText = normalizeNotificationText(text);
  const normalizedFormattedText = getNormalizedFormattedText(formattedText);

  return (
    !normalizedFormattedText &&
    (!normalizedText || normalizedText === "New post")
  );
}

function buildNotificationItem(input: {
  id: string;
  chatId: number;
  messageId: number;
  text: string;
  formattedText?: RequiredChannelNotificationItem["formattedText"] | null;
  previewImage?: string | null;
  contentType?: string | null;
  createdAtMs: number;
}): RequiredChannelNotificationItem | null {
  if (shouldIgnoreNotificationItem(input.text, input.formattedText)) {
    return null;
  }

  return {
    id: input.id,
    chatId: input.chatId,
    messageId: input.messageId,
    text: input.text,
    formattedText: input.formattedText ?? null,
    previewImage: input.previewImage ?? null,
    contentType: input.contentType ?? null,
    createdAtMs: input.createdAtMs,
  };
}

function splitNotificationTitleAndBody(value: string): {
  title: string;
  body?: string;
} {
  const raw = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!raw) {
    return { title: "" };
  }

  const lines = raw
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim());

  // Drop leading empty lines.
  while (lines.length > 0 && !lines[0]) {
    lines.shift();
  }

  const title = lines[0] || "";
  const bodyLines = lines.slice(1).filter((line) => line.length > 0);
  const body = bodyLines.length ? bodyLines.join("\n") : undefined;
  return { title, body };
}

export function useRequiredChannelNotifications(
  chatId?: number,
  channelTitle?: string,
) {
  const [items, setItems] = useState<RequiredChannelNotificationItem[]>(() =>
    loadItems(),
  );
  const [lastOpenedAtMs, setLastOpenedAtMs] = useState<number>(() =>
    loadLastOpenedAtMs(),
  );

  const [osNotificationsEnabled, setOsNotificationsEnabled] = useState(false);
  const osNotificationsEnabledRef = useRef(false);

  useEffect(() => {
    osNotificationsEnabledRef.current = osNotificationsEnabled;
  }, [osNotificationsEnabled]);

  useEffect(() => {
    persistItems(items);
  }, [items]);

  useEffect(() => {
    persistLastOpenedAtMs(lastOpenedAtMs);
  }, [lastOpenedAtMs]);

  useEffect(() => {
    let cancelled = false;
    const seedCompletedRef = { current: false };
    Promise.all([
      invoke<string | null>("db_get_setting", {
        key: "notifications_os_enabled",
      }),
    ])
      .then(([os]) => {
        if (cancelled) return;
        setOsNotificationsEnabled(os !== "0");
      })
      .catch(() => {
        // ignore
      });

    const onSettingChanged = (event: Event) => {
      const typed = event as CustomEvent<{ key?: unknown; value?: unknown }>;
      const key =
        typed.detail && typeof typed.detail.key === "string"
          ? typed.detail.key
          : "";
      const value =
        typed.detail && typeof typed.detail.value === "string"
          ? typed.detail.value
          : null;
      if (key !== "notifications_os_enabled") {
        return;
      }
      setOsNotificationsEnabled(value === "1");
    };

    window.addEventListener(
      "skybox-notification-setting-changed",
      onSettingChanged,
    );

    let unlistenAdded: null | (() => void) = null;
    let unlistenDeleted: null | (() => void) = null;
    let unlistenUpdated: null | (() => void) = null;
    let unlistenAuthState: null | (() => void) = null;

    const notifiedMessageIds = new Set<string>();

    // Seed in-app widget with recent posts only after auth is ready.
    if (chatId && chatId !== 0) {
      const seedRecentPosts = async (attempt: number) => {
        try {
          const rows = await invoke<RequiredChannelRecentPostDto[]>(
            "tg_list_required_channel_recent_posts",
            {
              chatId,
              limit: 5,
            },
          );

          if (seedCompletedRef.current) {
            return;
          }

          const parsed = Array.isArray(rows) ? rows : [];
          console.debug(
            "[required-channel] recent posts seed ok:",
            parsed.length,
          );
          const mapped = parsed
            .map((row) => {
              const chatIdValue = Number(row.chat_id);
              const messageId = Number(row.message_id);
              const createdAtMsRaw =
                typeof row.created_at_ms === "number"
                  ? row.created_at_ms
                  : Date.now();
              const createdAtMs =
                Number.isFinite(createdAtMsRaw) && createdAtMsRaw > 0
                  ? createdAtMsRaw
                  : Date.now();
              if (
                !Number.isFinite(chatIdValue) ||
                !Number.isFinite(messageId)
              ) {
                return null;
              }
              if (chatId && chatIdValue !== chatId) {
                return null;
              }

              const id = `${chatIdValue}:${messageId}`;
              const text = typeof row.text === "string" ? row.text : "";
              const formattedText =
                typeof row.formatted_text === "object" &&
                row.formatted_text !== null
                  ? (row.formatted_text as RequiredChannelNotificationItem["formattedText"])
                  : null;
              const previewImage =
                typeof row.preview_image_data_url === "string"
                  ? row.preview_image_data_url
                  : null;
              const contentType =
                typeof row.content_type === "string" ? row.content_type : null;

              return buildNotificationItem({
                id,
                chatId: chatIdValue,
                messageId,
                text,
                formattedText,
                previewImage,
                contentType,
                createdAtMs,
              });
            })
            .filter(
              (item): item is RequiredChannelNotificationItem => item !== null,
            );

          if (!mapped.length) {
            // Channel history might not be available yet (e.g. membership check not completed).
            // Keep retrying for a while.
            if (attempt >= 40) {
              seedCompletedRef.current = true;
              return;
            }
            const delayMs = Math.min(20_000, 1500 + attempt * 800);
            window.setTimeout(() => {
              if (cancelled) return;
              void seedRecentPosts(attempt + 1);
            }, delayMs);
            return;
          }

          // Prevent duplicate OS notifications if TDLib also emits these shortly after startup.
          mapped.forEach((item) => {
            notifiedMessageIds.add(`${item.chatId}:${item.messageId}`);
          });

          setItems((prev) => {
            const next = [...prev, ...mapped]
              .reduce((acc, item) => {
                acc.set(item.id, item);
                return acc;
              }, new Map<string, RequiredChannelNotificationItem>())
              .values();
            return Array.from(next)
              .sort((a, b) => b.createdAtMs - a.createdAtMs)
              .slice(0, 5);
          });

          seedCompletedRef.current = true;

          return;
        } catch (error) {
          if (attempt === 1) {
            console.debug(
              "[required-channel] recent posts seed failed (will retry):",
              (error as { message?: unknown })?.message || error,
            );
          }
          if (seedCompletedRef.current) {
            return;
          }
          if (isAuthNotReadyError(error)) {
            console.debug(
              "[required-channel] recent posts seed paused until auth is ready",
            );
            return;
          }

          if (attempt >= 200) {
            return;
          }
          const delayMs = Math.min(20_000, 1500 + attempt * 800);
          window.setTimeout(() => {
            if (cancelled) return;
            void seedRecentPosts(attempt + 1);
          }, delayMs);
        }
      };

      const maybeSeedRecentPosts = async () => {
        try {
          const authState = await invoke<{ state?: string }>(
            "tg_get_auth_state",
          );
          if (authState?.state === "authorizationStateReady") {
            void seedRecentPosts(1);
          }
        } catch {
          // ignore and wait for auth_state_changed Ready
        }
      };

      void maybeSeedRecentPosts();

      listen<AuthStateChangedEvent>("auth_state_changed", (event) => {
        if (seedCompletedRef.current) {
          return;
        }
        if (event.payload?.stage !== "Ready") {
          return;
        }
        void seedRecentPosts(1);
      })
        .then((fn) => {
          unlistenAuthState = fn;
        })
        .catch(() => {
          // ignore
        });
    }

    listen<RequiredChannelNotificationPayload>(
      REQUIRED_CHANNEL_NOTIFICATION_EVENT_NAME,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        if (
          typeof payload.chat_id !== "number" ||
          typeof payload.message_id !== "number"
        ) {
          return;
        }
        if (chatId && payload.chat_id !== chatId) {
          return;
        }

        const createdAtMsRaw =
          payload.created_at_ms ?? payload.timestamp ?? Date.now();
        const createdAtMs =
          typeof createdAtMsRaw === "number" && Number.isFinite(createdAtMsRaw)
            ? createdAtMsRaw
            : Date.now();

        const id = `${payload.chat_id}:${payload.message_id}`;
        const text = typeof payload.text === "string" ? payload.text : "";
        const formattedText = payload.formatted_text ?? null;
        const previewImage =
          typeof payload.preview_image === "string"
            ? payload.preview_image
            : typeof payload.preview_image_data_url === "string"
              ? payload.preview_image_data_url
              : null;
        const contentType =
          typeof payload.content_type === "string"
            ? payload.content_type
            : null;
        const nextItem = buildNotificationItem({
          id,
          chatId: payload.chat_id,
          messageId: payload.message_id,
          text,
          formattedText,
          previewImage,
          contentType,
          createdAtMs,
        });

        if (!nextItem) {
          return;
        }

        setItems((prev) => {
          const next = [nextItem, ...prev.filter((item) => item.id !== id)];
          return next.slice(0, 5);
        });

        // Best-effort OS notification.
        // Avoid spamming during initial catch-up by only notifying for fresh events.
        if (
          osNotificationsEnabledRef.current &&
          (!document.hasFocus() || document.visibilityState !== "visible")
        ) {
          const ageMs = Math.abs(Date.now() - createdAtMs);
          if (ageMs <= 60_000) {
            const key = `${payload.chat_id}:${payload.message_id}`;
            if (!notifiedMessageIds.has(key)) {
              notifiedMessageIds.add(key);
              const fullText =
                typeof payload.text === "string" && payload.text.trim()
                  ? payload.text
                  : typeof payload.formatted_text?.text === "string"
                    ? payload.formatted_text.text
                    : "";

              const parts = splitNotificationTitleAndBody(fullText);
              const fallbackTitle =
                typeof channelTitle === "string" && channelTitle.trim()
                  ? channelTitle.trim()
                  : "New post";
              const titleRaw = parts.title || fallbackTitle;
              const bodyRaw = parts.body;

              const title = normalizeNotificationText(titleRaw);
              const body = bodyRaw ? bodyRaw.trim() : "";

              const titleFinal =
                title.length > 80 ? `${title.slice(0, 77)}...` : title;
              const bodyFinal =
                body && body.length > 220 ? `${body.slice(0, 217)}...` : body;

              void showOsNotification({
                title: titleFinal,
                body: bodyFinal || undefined,
              });
            }
          }
        }
      },
    )
      .then((fn) => {
        unlistenAdded = fn;
      })
      .catch(() => {
        // ignore
      });

    listen<RequiredChannelNotificationDeletedPayload>(
      REQUIRED_CHANNEL_NOTIFICATION_DELETED_EVENT_NAME,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        if (
          typeof payload.chat_id !== "number" ||
          !Array.isArray(payload.message_ids)
        ) {
          return;
        }
        if (chatId && payload.chat_id !== chatId) {
          return;
        }

        const deleted = new Set(
          payload.message_ids
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0),
        );
        if (!deleted.size) return;

        setItems((prev) =>
          prev.filter(
            (item) =>
              item.chatId !== payload.chat_id || !deleted.has(item.messageId),
          ),
        );
      },
    )
      .then((fn) => {
        unlistenDeleted = fn;
      })
      .catch(() => {
        // ignore
      });

    listen<RequiredChannelNotificationUpdatedPayload>(
      REQUIRED_CHANNEL_NOTIFICATION_UPDATED_EVENT_NAME,
      (event) => {
        const payload = event.payload;
        if (!payload) return;
        if (
          typeof payload.chat_id !== "number" ||
          typeof payload.message_id !== "number"
        ) {
          return;
        }
        if (chatId && payload.chat_id !== chatId) {
          return;
        }

        const previewImage =
          typeof payload.preview_image === "string"
            ? payload.preview_image
            : null;
        if (!previewImage) return;

        const id = `${payload.chat_id}:${payload.message_id}`;
        setItems((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  previewImage,
                }
              : item,
          ),
        );
      },
    )
      .then((fn) => {
        unlistenUpdated = fn;
      })
      .catch(() => {
        // ignore
      });

    return () => {
      window.removeEventListener(
        "skybox-notification-setting-changed",
        onSettingChanged,
      );
      cancelled = true;
      if (unlistenAdded) unlistenAdded();
      if (unlistenDeleted) unlistenDeleted();
      if (unlistenUpdated) unlistenUpdated();
      if (unlistenAuthState) unlistenAuthState();
    };
  }, [chatId, channelTitle]);

  const unreadCount = useMemo(() => {
    if (!items.length) return 0;
    return items.reduce((count, item) => {
      if (item.createdAtMs > lastOpenedAtMs) return count + 1;
      return count;
    }, 0);
  }, [items, lastOpenedAtMs]);

  const markAllRead = useCallback(() => {
    setLastOpenedAtMs(Date.now());
  }, []);

  return {
    notifications: items,
    unreadCount,
    markAllRead,
  };
}
