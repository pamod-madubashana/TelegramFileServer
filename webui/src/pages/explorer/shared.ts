import type { FileItem } from "@/components/skybox/FileRow";
import type { SavedMediaKind } from "@/components/skybox/SavedMediaViewer";
import { resolveThumbnailSrc } from "@/lib/thumbnail-src";

export interface FsError {
  message: string;
}

export interface DbError {
  message: string;
}

export interface TelegramError {
  message: string;
}

export interface TgUpdateEventPayload {
  has_new_messages?: boolean;
  reason: string;
  chat_id?: number | null;
  message_id?: number | null;
  message_ids?: number[] | null;
  folder_kind?: string | null;
  old_message_id?: number | null;
  new_message_id?: number | null;
  timestamp?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size?: number;
  modified_at?: string;
  extension?: string;
}

export interface RecentPath {
  id: number;
  path: string;
  last_opened: string;
}

export interface Favorite {
  id: number;
  path: string;
  label: string;
}

export interface TelegramAuthResult {
  authorized: boolean;
  session_data?: string;
  user_info?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
    profile_photo?: string;
  };
  requires_password: boolean;
  code_delivery?: unknown;
}

export interface UserInfo {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  profile_photo?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat_id: number;
  category: string;
  filename?: string;
  extension?: string;
  mime_type?: string;
  timestamp: string;
  size?: number;
  text?: string;
  thumbnail?: string;
  file_reference: string;
}

export interface TelegramSavedItem {
  chat_id: number;
  message_id: number;
  thumbnail?: string;
  file_type: string;
  file_unique_id: string;
  file_size: number;
  file_name: string;
  file_caption?: string;
  file_path: string;
  modified_date: string;
  owner_id: string;
}

export interface TelegramSavedItemsPage {
  items: TelegramSavedItem[];
  has_more: boolean;
  next_offset: number;
}

export interface TelegramChatDriveItem {
  chat_id: number;
  message_id: number;
  media_kind: string;
  content_type: string;
  file_name: string;
  file_size?: number | null;
  file_extension?: string | null;
  mime_type?: string | null;
  caption?: string | null;
  modified_at: string;
  thumbnail?: string | null;
}

export interface TelegramChatDriveItemsPage {
  items: TelegramChatDriveItem[];
  has_more: boolean;
  next_offset: number;
}

export type TelegramChatSummaryDto = {
  id: number;
  title: string;
  kind: string;
  profile_photo?: string | null;
};

export const STORAGE_KEY_CHAT_DRIVE = "skybox_chat_drive_v1";
export const STORAGE_KEY_CHAT_DRIVES = "skybox_chat_drives_v1";
export const SKYBOX_HIDDEN_FILE_NAMES = new Set(["skybox.json"]);

export interface TelegramIndexSavedMessagesResult {
  total_new_messages: number;
  started_from_empty_db?: boolean;
  saved_messages_chat_id?: number | null;
  historical_sync_complete?: boolean;
  indexed_count?: number;
  last_error?: string | null;
  /** Newest message id the backend could read (0 = chat empty/unreadable). */
  latest_message_id?: number;
  /** Human-readable reason indexing could not proceed, if any. */
  notice?: string | null;
  /**
   * The request attached to an index run that was already in flight (e.g. a
   * page refresh mid-backfill). Normal — never render this as an error.
   */
  already_running?: boolean;
}

export type SyncStateDto =
  | "Idle"
  | "Syncing"
  | "UpToDate"
  | { Error: { message: string } };

export interface SyncSnapshotDto {
  account_id: string;
  state: SyncStateDto;
  indexed_count?: number | null;
  progress_percent?: number | null;
}

export type DownloadStage =
  | "selecting"
  | "downloading"
  | "moving"
  | "completed"
  | "failed"
  | "cancelled";

export type UploadStage =
  | "preparing"
  | "uploading"
  | "sending"
  | "completed"
  | "failed"
  | "cancelled";

