import { convertFileSrc } from "@tauri-apps/api/core";

import { getAuthToken } from "@/lib/auth";

const URL_PREFIXES = [
  "data:",
  "http://",
  "https://",
  "asset://",
  "tauri://",
  "asset:",
  "blob:",
  "file://",
];

const WINDOWS_PATH_REGEX = /^[a-zA-Z]:[\\/]/;

/**
 * An `<img>` cannot set an `Authorization` header, so every server-relative
 * preview URL carries the session token in the query - the same trick the
 * media routes already use for `<video src>` and `<a download>`.
 */
const withSessionToken = (url: string): string => {
  if (url.includes("token=")) {
    return url;
  }
  const token = getAuthToken();
  return token ? `${url}&token=${encodeURIComponent(token)}` : url;
};

export const resolveThumbnailSrc = (
  thumbnail?: string | null,
): string | undefined => {
  if (!thumbnail) {
    return undefined;
  }

  const value = thumbnail.trim();
  if (!value) {
    return undefined;
  }

  if (URL_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return value;
  }

  // Server-relative URLs (/api/fs/media?…) need no conversion.
  if (value.startsWith("/")) {
    return withSessionToken(value);
  }

  const normalizedPath = value.replace(/\\/g, "/");
  const candidates = Array.from(new Set([value, normalizedPath]));

  for (const candidate of candidates) {
    try {
      const converted = convertFileSrc(candidate);
      if (
        converted &&
        converted !== candidate &&
        !WINDOWS_PATH_REGEX.test(converted)
      ) {
        return converted;
      }
    } catch {
      // ignore
    }
  }

  return undefined;
};
