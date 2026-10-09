import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import { type FileItem } from "@/components/skybox/FileRow";
import {
  type UploadConfirmDraft,
  type UploadDraftEntry,
} from "@/components/skybox/UploadConfirmWidget";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "@/hooks/use-toast";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveThumbnailSrc } from "@/lib/thumbnail-src";
import { useExplorerBootstrap } from "@/pages/explorer/hooks/useExplorerBootstrap";
import { useExplorerAccountSettings } from "@/pages/explorer/hooks/useExplorerAccountSettings";
import { useExplorerChatDrivePicker } from "@/pages/explorer/hooks/useExplorerChatDrivePicker";
import { useExplorerControllerState } from "@/pages/explorer/hooks/useExplorerControllerState";
import { useExplorerControllerTransfers } from "@/pages/explorer/hooks/useExplorerControllerTransfers";
import { useExplorerControllerUi } from "@/pages/explorer/hooks/useExplorerControllerUi";
import { useExplorerCloudGate } from "@/pages/explorer/hooks/useExplorerCloudGate";
import { useExplorerMedia } from "@/pages/explorer/hooks/useExplorerMedia";
import { useExplorerTabs } from "@/pages/explorer/hooks/useExplorerTabs";
import { useExplorerFileActions } from "@/pages/explorer/hooks/useExplorerFileActions";
import { useExplorerDragInteractions } from "@/pages/explorer/hooks/useExplorerDragInteractions";
import { useExplorerNavigationInteractions } from "@/pages/explorer/hooks/useExplorerNavigationInteractions";
import { useExplorerSelectionContext } from "@/pages/explorer/hooks/useExplorerSelectionContext";
import { useExplorerTransfers } from "@/pages/explorer/hooks/useExplorerTransfers";
import { useExplorerVirtualData } from "@/pages/explorer/hooks/useExplorerVirtualData";
import {
  consumeExplorerScrollRestore,
  getExplorerScrollPosition,
  markExplorerHydrated,
  rememberExplorerScrollPosition,
  updateExplorerSessionState,
} from "@/pages/explorer/explorerSessionStore";
import {
  DEFAULT_EXPLORER_HOME_PATH,
  DEFAULT_EXPLORER_RECENTS_LIMIT,
  DETAILS_PANEL_ANIMATION_MS,
  EXPLORER_VIEW_MODE_KEY,
  INTERNAL_DRAG_MIME,
  INTERNAL_DRAG_MIME_LIST,
  NOTES_VIRTUAL_PATH,
  RECYCLE_BIN_VIRTUAL_PATH,
  SAVED_ITEMS_PAGE_SIZE,
  STORAGE_KEY_CHAT_DRIVE,
  STORAGE_KEY_CHAT_DRIVES,
  type ChatDriveCandidate,
  type ClipboardMode,
  type DbError,
  type DownloadProgressPayload,
  type ExplorerClipboardItem,
  type ExplorerContextMenuState,
  type ExplorerViewMode,
  type Favorite,
  type FileEntry,
  type FsError,
  type PasteProgressState,
  type RecentPath,
  type SavedPathCacheEntry,
  type SelectionBoxState,
  type SyncSnapshotDto,
  type TelegramAuthResult,
  type TelegramChatDriveItemsPage,
  type TelegramChatSummaryDto,
  type TelegramError,
  type TelegramIndexSavedMessagesResult,
  type TelegramMessage,
  type TelegramSavedItem,
  type TelegramSavedItemsPage,
  type TgUpdateEventPayload,
  type UserInfo,
  convertFileEntryToFileItem,
  driveItemToFileItem,
  estimateSyncPercentFromIndexedCount,
  getExplorerTabTitle,
  getParentPath,
  getPathName,
  getSavedMediaKind,
  isDriveVirtualFilePath,
  isDriveVirtualFolderPath,
  isGalleryPath,
  isNotesVirtualPath,
  isProtectedSavedFolderPath,
  isRecycleBinPath,
  isSavedPreviewableFile,
  isSavedVirtualFilePath,
  isSavedVirtualFolderPath,
  isSavedVirtualItemPath,
  isTextInputElement,
  isVirtualPath,
  joinPath,
  mergeFileItemsByIdentity,
  normalizePath,
  parseDriveChatIdFromPath,
  savedItemToFileItem,
  telegramMessageToFileItem,
  virtualToSavedPath,
} from "@/pages/explorer/shared";