export type UploadQueueStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "sending"
  | "indexing"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadProgressPayload {
  sourcePath: string;
  fileName: string;
  stage: DownloadStage;
  progress: number;
  downloadedBytes: number;
  bytesPerSecond?: number | null;
  totalBytes?: number | null;
  destinationPath?: string | null;
  message?: string | null;
}

export interface UploadProgressPayload {
  uploadId?: string | null;
  fileId?: number | null;
  messageId?: number | null;
  fileName: string;
  stage: UploadStage;
  progress: number;
  uploadedBytes?: number | null;
  bytesPerSecond?: number | null;
  totalBytes?: number | null;
  message?: string | null;
}

export interface UploadProgressState {
  totalFiles: number;
  uploadedFiles: number;
  failedFiles: number;
  cancelledFiles: number;
  activeFileProgress: number;
  activeFileName: string | null;
}

export interface UploadQueueItemState {
  id: string;
  fileName: string;
  status: UploadQueueStatus;
  progress: number;
  message?: string;
  destinationVirtualPath?: string;
}

export interface SelectionBoxState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export interface PasteProgressState {
  fileName: string;
  destinationPath: string;
}

export interface SavedPathCacheEntry {
  items: FileItem[];
  nextOffset: number;
  hasMore: boolean;
  isCompleteSnapshot: boolean;
}

export type ExplorerViewMode = "list" | "grid";
export type ExplorerSortField = "name" | "modified_at";
export type ExplorerSortDirection = "asc" | "desc";
export type ClipboardMode = "copy" | "cut";

export interface ExplorerClipboardItem {
  mode: ClipboardMode;
  items: Array<{
    path: string;
    name: string;
    isDirectory: boolean;
  }>;
}

export interface ExplorerContextMenuState {
  x: number;
  y: number;
  targetFile: FileItem | null;
  isEmptyArea: boolean;
}

export interface ExplorerTab {
  id: string;
  path: string;
  title: string;
}

export interface ExplorerTabSnapshot {
  currentPath: string;
  backHistory: string[];
  forwardHistory: string[];
  files: FileItem[];
  savedItemsOffset: number;
  hasMoreSavedItems: boolean;
  selectedPaths: string[];
  selectedFile: FileItem | null;
  search: string;
  scrollTop: number;
}

export const INTERNAL_DRAG_MIME = "application/x-skybox-item-path";
export const INTERNAL_DRAG_MIME_LIST = "application/x-skybox-item-paths";
export const SAVED_ITEMS_PAGE_SIZE = 50;
export const EXPLORER_VIEW_MODE_KEY = "explorer_view_mode";
export const DEFAULT_EXPLORER_HOME_PATH = "tg://saved";
export const DEFAULT_EXPLORER_RECENTS_LIMIT = 25;
export const GALLERY_VIRTUAL_PATH = "tg://saved/Gallery";
export const RECYCLE_BIN_VIRTUAL_PATH = "tg://saved/Recycle Bin";
export const NOTES_VIRTUAL_PATH = "tg://saved/Notes";
const SAVED_PROTECTED_FOLDER_PATHS = new Set([
  "tg://saved/Images",
  "tg://saved/Videos",
  "tg://saved/Audio",
  "tg://saved/Audios",
  "tg://saved/Documents",
  NOTES_VIRTUAL_PATH,
]);
export const DETAILS_PANEL_ANIMATION_MS = 220;
export const UPLOAD_PROGRESS_ANIMATION_MS = 240;
export const TRANSFER_SPEED_UPDATE_INTERVAL_MS = 500;
export const TRANSFER_SPEED_STALE_MS = 1500;
export const UPLOAD_CANCELLED_MARKER = "__SKYBOX_UPLOAD_CANCELLED__";

export const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
]);

export const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mkv",
  "mov",
  "avi",
  "webm",
  "wmv",
  "m4v",
]);

export const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "m4a",
  "opus",
  "wma",
]);

