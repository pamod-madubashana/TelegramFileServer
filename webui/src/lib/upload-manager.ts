import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  UploadConfirmDraft,
  UploadDraftEntry,
} from "@/components/skybox/UploadConfirmWidget";

export type UploadTaskState =
  | "QUEUED"
  | "PREPARING"
  | "UPLOADING"
  | "SENDING"
  | "INDEXING"
  | "COMPLETED"
  | "FAILED_RETRYABLE"
  | "FAILED_FATAL"
  | "CANCELLED";

export type UploadQueueStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "sending"
  | "indexing"
  | "completed"
  | "failed"
  | "cancelled";

/** States a task cannot leave; anything still in progress may advance to them. */
const isFinishedUploadState = (state: UploadTaskState): boolean =>
  state === "COMPLETED" || state === "CANCELLED";

export type UploadQueueItemView = {
  id: string;
  uploadId: string;
  fileName: string;
  relativePath: string;
  destinationVirtualPath: string;
  status: UploadQueueStatus;
  progress: number;
  message?: string;
  fileId?: number;
  messageId?: number;
};

export type UploadProgressView = {
  totalFiles: number;
  uploadedFiles: number;
  failedFiles: number;
  cancelledFiles: number;
  activeFileProgress: number;
  activeFileName: string | null;
};

export type UploadManagerSnapshot = {
  isUploading: boolean;
  activeTargetVirtualPath: string | null;
  activePlaceholderVirtualPath: string | null;
  items: UploadQueueItemView[];
  progress: UploadProgressView | null;
};

type TgUploadProgressPayload = {
  uploadId?: string | null;
  fileId?: number | null;
  messageId?: number | null;
  fileName?: string | null;
  stage:
    | "preparing"
    | "uploading"
    | "sending"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number;
  uploadedBytes?: number | null;
  totalBytes?: number | null;
  message?: string | null;
};

type TgUploadIndexedPayload = {
  uploadId: string;
  fileId?: number | null;
  messageId: number;
  filePath: string;
};

type UploadTask = {
  uploadId: string;
  entry: UploadDraftEntry;
  fileName: string;
  relativePath: string;
  destinationDbPath: string;
  caption: string | null;
  options: UploadConfirmDraft["options"];
  attempt: number;
  state: UploadTaskState;
  progressPercent: number;
  message?: string;
  fileId?: number;
  messageId?: number;
  cancelRequested: boolean;
};

type UploadManagerOptions = {
  concurrency?: number;
  uploadRetryCount?: number;
  indexingTimeoutMs?: number;
  virtualToSavedPath: (virtualPath: string) => string;
  savedToVirtualPath: (savedPath: string) => string;
  isRecycleBinVirtualPath: (virtualPath: string) => boolean;
};

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_INDEXING_TIMEOUT_MS = 15 * 60 * 1000;

const normalizeRelPath = (value: string): string => {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
};

const joinSavedDbPath = (parent: string, child: string): string => {
  const left = parent.replace(/\\/g, "/").replace(/\/+$/, "");
  const right = child.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!right) return left || "/Home";
  if (!left) return `/${right}`;
  return `${left}/${right}`.replace(/\/+/g, "/");
};

const createUploadId = (): string => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const isRetryableErrorMessage = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("network") ||
    normalized.includes("connection") ||
    normalized.includes("tempor") ||
    normalized.includes("flood") ||
    normalized.includes("429")
  );
};

export class UploadManager {
  private readonly virtualToSavedPath: UploadManagerOptions["virtualToSavedPath"];
  private readonly savedToVirtualPath: UploadManagerOptions["savedToVirtualPath"];
  private readonly isRecycleBinVirtualPath: UploadManagerOptions["isRecycleBinVirtualPath"];

  private readonly concurrency: number;
  private readonly uploadRetryCount: number;
  private readonly indexingTimeoutMs: number;

  private tasks: UploadTask[] = [];
  private tasksByUploadId = new Map<string, UploadTask>();
  private fileIdToUploadId = new Map<number, string>();

  private targetVirtualPath: string | null = null;
  private placeholderVirtualPath: string | null = null;

  private activeWorkers = 0;
  private isRunning = false;

  private progress: UploadProgressView | null = null;

  private subscribers = new Set<(snapshot: UploadManagerSnapshot) => void>();
  private unlistenProgress: UnlistenFn | null = null;
  private unlistenIndexed: UnlistenFn | null = null;