export function useExplorerPageController() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialRouteStateRef = useRef<unknown>(location.state);
  const isExplorerRouteActive = location.pathname.startsWith("/explorer");

  const initialIsOffline = useMemo(
    () => (typeof navigator !== "undefined" ? !navigator.onLine : false),
    [],
  );
  const isOfflineRef = useRef(false);
  const sessionDataRef = useRef<string | null>(null);
  const hasAttemptedSessionRestoreRef = useRef(false);
  const {
    activePaste,
    applyFetchedThumbnailRef,
    avatarUrl,
    backHistory,
    clipboardItem,
    closeViewerRef,
    confirmDeleteRef,
    confirmMoveRef,
    confirmRenameRef,
    contextMenuRef,
    contextMenuState,
    currentPath,
    currentPathRef,
    deleteTargets,
    detailsPanelCloseTimerRef,
    detailsPanelRef,
    draggedPaths,
    dropTargetPath,
    error,
    explorerAreaRef,
    explorerHomePath,
    explorerHomePathRef,
    explorerRecentsLimitRef,
    favorites,
    files,
    filesRef,
    folderSettingsTarget,
    forwardHistory,
    handleFileOpenRef,
    isDetailsPanelOpen,
    isExternalDragging,
    isLoading,
    isNewFolderDialogOpen,
    isSendingNoteMessage,
    isViewerOpenRef,
    navigateToPathRef,
    navigationStateRef,
    newFolderName,
    noteComposerValue,
    noteEditTarget,
    noteEditValue,
    pendingMoveConfirm,
    pendingRenameConfirm,
    phoneNumber,
    recentPaths,
    renameTarget,
    renameValue,
    runDeleteTargetsRef,
    search,
    searchRef,
    selectedFile,
    selectedFileRef,
    selectedPaths,
    selectedPathsRef,
    selectionAnchorPathRef,
    selectionBox,
    sortDirection,
    sortField,
    setActivePaste,
    setAvatarUrl,
    setBackHistory,
    setClipboardItem,
    setContextMenuState,
    setCurrentPath,
    setDeleteTargets,
    setDropTargetPath,
    setDraggedPaths,
    setError,
    setExplorerHomePath,
    setFavorites,
    setFiles,
    setFolderSettingsTarget,
    setForwardHistory,
    setIsDetailsPanelOpen,
    setIsExternalDragging,
    setIsLoading,
    setIsNewFolderDialogOpen,
    setIsSendingNoteMessage,
    setNewFolderName,
    setNoteComposerValue,
    setNoteEditTarget,
    setNoteEditValue,
    setPendingMoveConfirm,
    setPendingRenameConfirm,
    setPhoneNumber,
    setRecentPaths,
    setRenameTarget,
    setRenameValue,
    setSearch,
    setSelectedFile,
    setSelectedPaths,
    setSelectionBox,
    setSortDirection,
    setSortField,
    setShareTarget,
    setShowDetails,
    setShowFavorites,
    setUploadConfirmDraft,
    setUploadPremiumUser,
    setUserInfo,
    shareTarget,
    showDetails,
    showFavorites,
    showFavoritesRef,
    uploadConfirmDraft,
    uploadPremiumUser,
    userInfo,
  } = useExplorerControllerState();
  const attemptedChatDriveAutoIndexRef = useRef<Set<number>>(new Set());
  const {
    activeDownload,
    canCancelDownload,
    canCancelUploads,
    downloadDetailMessage,
    downloadProgressPercent,
    downloadToolbarLabel,
    hasTransferEntries,
    isTransferMenuOpen,
    isUploadInProgress,
    isUploadProgressMounted,
    isUploadProgressVisible,
    isUploadingFiles,
    resetDownloadSpeedTracking,
    resetUploadSpeedTracking,
    setActiveDownload,
    setIsTransferMenuOpen,
    trackDownloadSpeedSample,
    transferMenuRef,
    transferMenuTriggerRef,
    transferUploadItems,
    uploadActivePlaceholderPath,
    uploadManagerRef,
    uploadProgress,
    uploadQueueItems,
    uploadToolbarItem,
    uploadToolbarLabel,
    uploadToolbarPercent,
    uploadToolbarTitle,
  } = useExplorerTransfers();

  const parseSettingBool = (value: string | null, defaultValue: boolean) => {
    if (value === "0") return false;
    if (value === "1") return true;
    return defaultValue;
  };

  const parseRecentsLimitSetting = (value: string | null): number => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_EXPLORER_RECENTS_LIMIT;
    }

    return Math.min(250, Math.max(1, parsed));
  };

  const normalizeHomePathSetting = (value: string | null): string => {
    const raw = typeof value === "string" ? value.trim() : "";
    return raw ? raw : DEFAULT_EXPLORER_HOME_PATH;
  };

  const requestDeleteTargets = useCallback((targets: FileItem[]) => {
    if (!targets.length) {
      return;
    }

    if (confirmDeleteRef.current) {
      setDeleteTargets(targets);
      return;
    }

    runDeleteTargetsRef.current(targets);
  }, []);

  const { isOffline, queueCloudSync, requestStructureBackup, setIsOffline } =
    useExplorerCloudGate({
      hasAttemptedSessionRestoreRef,
      initialIsOffline,
      isOfflineRef,
      sessionDataRef,
    });

  const {
    loadFavorites,
    loadProfilePhoto,
    loadUserInfo,
    refreshRecentPaths,
    setViewMode,
    viewMode,
  } = useExplorerAccountSettings({
    isOfflineRef,
    sessionDataRef,
    hasAttemptedSessionRestoreRef,
    setAvatarUrl,
    setExplorerHomePath,
    setFavorites,
    setPhoneNumber,
    setRecentPaths,
    setShowFavorites,
    setUserInfo,
    setUploadPremiumUser,
    uploadConfirmDraft,
    uploadPremiumUser,
    explorerHomePathRef,
    explorerRecentsLimitRef,
    showFavoritesRef,
    confirmDeleteRef,
    confirmMoveRef,
    confirmRenameRef,
    normalizeHomePathSetting,
    parseRecentsLimitSetting,
    parseSettingBool,
  });

  const {
    chatDriveCandidates,
    chatDriveCandidatesQuery,
    handleConfirmChatDriveCandidate,
    isChatDriveCandidatesLoading,
    isChatDrivePickerOpen,
    pendingChatDriveCandidate,
    setChatDriveCandidatesQuery,
    setIsChatDrivePickerOpen,
    setPendingChatDriveCandidate,
  } = useExplorerChatDrivePicker({
    attemptedChatDriveAutoIndexRef,
    isOfflineRef,
    navigateToPath: (path) => navigateToPathRef.current(path),
  });

  const {
    handleDirectoryScroll,
    hasMoreSavedItems,
    hasMoreSavedItemsRef,
    isConnecting,
    isLoadingMoreSavedItems,
    isLoadingMoreSavedItemsRef,
    isSavedBackfillSyncing,
    isSavedSyncComplete,
    loadDirectory,
    loadDirectoryRef,
    savedItemsOffset,
    savedItemsOffsetRef,
    savedPathCacheRef,
    savedSyncPercent,
    savedSyncStatusLabel,
    setHasMoreSavedItems,
    setIsLoadingMoreSavedItems,
    setSavedItemsOffset,
    shouldShowSavedSyncToolbarIndicator,
    syncProgressLabel,
  } = useExplorerVirtualData({
    applyFetchedThumbnailRef,
    attemptedChatDriveAutoIndexRef,
    currentPath,
    currentPathRef,
    filesRef,
    isOffline,
    isOfflineRef,
    refreshRecentPaths,
    setCurrentPath,
    setError,
    setFiles,
    setIsLoading,
    setSelectedFile,
  });

  const handleDirectoryScrollWithMemory = useCallback(
    (event: Parameters<typeof handleDirectoryScroll>[0]) => {
      rememberExplorerScrollPosition(
        currentPath,
        event.currentTarget.scrollTop,
      );
      handleDirectoryScroll(event);
    },
    [currentPath, handleDirectoryScroll],
  );

  const {
    breadcrumbsHomePath,
    closeDetailsPanel,
    handleToggleNameSort,
    handleViewModeChange,
    isDirectoryLoading,
    isLoadingSavedFiles,
    openDetailsPanel,
    sortDirection: activeSortDirection,
    sortField: activeSortField,
    sortedFiles,
    transferDownloadItem: transferDownloadItemBase,
  } = useExplorerControllerUi({
    activeDownload,
    contextMenuState,
    currentPath,
    detailsPanelCloseTimerRef,
    detailsPanelRef,
    downloadDetailMessage,
    downloadProgressPercent,
    downloadToolbarLabel,
    explorerHomePathRef,
    files,
    isDetailsPanelOpen,
    isLoading,
    isSavedBackfillSyncing,
    isTransferMenuOpen,
    search,
    selectedFile,
    selectedPaths,
    setSortDirection,
    setSortField,
    setContextMenuState,
    contextMenuRef,
    setIsDetailsPanelOpen,
    setIsSendingNoteMessage,
    setIsTransferMenuOpen,
    setNoteComposerValue,
    setSelectedFile,
    setSelectedPaths,
    setShowDetails,
    showDetails,
    sortDirection,
    sortField,
    transferMenuRef,
    transferMenuTriggerRef,
    uploadQueueItemsLength: uploadQueueItems.length,
    setViewMode,
  });

  const { handleOpenInNewTab } = useExplorerTabs({
    currentPath,
    explorerHomePathRef,
    currentPathRef,
    filesRef,
    savedItemsOffsetRef,
    hasMoreSavedItemsRef,
    selectedPathsRef,
    selectedFileRef,
    searchRef,
    navigationStateRef,
    explorerAreaRef,
    loadDirectoryRef,
    closeDetailsPanel,
    setContextMenuState,
    setError,
    setIsLoading,
    setIsLoadingMoreSavedItems,
    setSearch,
    setBackHistory,
    setForwardHistory,
    setFiles,
    setCurrentPath,
    setSavedItemsOffset,
    setHasMoreSavedItems,
    setSelectedPaths,
    setSelectedFile,
  });

  const {
    isMediaViewerOpen,
    mediaViewerThumbnailSrc,
    mediaViewerSrc,
    mediaViewerError,
    isMediaViewerLoading,
    isLocalImageViewerOpen,
    isLocalVideoViewerOpen,
    localVideoViewerFile,
    audioPlayerSrc,
    audioPlayerLoading,
    currentMediaViewerFile,
    currentMediaKind,
    canGoToPreviousMedia,
    canGoToNextMedia,
    currentLocalImageFile,
    localImageSrc,
    canGoToPreviousLocalImage,
    canGoToNextLocalImage,
    localVideoSrc,
    closeSavedMediaViewer,
    closeLocalImageViewer,
    closeLocalVideoViewer,
    closeAudioPlayer,
    openSavedMediaViewer,
    openLocalImageViewer,
    openLocalVideoViewer,
    openSavedAudioPlayer,
    openLocalAudioPlayer,
    applyFetchedThumbnail,
    isLocalImageFile,
    isLocalVideoFile,
    isLocalAudioFile,
    goToPreviousMedia,
    goToNextMedia,
    goToPreviousLocalImage,
    goToNextLocalImage,
  } = useExplorerMedia({
    currentPath,
    sortedFiles,
    selectedFile,
    setFiles,
    setSelectedFile,
    savedPathCacheRef,
  });

  isViewerOpenRef.current = {
    media: isMediaViewerOpen,
    localImage: isLocalImageViewerOpen || isLocalVideoViewerOpen,
  };
  closeViewerRef.current.closeMedia = closeSavedMediaViewer;
  closeViewerRef.current.closeLocalImage = () => {
    closeLocalVideoViewer();
    closeLocalImageViewer();
  };
  applyFetchedThumbnailRef.current = applyFetchedThumbnail;

  useEffect(() => {
    navigationStateRef.current = {
      backHistory,
      forwardHistory,
      currentPath,
      isLoading,
    };
    currentPathRef.current = currentPath;
  }, [backHistory, forwardHistory, currentPath, isLoading]);

  useEffect(() => {
    if (!currentPath) {
      return;
    }

    try {
      window.sessionStorage.setItem("skybox_last_explorer_path", currentPath);
    } catch {
      // ignore
    }
  }, [currentPath]);

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  useEffect(() => {
    selectedPathsRef.current = selectedPaths;
  }, [selectedPaths]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    updateExplorerSessionState({
      backHistory,
      currentPath,
      explorerHomePath,
      favorites,
      files,
      forwardHistory,
      hasMoreSavedItems,
      recentPaths,
      search,
      savedItemsOffset,
      selectedFile,
      selectedPaths,
      showFavorites,
      sortDirection,
      sortField,
      viewMode,
    });
    markExplorerHydrated();
  }, [
    backHistory,
    currentPath,
    explorerHomePath,
    favorites,
    files,
    forwardHistory,
    hasMoreSavedItems,
    recentPaths,
    search,
    savedItemsOffset,
    selectedFile,
    selectedPaths,
    showFavorites,
    sortDirection,
    sortField,
    viewMode,
  ]);

  useEffect(() => {
    rememberExplorerScrollPosition(
      currentPath,
      explorerAreaRef.current?.scrollTop ??
        getExplorerScrollPosition(currentPath),
    );
  }, [currentPath, explorerAreaRef]);

  useLayoutEffect(() => {
    const explorerArea = explorerAreaRef.current;
    if (!explorerArea || !currentPath || !files.length) {
      return;
    }

    if (!isExplorerRouteActive && !consumeExplorerScrollRestore(currentPath)) {
      return;
    }

    const nextScrollTop = getExplorerScrollPosition(currentPath);
    explorerArea.scrollTop = nextScrollTop;
  }, [currentPath, explorerAreaRef, files.length, isExplorerRouteActive]);

  useEffect(() => {
    setSelectedPaths((prev) => {
      if (!prev.length) {
        return prev;
      }

      const availablePaths = new Set(files.map((item) => item.path));
      const next = prev.filter((path) => availablePaths.has(path));
      if (next.length === prev.length) {
        return prev;
      }

      return next;
    });
  }, [files]);

  useEffect(() => {
    if (!selectedPaths.length) {
      if (selectedFile) {
        setSelectedFile(null);
      }
      return;
    }

    if (selectedFile && selectedPaths.includes(selectedFile.path)) {
      return;
    }

    const nextSelectedFile =
      files.find((item) => item.path === selectedPaths[0]) || null;
    setSelectedFile(nextSelectedFile);
  }, [files, selectedFile, selectedPaths]);

  useEffect(() => {
    if (selectedPaths.length > 1) {
      closeDetailsPanel();
    }
  }, [closeDetailsPanel, selectedPaths.length]);

  useEffect(() => {
    if (!contextMenuState) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        contextMenuRef.current &&
        target &&
        contextMenuRef.current.contains(target)
      ) {
        return;
      }
      setContextMenuState(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenuState(null);
      }
    };

    const handleViewportChange = () => {
      setContextMenuState(null);
    };

    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("blur", handleViewportChange);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("blur", handleViewportChange);
    };
  }, [contextMenuState]);

  useEffect(() => {
    if (!isTransferMenuOpen) {
      return;
    }

    const handleWindowClick = (event: MouseEvent) => {
      const target = event.target as Node | null;

      if (
        transferMenuRef.current &&
        target &&
        transferMenuRef.current.contains(target)
      ) {
        return;
      }

      if (
        transferMenuTriggerRef.current &&
        target &&
        transferMenuTriggerRef.current.contains(target)
      ) {
        return;
      }

      setIsTransferMenuOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsTransferMenuOpen(false);
      }
    };

    window.addEventListener("click", handleWindowClick);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("click", handleWindowClick);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isTransferMenuOpen]);

  useEffect(() => {
    if (activeDownload || uploadQueueItems.length > 0) {
      return;
    }

    setIsTransferMenuOpen(false);
  }, [activeDownload, uploadQueueItems.length]);

  useEffect(() => {
    if (!isNotesVirtualPath(currentPath)) {
      setNoteComposerValue("");
      setIsSendingNoteMessage(false);
    }
  }, [currentPath]);

  useEffect(() => {
    if (!showDetails) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        detailsPanelRef.current &&
        target &&
        detailsPanelRef.current.contains(target)
      ) {
        return;
      }

      closeDetailsPanel();
    };

    window.addEventListener("mousedown", handlePointerDown, true);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
    };
  }, [closeDetailsPanel, showDetails]);

  useEffect(() => {
    if (isRecycleBinPath(currentPath) && showDetails) {
      closeDetailsPanel();
    }
  }, [closeDetailsPanel, currentPath, showDetails]);

  useEffect(() => {
    setContextMenuState(null);
  }, [currentPath]);

  useExplorerBootstrap({
    initialRouteState: initialRouteStateRef.current,
    normalizeHomePathSetting,
    parseRecentsLimitSetting,
    parseSettingBool,
    setExplorerHomePath,
    explorerHomePathRef,
    explorerRecentsLimitRef,
    showFavoritesRef,
    confirmDeleteRef,
    confirmMoveRef,
    confirmRenameRef,
    setShowFavorites,
    setViewMode,
    loadDirectoryRef,
    refreshRecentPaths,
    loadFavorites,
    setFavorites,
    setUserInfo,
    loadProfilePhoto,
    loadUserInfo,
  });

  const isRecycleBinView = isRecycleBinPath(currentPath);
  const isGalleryView = isGalleryPath(currentPath);
  const deleteTarget = deleteTargets.length > 0 ? deleteTargets[0] : null;
  const isMultiDelete = deleteTargets.length > 1;
  const isSavedDeleteTarget =
    deleteTargets.length > 0 &&
    deleteTargets.every((target) => isSavedVirtualItemPath(target.path));
  const isPermanentDeleteTarget = isRecycleBinView && isSavedDeleteTarget;

  const {
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
  } = useExplorerSelectionContext({
    activePaste,
    clipboardItem,
    closeDetailsPanel,
    contextMenuState,
    currentPath,
    filesRef,
    isUploadInProgress,
    onOpenFile: (file) => handleFileOpenRef.current(file),
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
  });

  const {
    appendItemToCurrentView,
    handleConfirmEditNoteMessage,
    handleConfirmNewFolder,
    handleConfirmRename,
    handleCopyNoteText,
    handleCopyPath,
    handleDelete,
    handleDeleteNoteFromTelegram,
    handleDownloadSavedFile,
    handleEditNoteMessage,
    handleFileOpen,
    handleNewFolder,
    handlePaste,
    handleRefresh,
    handleRename,
    handleRestoreAllFromRecycleBin,
    handleRestoreFromRecycleBin,
    handleSendNoteMessage,
    handleShare,
    handleShareClose,
    handleShareToContact,
    handleStageClipboardItem,
    handleToggleFavorite,
    performRename,
  } = useExplorerFileActions({
    activeDownload,
    canCancelDownload,
    clipboardItem,
    closeDetailsPanel,
    confirmMoveRef,
    confirmRenameRef,
    contextMenuState,
    currentPath,
    currentPathRef,
    deleteTargets,
    files,
    filesRef,
    favorites,
    isNotesFolderView,
    isSendingNoteMessage,
    isLocalAudioFile,
    isLocalImageFile,
    isLocalVideoFile,
    loadDirectory,
    loadDirectoryRef,
    navigate: (path) => navigateToPathRef.current(path),
    noteComposerValue,
    noteEditTarget,
    noteEditValue,
    openLocalAudioPlayer,
    openLocalImageViewer,
    openLocalVideoViewer,
    openSavedAudioPlayer,
    openSavedMediaViewer,
    queueCloudSync,
    renameTarget,
    renameValue,
    requestDeleteTargets,
    requestStructureBackup,
    resetDownloadSpeedTracking,
    resetUploadSpeedTracking,
    savedPathCacheRef,
    selectedFile,
    selectedPaths,
    setActiveDownload,
    setActivePaste,
    setChatDriveCandidatesQuery,
    setClipboardItem,
    setDeleteTargets,
    setFiles,
    setFavorites,
    setIsNewFolderDialogOpen,
    setIsSendingNoteMessage,
    setNewFolderName,
    setNoteComposerValue,
    setNoteEditTarget,
    setNoteEditValue,
    setPendingMoveConfirm,
    setPendingRenameConfirm,
    setRenameTarget,
    setRenameValue,
    setSavedItemsOffset,
    setSelectedFile,
    setSelectedPaths,
    setShareTarget,
    setUploadConfirmDraft,
    setUploadPremiumUser,
    shareTarget,
    showFavoritesRef,
    trackDownloadSpeedSample,
    uploadManagerRef,
    uploadPremiumUser,
    explorerAreaRef,
    savedItemsOffset,
    hasMoreSavedItems,
    isSavedSyncComplete,
    newFolderName,
  } as any);
  handleFileOpenRef.current = handleFileOpen;

  const handleLogout = async () => {
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          "skybox_explicit_logout_in_progress",
          "1",
        );
      }

      // Logout from Telegram
      await invoke("tg_logout");

      // Clear session from database
      await invoke("db_clear_session");
      toast({ title: "Logged out" });
    } catch (error) {
      const typedError = error as TelegramError;
      console.error("Error during logout:", error);
      toast({
        title: "Logout error",
        description: typedError.message || "An error occurred during logout",
        variant: "destructive",
      });
    } finally {
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("skybox_explicit_logout_in_progress");
      }
    }
    navigate("/login");
  };

  const handleAddRoot = () => {
    toast({
      title: "Add folder",
      description: "This would open a folder picker in Tauri",
    });
  };

  const {
    handleCancelActiveDownload,
    handleCancelUploadQueue,
    handleConfirmUploadDraft,
    handleGetRecentChats,
    handleSearchContacts,
    handleToggleTransferMenu,
    handleUploadFiles,
  } = useExplorerControllerTransfers({
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
  });
  const transferDownloadItem = transferDownloadItemBase
    ? {
        ...transferDownloadItemBase,
        canCancel: canCancelDownload,
        onCancel: handleCancelActiveDownload,
      }
    : null;

  const {
    breadcrumbItems,
    handleGoBack,
    handleGoForward,
    handleNavigateToPath,
    navigateToPath,
  } = useExplorerNavigationInteractions({
    backHistory,
    clipboardItem,
    closeDetailsPanel,
    closeLocalImageViewer,
    closeLocalVideoViewer,
    closeSavedMediaViewer,
    currentPath,
    filesRef,
    forwardHistory,
    handleLogout,
    handlePaste,
    handleRefresh,
    handleStageClipboardItem,
    isRouteActive: isExplorerRouteActive,
    isLoading,
    isLocalImageViewerOpen,
    isLocalVideoViewerOpen,
    isMediaViewerOpen,
    loadDirectory,
    navigationStateRef,
    requestDeleteTargets,
    search,
    selectedFile,
    selectedPaths,
    setBackHistory,
    setForwardHistory,
    setSelectedFile,
    setSelectedPaths,
  });
  navigateToPathRef.current = navigateToPath;

  const {
    handleExplorerDragLeave,
    handleExplorerDragOver,
    handleExplorerDrop,
    handleExplorerMouseDown,
    handleItemDragEnd,
    handleItemDragLeave,
    handleItemDragOver,
    handleItemDragStart,
    handleItemDrop,
    isDraggableItem,
    recentDropTargetPath,
    selectionBox: dragSelectionBox,
  } = useExplorerDragInteractions({
    closeContextMenu,
    closeDetailsPanel,
    confirmMoveRef,
    currentPath,
    currentPathRef,
    files,
    filesRef,
    handleUploadFiles,
    isDirectoryLoading,
    loadDirectoryRef,
    queueCloudSync,
    requestStructureBackup,
    savedPathCacheRef,
    selectedFile,
    selectedPaths,
    setDropTargetPath,
    dropTargetPath,
    setDraggedPaths,
    draggedPaths,
    setIsExternalDragging,
    setPendingMoveConfirm,
    setSelectedFile,
    setSelectedPaths,
    setSelectionBox,
    selectionBox,
    setUploadConfirmDraft,
    sortedFiles,
    explorerAreaRef,
  });

  const handleOpenFolderSettings = useCallback(
    (targetFile?: FileItem | null) => {
      const file = targetFile ?? selectedFile;
      if (!file?.isDirectory) {
        return;
      }

      setFolderSettingsTarget(file);
    },
    [selectedFile, setFolderSettingsTarget],
  );

  const handleCloseFolderSettings = useCallback(() => {
    setFolderSettingsTarget(null);
  }, [setFolderSettingsTarget]);

  const handleFolderSettingsSaved = useCallback(async () => {
    setFolderSettingsTarget(null);
    await loadDirectory(currentPathRef.current, { force: true });
  }, [currentPathRef, loadDirectory, setFolderSettingsTarget]);

  return {
    currentPath,
    contextMenuState,
    closeContextMenu,
    favorites,
    recentPaths,
    showFavorites,
    explorerHomePath,
    userInfo,
    avatarUrl,
    audioPlayerSrc,
    audioPlayerLoading,
    closeAudioPlayer,
    backHistory,
    handleGoBack,
    forwardHistory,
    handleGoForward,
    handleRefresh,
    isLoading,
    breadcrumbItems,
    handleNavigateToPath,
    breadcrumbsHomePath,
    search,
    setSearch,
    isNotesFolderView,
    viewMode,
    handleViewModeChange,
    isRecycleBinView,
    isGalleryView,
    selectedFile,
    selectedPaths,
    handleNewFolder,
    handleCopyPath,
    handleRename,
    requestDeleteTargets,
    isOffline,
    shouldShowSavedSyncToolbarIndicator,
    isLoadingSavedFiles,
    isSavedSyncComplete,
    savedSyncStatusLabel,
    savedSyncPercent,
    syncProgressLabel,
    transferMenuTriggerRef,
    activeDownload,
    handleToggleTransferMenu,
    downloadToolbarLabel,
    downloadProgressPercent,
    isUploadProgressMounted,
    uploadToolbarItem,
    isUploadProgressVisible,
    uploadToolbarTitle,
    uploadToolbarLabel,
    uploadToolbarPercent,
    sortedFiles,
    sortField: activeSortField,
    sortDirection: activeSortDirection,
    handleToggleNameSort,
    hasTransferEntries,
    transferDownloadItem,
    transferUploadItems,
    canCancelUploads,
    handleCancelUploadQueue,
    isTransferMenuOpen,
    setIsTransferMenuOpen,
    transferMenuRef,
    explorerAreaRef,
    handleExplorerDragOver,
    handleExplorerDragLeave,
    handleExplorerDrop,
    handleDirectoryScroll: handleDirectoryScrollWithMemory,
    handleExplorerMouseDown,
    handleEmptyAreaContextMenu,
    isExternalDragging,
    selectionBox,
    selectionBoxStyle,
    error,
    loadDirectory,
    isDirectoryLoading,
    effectiveViewMode,
    hasVisibleItems,
    selectedPathSet,
    cutPathSet,
    handleFileSelect,
    handleFileOpen,
    handleFileContextMenu,
    isDraggableItem,
    draggedPaths,
    dropTargetPath,
    recentDropTargetPath,
    handleItemDragStart,
    handleItemDragEnd,
    handleItemDragOver,
    handleItemDragLeave,
    handleItemDrop,
    shouldShowUploadPlaceholder,
    uploadPlaceholderItem,
    uploadSkeletonCount,
    pasteSkeletonCount,
    isLoadingMoreSavedItems,
    noteComposerValue,
    setNoteComposerValue,
    handleSendNoteMessage,
    isSendingNoteMessage,
    showDetails,
    detailsPanelRef,
    isDetailsPanelOpen,
    closeDetailsPanel,
    handleToggleFavorite,
    toast,
    isMediaViewerOpen,
    currentMediaViewerFile,
    currentMediaKind,
    mediaViewerThumbnailSrc,
    mediaViewerSrc,
    isMediaViewerLoading,
    mediaViewerError,
    canGoToPreviousMedia,
    canGoToNextMedia,
    goToPreviousMedia,
    goToNextMedia,
    closeSavedMediaViewer,
    isLocalImageViewerOpen,
    currentLocalImageFile,
    localImageSrc,
    canGoToPreviousLocalImage,
    canGoToNextLocalImage,
    goToPreviousLocalImage,
    goToNextLocalImage,
    closeLocalImageViewer,
    isLocalVideoViewerOpen,
    localVideoViewerFile,
    localVideoSrc,
    closeLocalVideoViewer,
    contextMenuRef,
    clipboardItem,
    isNotesMessageContextMenu,
    isMultiSelectionContextMenu,
    contextTargetFile,
    canPasteInCurrentPath,
    handleContextOpen,
    handleOpenFolderSettings,
    handleOpenInNewTab,
    handleContextDelete,
    handleContextDetails,
    handlePaste,
    handleShare,
    handleCopyNoteText,
    handleEditNoteMessage,
    handleRestoreAllFromRecycleBin,
    handleRestoreFromRecycleBin,
    handleStageClipboardItem,
    handleDownloadSavedFile,
    handleDeleteNoteFromTelegram,
    isNewFolderDialogOpen,
    setIsNewFolderDialogOpen,
    newFolderName,
    setNewFolderName,
    handleConfirmNewFolder,
    folderSettingsTarget,
    handleCloseFolderSettings,
    handleFolderSettingsSaved,
    renameTarget,
    setRenameTarget,
    renameValue,
    setRenameValue,
    handleConfirmRename,
    noteEditTarget,
    setNoteEditTarget,
    noteEditValue,
    setNoteEditValue,
    handleConfirmEditNoteMessage,
    pendingMoveConfirm,
    setPendingMoveConfirm,
    pendingRenameConfirm,
    setPendingRenameConfirm,
    performRename,
    deleteTargets,
    setDeleteTargets,
    isPermanentDeleteTarget,
    isSavedDeleteTarget,
    isMultiDelete,
    deleteTarget,
    handleDelete,
    shareTarget,
    handleShareClose,
    handleShareToContact,
    handleSearchContacts,
    handleGetRecentChats,
    uploadConfirmDraft,
    uploadPremiumUser,
    setUploadConfirmDraft,
    handleConfirmUploadDraft,
    isChatDrivePickerOpen,
    chatDriveCandidates,
    isChatDriveCandidatesLoading,
    chatDriveCandidatesQuery,
    setChatDriveCandidatesQuery,
    pendingChatDriveCandidate,
    setPendingChatDriveCandidate,
    setIsChatDrivePickerOpen,
    handleConfirmChatDriveCandidate,
  };
}