export const createExplorerTabId = (): string => {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const getExplorerTabTitle = (path: string): string => {
  if (!path) {
    return "Tab";
  }

  if (path.startsWith("tg://saved")) {
    const relative = path.replace(/^tg:\/\/saved\/?/, "");
    if (!relative) {
      return "Home";
    }
    const parts = relative.split("/").filter(Boolean);
    return parts[parts.length - 1] || "Saved";
  }

  if (path.startsWith("tg://drive/")) {
    const chatId = parseDriveChatIdFromPath(path);
    if (!chatId) return "Chat";
    try {
      const storage =
        typeof window !== "undefined" ? window.localStorage : null;
      const listRaw = storage ? storage.getItem(STORAGE_KEY_CHAT_DRIVES) : null;
      if (listRaw) {
        const parsed = JSON.parse(listRaw) as unknown;
        if (Array.isArray(parsed)) {
          const match = parsed
            .map((item) => item as { id?: unknown; title?: unknown } | null)
            .find((item) => Number(item?.id) === chatId);
          const title = match?.title;
          if (typeof title === "string" && title.trim()) {
            return title.trim();
          }
        }
      }

      const legacyRaw = storage
        ? storage.getItem(STORAGE_KEY_CHAT_DRIVE)
        : null;
      if (legacyRaw) {
        const parsed = JSON.parse(legacyRaw) as unknown;
        const storedId = Number((parsed as { id?: unknown } | null)?.id);
        const storedTitle = (parsed as { title?: unknown } | null)?.title;
        if (
          storedId === chatId &&
          typeof storedTitle === "string" &&
          storedTitle.trim()
        ) {
          return storedTitle.trim();
        }
      }
    } catch {
      // ignore
    }
    return `Chat ${chatId}`;
  }

  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
};

export const convertFileEntryToFileItem = (entry: FileEntry): FileItem => {
  return {
    name: entry.name,
    path: entry.path,
    isDirectory: entry.is_directory,
    size: entry.size,
    modifiedAt: entry.modified_at,
    extension: entry.extension,
  };
};

export const getDownloadStageLabel = (stage: DownloadStage): string => {
  switch (stage) {
    case "selecting":
      return "Waiting for save location";
    case "downloading":
      return "Downloading";
    case "moving":
      return "Saving file";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Downloading";
  }
};

export const getUploadQueueStatusLabel = (
  status: UploadQueueStatus,
): string => {
  switch (status) {
    case "queued":
      return "Queued";
    case "preparing":
      return "Preparing";
    case "uploading":
      return "Uploading";
    case "sending":
      return "Sending";
    case "indexing":
      return "Indexing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Queued";
  }
};

export const isUploadQueueItemInProgress = (
  status: UploadQueueStatus,
): boolean =>
  status === "preparing" ||
  status === "uploading" ||
  status === "sending" ||
  status === "indexing";

export const formatTransferSpeed = (bytesPerSecond: number): string => {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "0 B/s";
  }

  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

export const isVirtualPath = (path: string): boolean =>
  path.startsWith("tg://");

export const isSavedVirtualFolderPath = (path: string): boolean =>
  path === "tg://saved" || path.startsWith("tg://saved/");

export const isSavedVirtualFilePath = (path: string): boolean =>
  path.startsWith("tg://msg/");

export const isDriveVirtualFolderPath = (path: string): boolean =>
  path.startsWith("tg://drive/");

export const isDriveVirtualFilePath = (path: string): boolean =>
  path.startsWith("tg://drive-msg/");

export const isSavedVirtualItemPath = (path: string): boolean =>
  isSavedVirtualFolderPath(path) || isSavedVirtualFilePath(path);

export const parseDriveChatIdFromPath = (path: string): number | null => {
  const raw = path.trim();
  const rest = raw.startsWith("tg://drive/")
    ? raw.slice("tg://drive/".length)
    : "";
  const chatId = Number(rest.replace(/\/+$/, ""));
  return Number.isSafeInteger(chatId) && chatId !== 0 ? chatId : null;
};

export const isRecycleBinPath = (path: string): boolean =>
  path === RECYCLE_BIN_VIRTUAL_PATH ||
  path.startsWith(`${RECYCLE_BIN_VIRTUAL_PATH}/`);

export const isGalleryPath = (path: string): boolean =>
  path === GALLERY_VIRTUAL_PATH || path.startsWith(`${GALLERY_VIRTUAL_PATH}/`);

export const isNotesVirtualPath = (path: string): boolean =>
  path === NOTES_VIRTUAL_PATH || path.startsWith(`${NOTES_VIRTUAL_PATH}/`);

export const isProtectedSavedFolderPath = (path: string): boolean =>
  SAVED_PROTECTED_FOLDER_PATHS.has(path);

export const normalizePath = (path: string): string => path.replace(/\\/g, "/");

export const getSavedMediaKind = (file: FileItem): SavedMediaKind | null => {
  if (file.isDirectory || !isSavedVirtualFilePath(file.path)) {
    return null;
  }

  const extension = (
    file.extension ||
    extensionFromFileName(file.name) ||
    ""
  ).toLowerCase();

  if (extension) {
    if (IMAGE_EXTENSIONS.has(extension)) {
      return "image";
    }

    if (VIDEO_EXTENSIONS.has(extension)) {
      return "video";
    }

    if (AUDIO_EXTENSIONS.has(extension)) {
      return "audio";
    }
  }

  // Telegram delivers voice notes and round videos with no filename at all,
  // so there is no extension to read. The server already classified the
  // message — trust that before giving up and forcing a download.
  switch (file.fileType) {
    case "photo":
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "voice":
      return "audio";
    default:
      return null;
  }
};

export const isSavedPreviewableFile = (file: FileItem): boolean =>
  getSavedMediaKind(file) !== null;

export const getPathName = (path: string): string => {
  const normalized = normalizePath(path).replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
};

export const isHiddenExplorerFileName = (name?: string | null): boolean => {
  const normalized = (name || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return SKYBOX_HIDDEN_FILE_NAMES.has(normalized);
};

export const getParentPath = (path: string): string => {
  const normalized = normalizePath(path).replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "";
  }

  return normalized.slice(0, index);
};

export const joinPath = (base: string, name: string): string => {
  const normalizedBase = normalizePath(base).replace(/\/+$/, "");
  if (!normalizedBase) {
    return name;
  }

  return `${normalizedBase}/${name}`;
};

export const isTextInputElement = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;
  return (
    target.isContentEditable ||
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT"
  );
};