  private indexingTimers = new Map<string, number>();

  constructor(options: UploadManagerOptions) {
    this.virtualToSavedPath = options.virtualToSavedPath;
    this.savedToVirtualPath = options.savedToVirtualPath;
    this.isRecycleBinVirtualPath = options.isRecycleBinVirtualPath;

    this.concurrency = Math.max(
      1,
      Math.min(4, options.concurrency ?? DEFAULT_CONCURRENCY),
    );
    this.uploadRetryCount = Math.max(
      0,
      Math.min(5, options.uploadRetryCount ?? DEFAULT_RETRY_COUNT),
    );
    this.indexingTimeoutMs = Math.max(
      5_000,
      options.indexingTimeoutMs ?? DEFAULT_INDEXING_TIMEOUT_MS,
    );
  }

  async init(): Promise<void> {
    if (this.unlistenProgress || this.unlistenIndexed) {
      return;
    }

    this.unlistenProgress = await listen<TgUploadProgressPayload>(
      "tg-upload-progress",
      (event) => {
        this.handleProgressEvent(event.payload);
      },
    );

    this.unlistenIndexed = await listen<TgUploadIndexedPayload>(
      "tg-upload-indexed",
      (event) => {
        this.handleIndexedEvent(event.payload);
      },
    );
  }

  dispose(): void {
    for (const timer of this.indexingTimers.values()) {
      window.clearTimeout(timer);
    }
    this.indexingTimers.clear();

    if (this.unlistenProgress) {
      this.unlistenProgress();
      this.unlistenProgress = null;
    }
    if (this.unlistenIndexed) {
      this.unlistenIndexed();
      this.unlistenIndexed = null;
    }
    this.subscribers.clear();
  }

