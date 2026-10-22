export type UnlistenFn = () => void;

interface InvokeOptions {
  cmd: string;
  args?: Record<string, unknown>;
}

const SAVED_ROOT = "/Home";

function authToken(): string | null {
  return localStorage.getItem("tfs_token");
}

const AUTH_FLOW_PATHS = new Set(["/", "/login", "/setup"]);
let redirectingToLogin = false;

/**
 * A 401 on a protected endpoint means the session is dead (backend restarted
 * or token expired). Clear it and land on /login instead of leaving a blank
 * page with only console errors. Skips auth/setup/bootstrap paths.
 */
function handleAuthFailure(): void {
  if (redirectingToLogin || typeof window === "undefined") {
    return;
  }
  const path = window.location.pathname;
  if (AUTH_FLOW_PATHS.has(path) || path.startsWith("/login")) {
    return;
  }
  redirectingToLogin = true;
  localStorage.removeItem("tfs_token");
  window.location.assign("/login");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = authToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/")) {
      handleAuthFailure();
    }
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData && typeof errorData.error === "string") {
        errorMessage = errorData.error;
      }
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(errorMessage);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

function logToServer(level: string, message: string): void {
  fetch("/api/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, message }),
  }).catch(() => {
    // Silently ignore logging failures
  });
}

/** `tg://saved/X` → `/Home/X`; a `/Home/...` path passes through. */
function toSavedPath(path: string): string {
  if (path.startsWith("tg://saved/")) {
    const rest = path.slice("tg://saved/".length);
    return rest ? `${SAVED_ROOT}/${rest}` : SAVED_ROOT;
  }
  return path;
}

type ItemRef = { path: string } | { message_id: number };

/** Item paths are `tg://msg/{id}` for files, `/Home/...` (or `tg://saved/…`) for folders. */
function toItemRef(path: string): ItemRef {
  const match = /^tg:\/\/msg\/(\d+)$/.exec(path);
  if (match) {
    return { message_id: Number(match[1]) };
  }
  return { path: toSavedPath(path) };
}

function messageIdFromPath(path: string): number {
  const match = /^tg:\/\/msg\/(\d+)$/.exec(path);
  if (!match) {
    throw new Error(`unsupported media path: ${path}`);
  }
  return Number(match[1]);
}

/** `tg://drive-msg/<chat>/<msg>` → both ids, or null for any other path. */
function parseDriveMsgPath(path: string): { chatId: number; messageId: number } | null {
  const match = /^tg:\/\/drive-msg\/(-?\d+)\/(\d+)$/.exec(path.trim());
  if (!match) {
    return null;
  }
  const chatId = Number(match[1]);
  const messageId = Number(match[2]);
  if (!Number.isFinite(chatId) || chatId === 0 || !Number.isFinite(messageId) || messageId <= 0) {
    return null;
  }
  return { chatId, messageId };
}

/** `tg://drive/<chat>` (a drive folder root) → chat id, or null. */
function parseDriveChatPath(path: string): number | null {
  const match = /^tg:\/\/drive\/(-?\d+)$/.exec(path.trim());
  if (!match) {
    return null;
  }
  const chatId = Number(match[1]);
  return Number.isFinite(chatId) && chatId !== 0 ? chatId : null;
}

/**
 * Streaming/preview URL for `/api/fs/media`, token in the query for
 * `<video>`/`<img>`. With a `chatId`, the live drive endpoint (keyed on
 * chat+message, no Mongo row needed) is used instead.
 */