export const extensionFromFileName = (fileName: string): string | undefined => {
  const parts = fileName.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  return parts[parts.length - 1]?.toLowerCase();
};

export const buildNoteDisplayText = (rawText?: string | null): string => {
  const normalized = (rawText || "").trim();
  if (!normalized) {
    return "(empty message)";
  }

  return normalized;
};

export const virtualToSavedPath = (virtualPath: string): string => {
  if (virtualPath === "tg://saved") {
    return "/Home";
  }

  const relativePath = virtualPath
    .replace(/^tg:\/\/saved\/?/, "")
    .replace(/\/+$/, "");
  return relativePath ? `/Home/${relativePath}` : "/Home";
};

export const savedToVirtualPath = (savedPath: string): string => {
  const normalized = normalizePath(savedPath).replace(/\/+$/, "");
  if (normalized === "/Home") {
    return "tg://saved";
  }

  if (normalized.startsWith("/Home/")) {
    return `tg://saved/${normalized.slice(6)}`;
  }

  return "tg://saved";
};

export const savedItemToFileItem = (item: TelegramSavedItem): FileItem => {
  const parentVirtualPath = savedToVirtualPath(item.file_path);
  const isInsideNotesFolder =
    parentVirtualPath === NOTES_VIRTUAL_PATH ||
    parentVirtualPath.startsWith(`${NOTES_VIRTUAL_PATH}/`);
  const isTextMessage = item.file_type === "text" || isInsideNotesFolder;
  const noteText = isTextMessage
    ? buildNoteDisplayText(item.file_caption)
    : undefined;
  const caption = !isTextMessage ? (item.file_caption || "").trim() : undefined;
  const resolvedName = item.file_name?.trim()
    ? item.file_name
    : ["image", "video", "audio"].includes(item.file_type)
      ? `${item.file_type}_${item.file_unique_id}`
      : `message_${item.message_id || item.file_unique_id}`;

  const displayName = isTextMessage ? noteText || resolvedName : resolvedName;

  const isDirectory = item.file_type === "folder";
  if (isDirectory) {
    const folderPath = savedToVirtualPath(
      joinPath(item.file_path, resolvedName),
    );
    return {
      name: resolvedName,
      path: folderPath,
      isDirectory: true,
      modifiedAt: item.modified_date,
    };
  }

  return {
    name: displayName,
    path: `tg://msg/${item.message_id}`,
    isDirectory: false,
    size: item.file_size,
    modifiedAt: item.modified_date,
    extension: isTextMessage ? undefined : extensionFromFileName(resolvedName),
    fileType: item.file_type,
    messageId: item.message_id > 0 ? item.message_id : undefined,
    thumbnail: resolveThumbnailSrc(item.thumbnail),
    caption: caption || undefined,
    noteText,
    isNoteMessage: isTextMessage,
  };
};

