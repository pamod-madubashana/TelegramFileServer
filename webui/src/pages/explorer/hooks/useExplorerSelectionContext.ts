import { useCallback, useMemo, type MutableRefObject } from "react";
import { type FileItem } from "@/components/skybox/FileRow";
import {
  type ExplorerClipboardItem,
  type ExplorerContextMenuState,
  type ExplorerViewMode,
  type PasteProgressState,
  type SelectionBoxState,
  type UploadQueueItemState,
  isGalleryPath,
  isUploadQueueItemInProgress,
  isNotesVirtualPath,
  isProtectedSavedFolderPath,
  isRecycleBinPath,
  isSavedVirtualFilePath,
  normalizePath,
} from "@/pages/explorer/shared";

type UseExplorerSelectionContextArgs = {
  activePaste: PasteProgressState | null;
  clipboardItem: ExplorerClipboardItem | null;
  closeDetailsPanel: () => void;
  contextMenuState: ExplorerContextMenuState | null;
  currentPath: string;
  filesRef: MutableRefObject<FileItem[]>;
  isUploadInProgress: boolean;
  onOpenFile: (file: FileItem) => Promise<void> | void;
  openDetailsPanel: () => void;
  requestDeleteTargets: (targets: FileItem[]) => void;
  selectedFile: FileItem | null;
  selectedPaths: string[];
  selectionAnchorPathRef: MutableRefObject<string | null>;
  selectionBox: SelectionBoxState | null;
  setContextMenuState: (value: ExplorerContextMenuState | null) => void;
  setSelectedFile: (value: FileItem | null) => void;
  setSelectedPaths: (value: string[]) => void;
  sortedFiles: FileItem[];
  uploadActivePlaceholderPath: string | null;
  uploadQueueItems: UploadQueueItemState[];
  viewMode: ExplorerViewMode;
};

/** Queue entries may carry a folder prefix; listings show the base name. */
const queueBaseName = (fileName: string): string => {
  const segments = fileName.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? fileName;
};