  subscribe(listener: (snapshot: UploadManagerSnapshot) => void): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot());
    return () => {
      this.subscribers.delete(listener);
    };
  }

  snapshot(): UploadManagerSnapshot {
    return {
      isUploading: this.isRunning,
      activeTargetVirtualPath: this.targetVirtualPath,
      activePlaceholderVirtualPath: this.placeholderVirtualPath,
      items: this.tasks.map((task) => this.toQueueItem(task)),
      progress: this.progress,
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const cb of this.subscribers) {
      cb(snap);
    }
  }

  private recomputeProgress(): void {
    const activePlaceholderTask = this.tasks.find((task) =>
      ["PREPARING", "UPLOADING", "SENDING", "INDEXING"].includes(task.state),
    );
    this.placeholderVirtualPath = activePlaceholderTask
      ? this.savedToVirtualPath(activePlaceholderTask.destinationDbPath)
      : null;

    const totalFiles = this.tasks.length;
    if (totalFiles === 0) {
      this.progress = null;
      return;
    }

    let uploadedFiles = 0;
    let failedFiles = 0;
    let cancelledFiles = 0;
    let activeFileName: string | null = null;
    let activeFileProgress = 0;

    for (const task of this.tasks) {
      if (task.state === "COMPLETED") uploadedFiles += 1;
      if (task.state === "FAILED_FATAL" || task.state === "FAILED_RETRYABLE")
        failedFiles += 1;
      if (task.state === "CANCELLED") cancelledFiles += 1;
    }

    const active = this.tasks.find((t) =>
      ["PREPARING", "UPLOADING", "SENDING", "INDEXING"].includes(t.state),
    );
    if (active) {
      activeFileName = active.fileName;
      activeFileProgress = Math.max(
        0,
        Math.min(1, active.progressPercent / 100),
      );
    }

    this.progress = {
      totalFiles,
      uploadedFiles,
      failedFiles,
      cancelledFiles,
      activeFileProgress,
      activeFileName,
    };
  }

  private toQueueItem(task: UploadTask): UploadQueueItemView {
    const status: UploadQueueStatus =
      task.state === "QUEUED"
        ? "queued"
        : task.state === "PREPARING"
          ? "preparing"
          : task.state === "UPLOADING"
            ? "uploading"
            : task.state === "SENDING"
              ? "sending"
              : task.state === "INDEXING"
                ? "indexing"
                : task.state === "COMPLETED"
                  ? "completed"
                  : task.state === "CANCELLED"
                    ? "cancelled"
                    : "failed";

    return {
      id: task.uploadId,
      uploadId: task.uploadId,
      fileName: task.fileName,
      relativePath: task.relativePath,
      destinationVirtualPath: this.savedToVirtualPath(task.destinationDbPath),
      status,
      progress: Math.max(0, Math.min(100, task.progressPercent)),
      message: task.message,
      fileId: task.fileId,
      messageId: task.messageId,
    };
  }

  private handleProgressEvent(payload?: TgUploadProgressPayload | null): void {
    if (!payload) return;

    const uploadId = (payload.uploadId || "").trim() || null;
    const fileId = typeof payload.fileId === "number" ? payload.fileId : null;
    const messageId =
      typeof payload.messageId === "number" ? payload.messageId : null;

    let task: UploadTask | undefined;
    if (uploadId) {
      task = this.tasksByUploadId.get(uploadId);
    }
    if (!task && fileId && this.fileIdToUploadId.has(fileId)) {
      const mapped = this.fileIdToUploadId.get(fileId);
      if (mapped) task = this.tasksByUploadId.get(mapped);
    }
    if (!task) {
      return;
    }

    if (fileId && !task.fileId) {
      task.fileId = fileId;
      this.fileIdToUploadId.set(fileId, task.uploadId);
      if (task.cancelRequested) {
        void this.cancelUpload(task.uploadId);
      }
    }
    if (messageId && !task.messageId) {
      task.messageId = messageId;
    }

    task.progressPercent = Math.max(0, Math.min(100, payload.progress ?? 0));
    task.message = payload.message || undefined;

    const stage = payload.stage;
    if (stage === "preparing") {
      task.state = task.state === "CANCELLED" ? task.state : "PREPARING";
    } else if (stage === "uploading") {
      task.state = task.state === "CANCELLED" ? task.state : "UPLOADING";
    } else if (stage === "sending") {
      task.state = task.state === "CANCELLED" ? task.state : "SENDING";
    } else if (stage === "completed") {
      task.state = task.state === "CANCELLED" ? task.state : "INDEXING";
      this.ensureIndexingTimeout(task.uploadId);
    } else if (stage === "cancelled") {
      task.state = "CANCELLED";
    } else {
      // failed
      task.state =
        this.classifyFailure(task.message || "Upload failed") === "retryable"
          ? "FAILED_RETRYABLE"
          : "FAILED_FATAL";
    }

    this.recomputeProgress();
    this.emit();
  }

  private handleIndexedEvent(payload?: TgUploadIndexedPayload | null): void {
    if (!payload) return;
    const uploadId = (payload.uploadId || "").trim();
    if (!uploadId) return;

    const task = this.tasksByUploadId.get(uploadId);
    if (!task) return;

    const fileId = typeof payload.fileId === "number" ? payload.fileId : null;
    if (fileId && !task.fileId) {
      task.fileId = fileId;
      this.fileIdToUploadId.set(fileId, task.uploadId);
    }
    task.messageId = payload.messageId;

    if (task.state !== "CANCELLED") {
      task.state = "COMPLETED";
      task.progressPercent = 100;
      task.message = undefined;
    }

    this.clearIndexingTimeout(uploadId);
    this.recomputeProgress();
    this.emit();

    this.maybeStopIfDone();
    this.pump();
  }

  private ensureIndexingTimeout(uploadId: string): void {
    if (this.indexingTimers.has(uploadId)) return;
    const timer = window.setTimeout(() => {
      this.indexingTimers.delete(uploadId);
      const task = this.tasksByUploadId.get(uploadId);
      if (!task) return;
      if (task.state === "INDEXING") {
        task.state = "FAILED_RETRYABLE";
        task.message = "Timed out waiting for indexing";
        this.recomputeProgress();
        this.emit();
        this.pump();
      }
    }, this.indexingTimeoutMs);
    this.indexingTimers.set(uploadId, timer);
  }

  private clearIndexingTimeout(uploadId: string): void {
    const timer = this.indexingTimers.get(uploadId);
    if (timer) {
      window.clearTimeout(timer);
      this.indexingTimers.delete(uploadId);
    }
  }

  private classifyFailure(message: string): "retryable" | "fatal" {
    return isRetryableErrorMessage(message) ? "retryable" : "fatal";
  }

  async startBatch(args: {
    targetVirtualPath: string;
    entries: UploadDraftEntry[];
    caption: string | null;
    options: UploadConfirmDraft["options"];
  }): Promise<{ createdFolderStructure: boolean }> {
    const target = (args.targetVirtualPath || "").trim();
    if (!target.startsWith("tg://saved")) {
      throw new Error("Upload is available in Saved Messages only.");
    }
    if (this.isRecycleBinVirtualPath(target)) {
      throw new Error("Cannot upload files inside Recycle Bin.");
    }
    if (!args.entries.length) {
      return { createdFolderStructure: false };
    }

    await this.init();

    this.targetVirtualPath = target;
    this.placeholderVirtualPath = null;

    const rootDbPath = this.virtualToSavedPath(target);

    const tasks: UploadTask[] = args.entries.map((entry) => {
      const rel = normalizeRelPath(entry.relativePath) || entry.file.name;
      const parts = rel.split("/").filter(Boolean);
      const dirs = parts.slice(0, -1);
      const destinationDbPath = dirs.length
        ? joinSavedDbPath(rootDbPath, dirs.join("/"))
        : rootDbPath;
      const uploadId = createUploadId();
      return {
        uploadId,
        entry,
        fileName: entry.file.name,
        relativePath: rel,
        destinationDbPath,
        caption: args.caption,
        options: args.options,
        attempt: 0,
        state: "QUEUED",
        progressPercent: 0,
        cancelRequested: false,
      };
    });

    // Pre-resolve and create folder tree BEFORE any uploads start.
    const createdFolderStructure = tasks.some((t) =>
      t.relativePath.includes("/"),
    );
    await this.ensureFolders(rootDbPath, tasks);

    // Enqueue tasks.
    this.tasks = tasks;
    this.tasksByUploadId.clear();
    this.fileIdToUploadId.clear();
    for (const task of tasks) {
      this.tasksByUploadId.set(task.uploadId, task);
    }
    this.isRunning = true;
    this.recomputeProgress();
    this.emit();

    this.pump();
    return { createdFolderStructure };
  }

  private async ensureFolders(
    rootDbPath: string,
    tasks: UploadTask[],
  ): Promise<void> {
    const needed = new Set<string>();
    const toCreate: Array<{ parent: string; name: string; full: string }> = [];

    for (const task of tasks) {
      const rel = normalizeRelPath(task.relativePath);
      const parts = rel.split("/").filter(Boolean);
      const dirs = parts.slice(0, -1);
      if (!dirs.length) continue;

      let current = rootDbPath;
      for (const segment of dirs) {
        const next = joinSavedDbPath(current, segment);
        if (!needed.has(next)) {
          needed.add(next);
          toCreate.push({ parent: current, name: segment, full: next });
        }
        current = next;
      }
    }

    // Stable order (shallow to deep).
    toCreate.sort(
      (a, b) => a.full.split("/").length - b.full.split("/").length,
    );
    for (const folder of toCreate) {
      await invoke("tg_create_saved_folder", {
        parentPath: folder.parent,
        folderName: folder.name,
      });
    }
  }

  private pump(): void {
    if (!this.isRunning) return;
    while (this.activeWorkers < this.concurrency) {
      const next = this.tasks.find(
        (t) => t.state === "QUEUED" || t.state === "FAILED_RETRYABLE",
      );
      if (!next) break;
      this.activeWorkers += 1;
      void this.runTask(next).finally(() => {
        this.activeWorkers -= 1;
        this.maybeStopIfDone();
        this.emit();
        this.pump();
      });
    }
  }

  private maybeStopIfDone(): void {
    if (!this.isRunning) return;
    const remaining = this.tasks.some((t) =>
      [
        "QUEUED",
        "PREPARING",
        "UPLOADING",
        "SENDING",
        "INDEXING",
        "FAILED_RETRYABLE",
      ].includes(t.state),
    );
    if (!remaining && this.activeWorkers === 0) {
      this.isRunning = false;
      this.targetVirtualPath = null;
      this.placeholderVirtualPath = null;
      this.recomputeProgress();
      this.emit();
    }
  }

  private async runTask(task: UploadTask): Promise<void> {
    if (task.state === "FAILED_RETRYABLE") {
      // retry state
    } else if (task.state !== "QUEUED") {
      return;
    }

    if (task.cancelRequested) {
      task.state = "CANCELLED";
      return;
    }

    task.state = "PREPARING";
    task.progressPercent = Math.max(task.progressPercent, 0);
    this.placeholderVirtualPath = this.savedToVirtualPath(
      task.destinationDbPath,
    );
    this.recomputeProgress();
    this.emit();

    try {
      task.attempt += 1;
      const sendAs = task.options.sendAs ?? "photo";
      const hasSpoiler = task.options.hideWithSpoiler ?? false;
      const highQuality = task.options.highQuality ?? true;

      const uploadArgs: Record<string, unknown> = {
        uploadId: task.uploadId,
        fileName: task.entry.file.name,
        filePath: task.destinationDbPath,
        caption: task.caption,
        sendAs,
        hasSpoiler,
        highQuality,
      };

      if (task.entry.sourcePath) {
        uploadArgs.sourcePath = task.entry.sourcePath;
      } else {
        const buffer = await task.entry.file.arrayBuffer();
        uploadArgs.fileBytes = Array.from(new Uint8Array(buffer));
      }

      task.state = "UPLOADING";
      this.recomputeProgress();
      this.emit();

      // This command is expected to return quickly; progress + completion are event-driven.
      const result = await invoke<{ message_id?: number } | null>(
        "tg_upload_file_to_saved_messages",
        {
          args: uploadArgs,
        },
      );
      if (result && typeof result.message_id === "number") {
        task.messageId = result.message_id;
      }
      // Rely on tg-upload-progress/tg-upload-indexed for transitions. Those
      // events are dispatched from xhr.onload, which settles before this
      // await resumes - so the task can already be COMPLETED by now. Forcing
      // SENDING over it demotes a finished task back to an in-progress one,
      // which strands it (no further events will ever arrive) and leaves the
      // explorer drawing an upload placeholder beside the file that already
      // landed in the listing.
      if (!isFinishedUploadState(task.state)) {
        task.state = "SENDING";
      }
      this.recomputeProgress();
      this.emit();

      await this.waitForTerminal(task.uploadId);
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Upload failed";
      const kind = this.classifyFailure(message);
      task.message = message;

      if (task.cancelRequested) {
        task.state = "CANCELLED";
      } else if (
        kind === "retryable" &&
        task.attempt <= this.uploadRetryCount
      ) {
        task.state = "FAILED_RETRYABLE";
      } else {
        task.state = "FAILED_FATAL";
      }
      this.recomputeProgress();
      this.emit();
    }
  }

  private waitForTerminal(uploadId: string): Promise<void> {
    const task = this.tasksByUploadId.get(uploadId);
    if (!task) return Promise.resolve();
    const isTerminal = () =>
      ["COMPLETED", "FAILED_FATAL", "CANCELLED"].includes(task.state) ||
      (task.state === "FAILED_RETRYABLE" &&
        task.attempt > this.uploadRetryCount);

    if (isTerminal()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const unsub = this.subscribe(() => {
        const current = this.tasksByUploadId.get(uploadId);
        if (!current) {
          unsub();
          resolve();
          return;
        }
        if (
          ["COMPLETED", "FAILED_FATAL", "CANCELLED"].includes(current.state) ||
          (current.state === "FAILED_RETRYABLE" &&
            current.attempt > this.uploadRetryCount)
        ) {
          unsub();
          resolve();
        }
      });
    });
  }

  async cancelAll(): Promise<void> {
    for (const task of this.tasks) {
      task.cancelRequested = true;
      if (["QUEUED", "FAILED_RETRYABLE"].includes(task.state)) {
        task.state = "CANCELLED";
      }
    }
    this.recomputeProgress();
    this.emit();

    const active = this.tasks.filter((t) =>
      ["PREPARING", "UPLOADING", "SENDING", "INDEXING"].includes(t.state),
    );
    await Promise.all(active.map((t) => this.cancelUpload(t.uploadId)));
  }

  async cancelUpload(uploadId: string): Promise<boolean> {
    const task = this.tasksByUploadId.get(uploadId);
    if (!task) return false;
    task.cancelRequested = true;

    if (task.fileId && task.fileId > 0) {
      try {
        const ok = await invoke<boolean>("tg_cancel_saved_file_upload", {
          fileId: task.fileId,
        });
        return Boolean(ok);
      } catch {
        return false;
      }
    }
    // No file id yet; cancellation will be applied once we see a progress event binding.
    return false;
  }
}