export const telegramMessageToFileItem = (
  message: TelegramMessage,
): FileItem => {
  const isNoteMessage = message.category === "Notes";
  const noteText = isNoteMessage
    ? buildNoteDisplayText(message.text)
    : undefined;
  const caption = !isNoteMessage ? (message.text || "").trim() : undefined;
  const fallbackName = message.extension
    ? `message_${message.message_id}.${message.extension}`
    : `message_${message.message_id}`;
  const resolvedName = message.filename?.trim()
    ? message.filename
    : fallbackName;
  const displayName = isNoteMessage ? noteText || resolvedName : resolvedName;

  return {
    name: displayName,
    path: `tg://msg/${message.message_id}`,
    isDirectory: false,
    size: typeof message.size === "number" ? message.size : undefined,
    modifiedAt: message.timestamp,
    extension: isNoteMessage
      ? undefined
      : message.extension || extensionFromFileName(resolvedName),
    messageId: message.message_id > 0 ? message.message_id : undefined,
    thumbnail: resolveThumbnailSrc(message.thumbnail),
    caption: caption || undefined,
    noteText,
    isNoteMessage,
  };
};

export const driveItemToFileItem = (item: TelegramChatDriveItem): FileItem => {
  const resolvedName =
    (item.file_name || "").trim() || `message_${item.message_id}`;
  const extension =
    typeof item.file_extension === "string" && item.file_extension.trim()
      ? item.file_extension.trim()
      : extensionFromFileName(resolvedName);

  const path = `tg://drive-msg/${item.chat_id}/${item.message_id}`;

  return {
    name: resolvedName,
    path,
    isDirectory: false,
    size: typeof item.file_size === "number" ? item.file_size : undefined,
    modifiedAt: item.modified_at,
    extension: extension || undefined,
    messageId: item.message_id > 0 ? item.message_id : undefined,
    chatId:
      Number.isSafeInteger(item.chat_id) && item.chat_id !== 0
        ? item.chat_id
        : undefined,
    thumbnail: resolveThumbnailSrc(item.thumbnail || undefined),
    caption: (item.caption || "").trim() || undefined,
  };
};

export const mergeFileItemsByIdentity = (
  existingItems: FileItem[],
  newItems: FileItem[],
): FileItem[] => {
  if (!newItems.length) {
    return existingItems;
  }

  const existingPaths = new Set(existingItems.map((item) => item.path));
  const existingMessageIds = new Set(
    existingItems
      .map((item) => item.messageId)
      .filter((id): id is number => !!id && id > 0),
  );

  const merged = [...existingItems];
  for (const item of newItems) {
    if (existingPaths.has(item.path)) {
      continue;
    }

    if (item.messageId && existingMessageIds.has(item.messageId)) {
      continue;
    }

    merged.push(item);
    existingPaths.add(item.path);
    if (item.messageId) {
      existingMessageIds.add(item.messageId);
    }
  }

  return merged;
};

export function estimateSyncPercentFromIndexedCount(count: number): number {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount <= 0) {
    return 0;
  }

  const estimated = Math.round((1 - Math.exp(-safeCount / 2500)) * 99);
  return Math.min(99, Math.max(1, estimated));
}