export function useExplorerSelectionContext({
  activePaste,
  clipboardItem,
  closeDetailsPanel,
  contextMenuState,
  currentPath,
  filesRef,
  isUploadInProgress,
  onOpenFile,
  openDetailsPanel,
  requestDeleteTargets,
  selectedFile,
  selectedPaths,
  selectionAnchorPathRef,
  selectionBox,
  setContextMenuState,
  setSelectedFile,
  setSelectedPaths,
  sortedFiles,
  uploadActivePlaceholderPath,
  uploadQueueItems,
  viewMode,
}: UseExplorerSelectionContextArgs) {
  const selectedPathSet = useMemo(
    () => new Set(selectedPaths),
    [selectedPaths],
  );
  const selectionBoxStyle = selectionBox
    ? {
        left: `${Math.min(selectionBox.startX, selectionBox.currentX)}px`,
        top: `${Math.min(selectionBox.startY, selectionBox.currentY)}px`,
        width: `${Math.abs(selectionBox.currentX - selectionBox.startX)}px`,
        height: `${Math.abs(selectionBox.currentY - selectionBox.startY)}px`,
      }
    : null;
  const normalizedCurrentPath = normalizePath(currentPath);
  // A finished upload lands in the listing before (or while) its queue entry
  // leaves the in-progress states; drawing both puts a placeholder next to
  // the file it is supposed to stand in for. Queue entries for folder
  // uploads carry a relative path prefix while listings show base names, so
  // the lookup strips the prefix before comparing.
  const presentNames = useMemo(
    () => new Set(sortedFiles.map((file) => file.name)),
    [sortedFiles],
  );
  const matchedUploads = uploadQueueItems.filter((item) => {
    const destinationPath = item.destinationVirtualPath
      ? normalizePath(item.destinationVirtualPath)
      : null;
    return (
      destinationPath === normalizedCurrentPath &&
      (item.status === "queued" || isUploadQueueItemInProgress(item.status)) &&
      !presentNames.has(queueBaseName(item.fileName))
    );
  });
  // Picking the same file twice produces two queue entries for one file;
  // collapse them so the pane draws a single row, preferring the entry that
  // is actually in flight so the named placeholder tracks the live upload.
  const uploadsByName = new Map<string, UploadQueueItemState>();
  for (const item of matchedUploads) {
    const key = queueBaseName(item.fileName);
    const existing = uploadsByName.get(key);
    if (
      !existing ||
      (!isUploadQueueItemInProgress(existing.status) &&
        isUploadQueueItemInProgress(item.status))
    ) {
      uploadsByName.set(key, item);
    }
  }
  const uploadsForCurrentPath = Array.from(uploadsByName.values());
  const uploadPlaceholderItem =
    uploadsForCurrentPath.find((item) =>
      isUploadQueueItemInProgress(item.status),
    ) ?? null;
  const shouldShowUploadPlaceholder =
    isUploadInProgress &&
    !!uploadPlaceholderItem &&
    normalizePath(uploadActivePlaceholderPath || "") === normalizedCurrentPath;
  // Only subtract the named placeholder when it is actually rendered;
  // otherwise its slot would vanish from the skeleton count.
  const uploadSkeletonCount = Math.max(
    0,
    uploadsForCurrentPath.length - (shouldShowUploadPlaceholder ? 1 : 0),
  );
  const pasteSkeletonCount =
    activePaste &&
    normalizePath(activePaste.destinationPath) === normalizePath(currentPath)
      ? 1
      : 0;
  const hasVisibleItems =
    sortedFiles.length > 0 ||
    !!uploadPlaceholderItem ||
    uploadSkeletonCount > 0 ||
    pasteSkeletonCount > 0;
  const contextTargetFile = contextMenuState?.targetFile ?? null;
  const isMultiSelectionContextMenu =
    !!contextTargetFile &&
    selectedPaths.length > 1 &&
    selectedPathSet.has(contextTargetFile.path);
  const isNotesMessageContextMenu =
    !!contextTargetFile &&
    !!contextTargetFile.isNoteMessage &&
    isNotesVirtualPath(currentPath);
  const isProtectedContextFolder =
    !!contextTargetFile &&
    contextTargetFile.isDirectory &&
    isProtectedSavedFolderPath(contextTargetFile.path);
  const canPaste = !!clipboardItem;
  const cutPathSet = useMemo(() => {
    if (!clipboardItem || clipboardItem.mode !== "cut") {
      return undefined;
    }

    const paths = clipboardItem.items.map((item) => item.path);
    return paths.length ? new Set(paths) : undefined;
  }, [clipboardItem]);
  const isRecycleBinView = isRecycleBinPath(currentPath);
  const isGalleryView = isGalleryPath(currentPath);
  const isNotesFolderView = isNotesVirtualPath(currentPath);
  const canPasteInCurrentPath =
    canPaste && !isNotesFolderView && !isGalleryView;
  const effectiveViewMode: ExplorerViewMode = isNotesFolderView
    ? "list"
    : isGalleryView
      ? "grid"
      : viewMode;

  const closeContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, [setContextMenuState]);

  const openContextMenu = useCallback(
    (
      event: React.MouseEvent,
      targetFile: FileItem | null,
      isEmptyArea = false,
    ) => {
      event.preventDefault();
      event.stopPropagation();

      const menuWidth = 236;
      const isRecycleBinMenu = isRecycleBinPath(currentPath) && !!targetFile;
      const hasDownloadAction =
        !!targetFile &&
        !targetFile.isDirectory &&
        isSavedVirtualFilePath(targetFile.path);
      const menuHeight = isEmptyArea
        ? 140
        : isRecycleBinMenu
          ? 112
          : targetFile && !targetFile.isDirectory
            ? hasDownloadAction
              ? 376
              : 332
            : 380;
      const clampedX = Math.max(
        8,
        Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      );
      const clampedY = Math.max(
        8,
        Math.min(event.clientY, window.innerHeight - menuHeight - 8),
      );

      setContextMenuState({
        x: clampedX,
        y: clampedY,
        targetFile,
        isEmptyArea,
      });
    },
    [currentPath, setContextMenuState],
  );

  const handleFileSelect = useCallback(
    (file: FileItem, event?: React.MouseEvent<HTMLDivElement>) => {
      const orderedPaths = sortedFiles.map((item) => item.path);
      const isAdditive = !!event && (event.ctrlKey || event.metaKey);
      const isRange = !!event && event.shiftKey;

      const anchorPath =
        selectionAnchorPathRef.current ??
        (selectedPaths.length > 0
          ? selectedPaths[selectedPaths.length - 1]
          : null);
      const anchorIndex = anchorPath ? orderedPaths.indexOf(anchorPath) : -1;
      const targetIndex = orderedPaths.indexOf(file.path);

      if (isRange && anchorIndex >= 0 && targetIndex >= 0) {
        const [from, to] =
          anchorIndex <= targetIndex
            ? [anchorIndex, targetIndex]
            : [targetIndex, anchorIndex];
        const range = orderedPaths.slice(from, to + 1);
        const merged = isAdditive
          ? Array.from(new Set([...selectedPaths, ...range]))
          : range;
        const next = orderedPaths.filter((path) => merged.includes(path));

        setSelectedPaths(next);
        setSelectedFile(
          filesRef.current.find((item) => item.path === next[0]) || null,
        );
        if (next.length > 1 || isRecycleBinPath(currentPath)) {
          closeDetailsPanel();
        }
        return;
      }

      if (isAdditive) {
        const nextSet = new Set(selectedPaths);
        if (nextSet.has(file.path)) {
          nextSet.delete(file.path);
        } else {
          nextSet.add(file.path);
        }
        const next = orderedPaths.filter((path) => nextSet.has(path));
        setSelectedPaths(next);
        setSelectedFile(
          filesRef.current.find((item) => item.path === next[0]) || null,
        );
        if (next.length > 1 || isRecycleBinPath(currentPath)) {
          closeDetailsPanel();
        }
        selectionAnchorPathRef.current = file.path;
        return;
      }

      selectionAnchorPathRef.current = file.path;
      setSelectedPaths([file.path]);
      setSelectedFile(file);
      if (isRecycleBinPath(currentPath)) {
        closeDetailsPanel();
      }
    },
    [
      closeDetailsPanel,
      currentPath,
      filesRef,
      selectedPaths,
      selectionAnchorPathRef,
      setSelectedFile,
      setSelectedPaths,
      sortedFiles,
    ],
  );

  const handleFileContextMenu = useCallback(
    (event: React.MouseEvent, file: FileItem) => {
      const isFileAlreadySelected = selectedPaths.includes(file.path);
      if (!isFileAlreadySelected) {
        setSelectedPaths([file.path]);
      }

      setSelectedFile(file);
      selectionAnchorPathRef.current = file.path;
      openContextMenu(event, file, false);
    },
    [
      openContextMenu,
      selectedPaths,
      selectionAnchorPathRef,
      setSelectedFile,
      setSelectedPaths,
    ],
  );

  const handleEmptyAreaContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      setSelectedPaths([]);
      setSelectedFile(null);
      closeDetailsPanel();

      if (isRecycleBinPath(currentPath) || isGalleryPath(currentPath)) {
        setContextMenuState(null);
        return;
      }

      openContextMenu(event, null, true);
    },
    [
      closeDetailsPanel,
      currentPath,
      openContextMenu,
      setContextMenuState,
      setSelectedFile,
      setSelectedPaths,
    ],
  );

  const handleContextDelete = useCallback(() => {
    const file = contextMenuState?.targetFile;
    if (!file) {
      return;
    }

    setSelectedFile(file);

    const isSelectionDelete =
      selectedPaths.length > 1 && selectedPaths.includes(file.path);
    const targetPaths = isSelectionDelete ? selectedPaths : [file.path];
    const targets = targetPaths
      .map(
        (path) => filesRef.current.find((item) => item.path === path) || null,
      )
      .filter((item): item is FileItem => !!item);

    if (targets.length) {
      requestDeleteTargets(targets);
    }
  }, [
    contextMenuState,
    filesRef,
    requestDeleteTargets,
    selectedPaths,
    setSelectedFile,
  ]);

  const handleContextDetails = useCallback(
    (targetFile?: FileItem | null) => {
      if (selectedPaths.length > 1) {
        return;
      }

      const file = targetFile ?? contextMenuState?.targetFile ?? selectedFile;
      if (!file || isRecycleBinPath(currentPath)) {
        return;
      }

      setSelectedFile(file);
      openDetailsPanel();
    },
    [
      contextMenuState,
      currentPath,
      openDetailsPanel,
      selectedFile,
      selectedPaths.length,
      setSelectedFile,
    ],
  );

  const handleContextOpen = useCallback(async () => {
    const file = contextMenuState?.targetFile;
    if (!file) {
      return;
    }

    await onOpenFile(file);
  }, [contextMenuState, onOpenFile]);

  return {
    canPasteInCurrentPath,
    closeContextMenu,
    contextTargetFile,
    cutPathSet,
    effectiveViewMode,
    handleContextDelete,
    handleContextDetails,
    handleContextOpen,
    handleEmptyAreaContextMenu,
    handleFileContextMenu,
    handleFileSelect,
    hasVisibleItems,
    isMultiSelectionContextMenu,
    isNotesFolderView,
    isNotesMessageContextMenu,
    isProtectedContextFolder,
    pasteSkeletonCount,
    selectedPathSet,
    selectionBoxStyle,
    shouldShowUploadPlaceholder,
    uploadPlaceholderItem,
    uploadSkeletonCount,
  };
}
