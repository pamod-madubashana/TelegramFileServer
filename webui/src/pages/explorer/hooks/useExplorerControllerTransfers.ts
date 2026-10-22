import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "@/hooks/use-toast";
import {
  type UploadConfirmDraft,
  type UploadDraftEntry,
} from "@/components/skybox/UploadConfirmWidget";
import {
  type DownloadProgressPayload,
  type SavedPathCacheEntry,
  type TelegramError,
} from "@/pages/explorer/shared";
import { type UploadManager } from "@/lib/upload-manager";
import { invalidateDirectoryCache } from "@/pages/explorer/explorerDirectoryCache";

type Args = {
  activeDownload: {
    sourcePath: string;
  } | null;
  canCancelDownload: boolean;
  currentPath: string;
  currentPathRef: React.MutableRefObject<string>;
  handleRefresh: () => Promise<void>;
  hasTransferEntries: boolean;
  isUploadingFiles: boolean;
  loadDirectoryRef: React.MutableRefObject<
    (
        path: string,
        options?: { force?: boolean; background?: boolean }
      ) => Promise<void>
  >;
  queueCloudSync: () => void;
  requestStructureBackup: () => void;
  resetUploadSpeedTracking: () => void;
  savedPathCacheRef: React.MutableRefObject<Record<string, SavedPathCacheEntry>>;
  setActiveDownload: React.Dispatch<
    React.SetStateAction<DownloadProgressPayload | null>
  >;
  setIsTransferMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setUploadConfirmDraft: React.Dispatch<
    React.SetStateAction<UploadConfirmDraft | null>
  >;
  uploadManagerRef: React.MutableRefObject<UploadManager | null>;
};

export function useExplorerControllerTransfers({
  activeDownload,
  canCancelDownload,
  currentPath,
  currentPathRef,
  handleRefresh,
  hasTransferEntries,
  isUploadingFiles,
  loadDirectoryRef,
  queueCloudSync,
  requestStructureBackup,
  resetUploadSpeedTracking,
  savedPathCacheRef,
  setActiveDownload,
  setIsTransferMenuOpen,
  setUploadConfirmDraft,
  uploadManagerRef,
}: Args) {
  const handleUploadFiles = useCallback(
    async (
      droppedEntries: UploadDraftEntry[],
      caption?: string,
      options?: UploadConfirmDraft["options"],
    ) => {
      if (!droppedEntries.length) {
        return;
      }
      if (
        !currentPath.startsWith("tg://saved") &&
        !currentPath.startsWith("tg://drive/")
      ) {
        toast({
          title: "Upload unavailable",
          description:
            "Drag-and-drop upload is available in Saved Messages and drives.",
          variant: "destructive",
        });
        return;
      }
      if (
        currentPath.includes("/Recycle Bin") ||
        currentPath.endsWith("recycle-bin")
      ) {
        toast({
          title: "Upload unavailable",
          description: "Cannot upload files inside Recycle Bin.",
          variant: "destructive",
        });
        return;
      }
      const manager = uploadManagerRef.current;
      if (!manager) {
        toast({
          title: "Upload failed",
          description: "Upload manager is not initialized",
          variant: "destructive",
        });
        return;
      }
      const uploadTargetPath = currentPath;
      const normalizedCaption =
        typeof caption === "string" ? caption.trim() : "";
      const captionOrNull = normalizedCaption ? normalizedCaption : null;
      const resolvedOptions: UploadConfirmDraft["options"] = options ?? {
        sendAs: "photo",
        highQuality: true,
        hideWithSpoiler: false,
        moveCaptionUp: false,
      };
      resetUploadSpeedTracking();
      try {
        const result = await manager.startBatch({
          targetVirtualPath: uploadTargetPath,
          entries: droppedEntries,
          caption: captionOrNull,
          options: resolvedOptions,
        });
        if (result.createdFolderStructure) {
          requestStructureBackup();
          // Uploads land in the current folder; only that listing changed.
          invalidateDirectoryCache(uploadTargetPath);
          queueCloudSync();
          if (currentPathRef.current === uploadTargetPath) {
            await loadDirectoryRef.current(uploadTargetPath, { force: true });
          }
        }
      } catch (error) {
        const typedError = error as TelegramError;
        toast({
          title: "Upload failed",
          description: typedError?.message || "Unable to start upload",
          variant: "destructive",
        });
      }
    },
    [
      currentPath,
      currentPathRef,
      loadDirectoryRef,
      queueCloudSync,
      requestStructureBackup,
      resetUploadSpeedTracking,
      uploadManagerRef,
    ],
  );

  const handleToggleTransferMenu = useCallback(() => {
    if (!hasTransferEntries) {
      return;
    }
    setIsTransferMenuOpen((prev) => !prev);
  }, [hasTransferEntries, setIsTransferMenuOpen]);

  const handleCancelUploadQueue = useCallback(async () => {
    if (!isUploadingFiles) {
      return;
    }
    const manager = uploadManagerRef.current;
    if (!manager) {
      return;
    }
    try {
      await manager.cancelAll();
    } catch (error) {
      const typedError = error as TelegramError;
      toast({
        title: "Cancel failed",
        description: typedError?.message || "Unable to cancel uploads",
        variant: "destructive",
      });
    }
  }, [isUploadingFiles, uploadManagerRef]);

  const handleCancelActiveDownload = useCallback(async () => {
    if (!activeDownload || !canCancelDownload) {
      return;
    }
    setActiveDownload((prev: DownloadProgressPayload | null) => {
      if (!prev || prev.sourcePath !== activeDownload.sourcePath) {
        return prev;
      }
      return {
        ...prev,
        message: "Cancelling download...",
      };
    });
    try {
      await invoke("tg_cancel_saved_file_download", {
        sourcePath: activeDownload.sourcePath,
      });
    } catch (error) {
      const typedError = error as TelegramError;
      toast({
        title: "Cancel failed",
        description: typedError.message || "Unable to cancel download",
        variant: "destructive",
      });
    }
  }, [activeDownload, canCancelDownload, setActiveDownload]);

  const handleConfirmUploadDraft = useCallback(
    (draft: UploadConfirmDraft) => {
      setUploadConfirmDraft(null);
      const selectedEntries = draft.entries.filter(
        (entry) => draft.selection[entry.id] !== false,
      );
      void handleUploadFiles(selectedEntries, draft.caption, draft.options);
    },
    [handleUploadFiles, setUploadConfirmDraft],
  );

  return {
    handleCancelActiveDownload,
    handleCancelUploadQueue,
    handleConfirmUploadDraft,
    handleToggleTransferMenu,
    handleUploadFiles,
  };
}