function mediaUrl(messageId: number, inline: boolean, chatId?: number | null): string {
  const base = chatId
    ? `/api/fs/drive/media?chat_id=${chatId}&message_id=${messageId}&inline=${inline}`
    : `/api/fs/media?message_id=${messageId}&inline=${inline}`;
  const token = authToken();
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

/**
 * Thumbnail URL for one message, in the requested quality tier.
 *
 * `low` is the cheap preview the server bundles with a listing; `high` is the
 * largest it will serve. The server caches both on disk, so the same URL is
 * safe to hand out again on every reload. With a `chatId`, previews come from
 * the live drive endpoint instead of the Mongo-keyed one.
 */
function thumbnailUrl(
  messageId: number,
  quality: "low" | "high",
  chatId?: number | null,
): string {
  const base = chatId
    ? `/api/fs/drive/thumbnail?chat_id=${chatId}&message_id=${messageId}&quality=${quality}`
    : `/api/fs/thumbnail?message_id=${messageId}&quality=${quality}`;
  const token = authToken();
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

/**
 * Media URL for an item path: `tg://drive-msg/<chat>/<msg>` drives, and
 * `tg://msg/<id>` the Mongo-keyed saved endpoint.
 */
function mediaUrlForPath(path: string, inline: boolean): string {
  const drive = parseDriveMsgPath(path);
  if (drive) {
    return mediaUrl(drive.messageId, inline, drive.chatId);
  }
  return mediaUrl(messageIdFromPath(path), inline);
}

/** Client-originated events ride the same `listen()` bus as SSE, via CustomEvent. */
function emitLocalEvent(event: string, payload: unknown): void {
  window.dispatchEvent(new CustomEvent(event, { detail: payload }));
}

/** `tg_upload_file_to_saved_messages` → multipart POST + progress/indexed events. */
function uploadToSavedMessages(args: Record<string, unknown>): Promise<unknown> {
  const payload = (args?.args ?? args) as Record<string, unknown>;
  const uploadId = String(payload.uploadId ?? "");
  const fileName = String(payload.fileName ?? "upload.bin");
  const rawPath = String(payload.filePath ?? SAVED_ROOT);
  // A `tg://drive/<id>` destination targets that drive's chat; the VFS row
  // still lands at the Saved root, but Telegram receives the file in the
  // drive chat (validated server-side against the caller's drive list).
  const driveChatId = parseDriveChatPath(rawPath);
  const destination = driveChatId ? SAVED_ROOT : toSavedPath(rawPath);
  const bytes = payload.fileBytes;

  if (!Array.isArray(bytes)) {
    return Promise.reject(
      new Error("upload: only in-browser file uploads are supported"),
    );
  }

  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("path", destination);
    if (driveChatId) {
      form.append("chat_id", String(driveChatId));
    }
    form.append("file", new Blob([new Uint8Array(bytes as number[])]), fileName);

    const token = authToken();
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files/upload");
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      emitLocalEvent("tg-upload-progress", {
        uploadId,
        stage: "uploading",
        progress: (event.loaded / event.total) * 100,
        uploadedBytes: event.loaded,
        totalBytes: event.total,
      });
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let message = `HTTP ${xhr.status}`;
        try {
          const data = JSON.parse(xhr.responseText);
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
          // ignore JSON parse errors
        }
        emitLocalEvent("tg-upload-progress", {
          uploadId,
          stage: "failed",
          progress: 0,
          message,
        });
        reject(new Error(message));
        return;
      }

      let summary: { message_id?: number } | null = null;
      try {
        summary = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        // ignore JSON parse errors
      }
      emitLocalEvent("tg-upload-progress", {
        uploadId,
        stage: "completed",
        progress: 100,
      });
      emitLocalEvent("tg-upload-indexed", {
        uploadId,
        messageId: typeof summary?.message_id === "number" ? summary.message_id : 0,
        // Drives keep their `tg://drive/<id>` path so the explorer refreshes
        // that chat's listing; saved uploads report the VFS folder.
        filePath: driveChatId ? rawPath : destination,
      });
      resolve(summary);
    };

    xhr.onerror = () => {
      const message = "network error during upload";
      emitLocalEvent("tg-upload-progress", {
        uploadId,
        stage: "failed",
        progress: 0,
        message,
      });
      reject(new Error(message));
    };

    emitLocalEvent("tg-upload-progress", {
      uploadId,
      stage: "preparing",
      progress: 0,
    });
    xhr.send(form);
  });
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Command to HTTP endpoint mapping
  switch (cmd) {
    case "db_get_setting": {
      const key = args?.key as string;
      if (!key) throw new Error("db_get_setting: missing key");
      try {
        return await fetchJson<T>(`/api/settings/${encodeURIComponent(key)}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("HTTP 404")) {
          return null as T;
        }
        throw e;
      }
    }

    case "db_set_setting": {
      const key = args?.key as string;
      const value = args?.value;
      if (!key) throw new Error("db_set_setting: missing key");
      await fetchJson(`/api/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify(value),
      });
      return undefined as T;
    }

    case "db_get_favorites": {
      return await fetchJson<T>("/api/favorites");
    }

    case "db_add_favorite": {
      const path = args?.path as string;
      const label = args?.label as string;
      if (!path) throw new Error("db_add_favorite: missing path");
      await fetchJson("/api/favorites", {
        method: "POST",
        body: JSON.stringify({ path, label }),
      });
      return undefined as T;
    }

    case "db_remove_favorite": {
      const id = args?.id as string | number;
      if (id === undefined) throw new Error("db_remove_favorite: missing id");
      await fetchJson(`/api/favorites/${encodeURIComponent(String(id))}`, {
        method: "DELETE",
      });
      return undefined as T;
    }

    case "db_get_recent_paths": {
      const limit = args?.limit as number | undefined;
      const url = limit ? `/api/recents?limit=${limit}` : "/api/recents";
      return await fetchJson<T>(url);
    }

    case "db_add_recent_path": {
      const path = args?.path as string;
      if (!path) throw new Error("db_add_recent_path: missing path");
      await fetchJson("/api/recents", {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      return undefined as T;
    }

    case "db_get_session": {
      const token = localStorage.getItem("tfs_token");
      if (!token) return null as T;
      try {
        return await fetchJson<T>("/api/auth/me");
      } catch {
        return null as T;
      }
    }

    case "db_clear_session": {
      localStorage.removeItem("tfs_token");
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        // ignore network errors
      }
      return undefined as T;
    }

    case "db_update_session_user_info": {
      // The server derives identity from Telegram at claim time; there is
      // nothing to cache-update.
      return undefined as T;
    }

    case "tg_logout": {
      localStorage.removeItem("tfs_token");
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        // ignore 401/network errors
      }
      return null as T;
    }

    case "tg_get_startup_readiness": {
      return await fetchJson<T>("/api/session/readiness");
    }

    case "tg_get_auth_state": {
      return await fetchJson<T>("/api/session/auth");
    }

    case "tg_list_saved_items_page": {
      const path = toSavedPath(String(args?.filePath ?? SAVED_ROOT));
      const offset = Number(args?.offset ?? 0);
      const limit = Number(args?.limit ?? 0);
      const query = new URLSearchParams({ path, offset: String(offset) });
      if (limit > 0) {
        query.set("limit", String(limit));
      }
      return await fetchJson<T>(`/api/fs/items?${query.toString()}`);
    }

    case "tg_list_saved_items": {
      const path = toSavedPath(String(args?.filePath ?? SAVED_ROOT));
      const page = await fetchJson<{ items: unknown[] }>(
        `/api/fs/items?path=${encodeURIComponent(path)}`,
      );
      return (page.items ?? []) as T;
    }

    case "tg_get_saved_item_by_message_id": {
      const nested = (args?.args ?? args) as Record<string, unknown>;
      const messageId = Number(nested.messageId);
      if (!Number.isFinite(messageId)) {
        throw new Error("tg_get_saved_item_by_message_id: missing messageId");
      }
      return await fetchJson<T>(`/api/fs/items/by-message/${messageId}`);
    }

    case "tg_get_indexed_saved_messages": {
      const category = String(args?.category ?? "");
      if (!category) {
        throw new Error("tg_get_indexed_saved_messages: missing category");
      }
      return await fetchJson<T>(
        `/api/fs/gallery?category=${encodeURIComponent(category)}`,
      );
    }

    case "tg_create_saved_folder": {
      await fetchJson("/api/fs/folders", {
        method: "POST",
        body: JSON.stringify({
          parent_path: toSavedPath(String(args?.parentPath ?? SAVED_ROOT)),
          name: String(args?.folderName ?? ""),
        }),
      });
      return undefined as T;
    }

    case "tg_rename_saved_item": {
      await fetchJson("/api/fs/rename", {
        method: "POST",
        body: JSON.stringify({
          source: toItemRef(String(args?.sourcePath ?? "")),
          new_name: String(args?.newName ?? ""),
        }),
      });
      return undefined as T;
    }

    case "tg_move_saved_item": {
      await fetchJson("/api/fs/move", {
        method: "POST",
        body: JSON.stringify({
          source: toItemRef(String(args?.sourcePath ?? "")),
          destination_path: toSavedPath(String(args?.destinationPath ?? "")),
        }),
      });
      return undefined as T;
    }

    case "tg_copy_saved_item": {
      await fetchJson("/api/fs/copy", {
        method: "POST",
        body: JSON.stringify({
          source: toItemRef(String(args?.sourcePath ?? "")),
          destination_path: toSavedPath(String(args?.destinationPath ?? "")),
        }),
      });
      return undefined as T;
    }

    case "tg_move_saved_item_to_recycle_bin": {
      await fetchJson("/api/fs/recycle", {
        method: "POST",
        body: JSON.stringify({ source: toItemRef(String(args?.sourcePath ?? "")) }),
      });
      return undefined as T;
    }

    case "tg_restore_saved_item": {
      await fetchJson("/api/fs/restore", {
        method: "POST",
        body: JSON.stringify({ source: toItemRef(String(args?.sourcePath ?? "")) }),
      });
      return undefined as T;
    }

    case "tg_delete_saved_item_permanently": {
      await fetchJson("/api/fs/delete", {
        method: "POST",
        body: JSON.stringify({
          items: [toItemRef(String(args?.sourcePath ?? ""))],
          permanent: true,
        }),
      });
      return undefined as T;
    }

    case "tg_delete_saved_items_permanently": {
      const nested = (args?.args ?? args) as Record<string, unknown>;
      const sourcePaths = Array.isArray(nested.sourcePaths)
        ? (nested.sourcePaths as unknown[]).map((p) => toItemRef(String(p)))
        : [];
      await fetchJson("/api/fs/delete", {
        method: "POST",
        body: JSON.stringify({ items: sourcePaths, permanent: true }),
      });
      return undefined as T;
    }

    case "tg_get_message_thumbnail":
    case "tg_get_chat_message_thumbnail": {
      // Hand back the larger tier's URL; the server caches the bytes on disk
      // and the caller swaps it in once the image has actually decoded.
      const nested = (args?.args ?? args) as Record<string, unknown>;
      const messageId = Number(nested.messageId ?? 0);
      const chatId = Number(nested.chatId ?? 0);
      return Number.isFinite(messageId) && messageId > 0
        ? (thumbnailUrl(
            messageId,
            "high",
            Number.isFinite(chatId) && chatId !== 0 ? chatId : null,
          ) as T)
        : (null as T);
    }

    case "tg_prefetch_chat_message_thumbnails": {
      // Same one-answer-up-front contract as the saved-items prefetch, but
      // each URL is keyed on the drive's chat so never-indexed chats work.
      const nested = (args?.args ?? args) as Record<string, unknown>;
      const items = Array.isArray(nested.items) ? (nested.items as unknown[]) : [];
      const thumbnails = items
        .map((raw) => {
          const item = raw as { chatId?: unknown; messageId?: unknown };
          const chatId = Number(item?.chatId ?? 0);
          const messageId = Number(item?.messageId ?? 0);
          if (!Number.isFinite(chatId) || chatId === 0 || !Number.isFinite(messageId) || messageId <= 0) {
            return null;
          }
          return {
            chat_id: chatId,
            message_id: messageId,
            thumbnail: thumbnailUrl(messageId, "low", chatId),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return { thumbnails } as T;
    }

    case "tg_prefetch_message_thumbnails": {
      // One answer for the whole listing: every message gets its cheap
      // preview URL up front, so a cold grid paints without a round trip
      // per tile. The server caches the bytes on disk, so the same URLs are
      // just as valid on the tenth visit as on the first.
      const requested = Array.isArray(args?.messageIds)
        ? (args.messageIds as unknown[]).map(Number)
        : [];
      const messageIds = requested.filter(
        (id) => Number.isFinite(id) && id > 0,
      );
      return {
        thumbnails: messageIds.map((message_id) => ({
          message_id,
          thumbnail: thumbnailUrl(message_id, "low"),
        })),
      } as T;
    }

    case "tg_prepare_saved_media_stream":
    case "tg_prepare_saved_media_preview": {
      return mediaUrlForPath(String(args?.sourcePath ?? ""), true) as T;
    }

    case "tg_download_saved_file": {
      const anchor = document.createElement("a");
      anchor.href = mediaUrlForPath(String(args?.sourcePath ?? ""), false);
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return null as T;
    }

    case "tg_cancel_saved_file_download":
    case "tg_cancel_saved_file_upload": {
      // Browser transfers are not server-tracked; nothing to cancel.
      return false as T;
    }

    case "tg_upload_file_to_saved_messages": {
      return (await uploadToSavedMessages(args ?? {})) as T;
    }

    case "tg_send_saved_note_message":
    case "tg_edit_saved_note_message": {
      throw new Error("Notes are not supported by the server yet");
    }

    case "tg_forward_message": {
      throw new Error("Forwarding is not supported by the server yet");
    }

    case "tg_index_saved_messages": {
      // Kick off (or join) the server-side history indexer. The response is
      // a TelegramIndexSavedMessagesResult; live progress arrives over SSE
      // as `account_sync_changed` / `tg-update-received`.
      const { getAuthToken } = await import("@/lib/auth");
      const token = getAuthToken();
      const response = await fetch("/api/fs/index", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error(`index request failed (HTTP ${response.status})`);
      }
      return (await response.json()) as T;
    }

    case "tg_index_chat_drive":
    case "tg_start_real_time_sync":
    case "tg_cloud_sync_skybox_json_to_saved_messages": {
      // Indexing/sync flows live server-side in Mongo; nothing for the
      // client to trigger.
      return undefined as T;
    }

    case "tg_restore_session": {
      // The server owns the Telegram session; restoring it in-browser is a
      // Tauri-era concept.
      return { authorized: false } as T;
    }

    case "tg_is_premium_user": {
      return false as T;
    }

    case "tg_get_my_profile_photo": {
      return null as T;
    }

    case "tg_search_contacts":
    case "tg_get_recent_chats":
    case "tg_list_group_channel_chats": {
      return [] as T;
    }

    case "tg_list_chat_drive_items_page": {
      // Live drive page: newest-first chat history from Telegram, so a chat
      // needs no Mongo rows to be browsable.
      const nested = (args?.args ?? args) as Record<string, unknown>;
      const chatId = Number(nested.chatId ?? 0);
      const offset = Number(nested.offset ?? 0);
      const limit = Number(nested.limit ?? 0);
      if (!Number.isFinite(chatId) || chatId === 0) {
        throw new Error("chat id is required for drive items");
      }
      const params = new URLSearchParams({ chat_id: String(chatId) });
      if (Number.isFinite(offset) && offset > 0) {
        params.set("offset", String(Math.trunc(offset)));
      }
      if (Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(Math.trunc(limit)));
      }
      return await fetchJson<T>(`/api/fs/drive/items?${params.toString()}`);
    }

    case "folder_settings_bootstrap_many": {
      return [] as T;
    }

    case "folder_settings_save":
    case "folder_settings_reset": {
      throw new Error("Folder settings are not supported by the server yet");
    }

    case "fs_open_path":
    case "fs_list_dir":
    case "fs_create_dir":
    case "fs_delete":
    case "rename_file":
    case "copy_file":
    case "move_file": {
      // Local-filesystem commands belong to the Tauri build; the explorer
      // routes everything through the Mongo VFS instead.
      throw new Error("Local filesystem access is not available in the web app");
    }

    case "tg_feedback_resolve_destination": {
      return {
        available: false,
        reason: "Feedback is not configured on this server.",
      } as T;
    }

    case "tg_feedback_send": {
      return {
        ok: false,
        reason: "Feedback is not configured on this server.",
        errorKind: null,
      } as T;
    }

    case "log_debug": {
      logToServer("debug", args?.message as string);
      return undefined as T;
    }

    case "log_info": {
      logToServer("info", args?.message as string);
      return undefined as T;
    }

    case "log_warn": {
      logToServer("warn", args?.message as string);
      return undefined as T;
    }

    case "log_error": {
      logToServer("error", args?.message as string);
      return undefined as T;
    }

    case "app_get_autostart_enabled": {
      // TODO: implement when backend supports it
      return false as T;
    }

    case "app_set_autostart_enabled": {
      // TODO: implement when backend supports it
      return false as T;
    }

    case "app_show_os_notification": {
      // Browser notifications are opt-in per origin; not wired yet.
      return undefined as T;
    }

    case "tg_get_tdlib_version": {
      return "" as T;
    }

    default: {
      console.warn("[ipc] unhandled command", cmd);
      return null as T;
    }
  }
}

export function convertFileSrc(path: string): string {
  // v1: return path unchanged; thumbnails resolve through /api/fs/media.
  return path;
}
