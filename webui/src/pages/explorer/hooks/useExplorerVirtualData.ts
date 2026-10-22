import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "@/hooks/use-toast";
import {
  mapFolderSettingsDto,
  normalizeFolderId,
  type FolderSettingsDto,
} from "@/lib/folder-settings";
import { resolveThumbnailSrc } from "@/lib/thumbnail-src";
import { type FileItem } from "@/components/skybox/FileRow";
import {
  cacheExplorerDirectory,
  getCachedExplorerDirectory,
  getExplorerSessionState,
} from "@/pages/explorer/explorerSessionStore";
import {
  isDirectoryCacheFresh,
  invalidateDirectoryCache,
  removeItemsFromCache,
} from "@/pages/explorer/explorerDirectoryCache";
import { useExplorerVirtualThumbnails } from "@/pages/explorer/hooks/explorerVirtualThumbnails";
import {
  GALLERY_VIRTUAL_PATH,
  SAVED_ITEMS_PAGE_SIZE,
  type FileEntry,
  type FsError,
  type SavedPathCacheEntry,
  type SyncSnapshotDto,
  type TelegramChatDriveItemsPage,
  type TelegramError,
  type TelegramIndexSavedMessagesResult,
  type TelegramMessage,
  type TelegramSavedItem,
  type TelegramSavedItemsPage,
  type TgUpdateEventPayload,
  convertFileEntryToFileItem,
  driveItemToFileItem,
  estimateSyncPercentFromIndexedCount,
  getSavedMediaKind,
  isGalleryPath,
  isDriveVirtualFolderPath,
  isSavedVirtualFilePath,
  isSavedVirtualFolderPath,
  mergeFileItemsByIdentity,
  normalizePath,
  parseDriveChatIdFromPath,
  savedToVirtualPath,
  savedItemToFileItem,
  telegramMessageToFileItem,
  virtualToSavedPath,
} from "@/pages/explorer/shared";

type UseExplorerVirtualDataArgs = {
  applyFetchedThumbnailRef: MutableRefObject<
    (messageId: number, thumbnailSrc: string) => void
  >;
  attemptedChatDriveAutoIndexRef: MutableRefObject<Set<number>>;
  currentPath: string;
  currentPathRef: MutableRefObject<string>;
  filesRef: MutableRefObject<FileItem[]>;
  isOffline: boolean;
  isOfflineRef: MutableRefObject<boolean>;
  refreshRecentPaths: () => Promise<void>;
  setCurrentPath: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setFiles: Dispatch<SetStateAction<FileItem[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setSelectedFile: Dispatch<SetStateAction<FileItem | null>>;
};

export function useExplorerVirtualData({
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
}: UseExplorerVirtualDataArgs) {
  const sessionState = getExplorerSessionState();
  const [savedItemsOffset, setSavedItemsOffset] = useState(0);
  const [hasMoreSavedItems, setHasMoreSavedItems] = useState(false);
  const [isLoadingMoreSavedItems, setIsLoadingMoreSavedItems] = useState(false);
  const [isSavedBackfillSyncing, setIsSavedBackfillSyncing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSavedSyncComplete, setIsSavedSyncComplete] = useState(false);
  const [savedSyncProgress, setSavedSyncProgress] = useState(0);
  const [showSavedUpToDateIndicator, setShowSavedUpToDateIndicator] =
    useState(false);
  const [showStartupSavedSync, setShowStartupSavedSync] = useState(false);

  const savedItemsOffsetRef = useRef(0);
  const hasMoreSavedItemsRef = useRef(false);
  const isLoadingMoreSavedItemsRef = useRef(false);
  const savedLoadMoreLastAttemptRef = useRef(0);
  const startupSyncRanRef = useRef(false);
  const savedPathCacheRef = useRef<Record<string, SavedPathCacheEntry>>(
    sessionState.directoryCache,
  );
  const loadAllSavedItemsRef = useRef<(path: string) => Promise<void>>(
    async () => {
      return;
    },
  );
  const loadSavedItemsPageRef = useRef<
    (path: string, offset: number, append: boolean) => Promise<void>
  >(async () => {
    return;
  });
  const loadChatDriveItemsPageRef = useRef<
    (path: string, offset: number, append: boolean) => Promise<void>
  >(async () => {
    return;
  });
  const loadDirectoryRef = useRef<
    (
      path: string,
      options?: { force?: boolean; background?: boolean }
    ) => Promise<void>
  >(async () => {
    return;
  });
  const savedUpToDateHideTimerRef = useRef<number | null>(null);
  const hasShownSavedUpToDateIndicatorRef = useRef(false);
  const lastSavedSyncProgressAtRef = useRef(0);
  const lastSavedIndexedCountRef = useRef<number>(0);
  const lastBackendSyncProgressRef = useRef(0);
  const lastTelegramSyncReloadAtRef = useRef<number>(0);
  const lastChatDriveAutoRefreshAtRef = useRef<number>(0);
  const hasReachedSavedUpToDateRef = useRef<boolean>(false);
  const { prefetchThumbnailsForItems } = useExplorerVirtualThumbnails({
    applyFetchedThumbnailRef,
    currentPathRef,
    filesRef,
  });

  const applySavedItemToActiveView = useCallback(
    (savedItem: TelegramSavedItem) => {
      const activePath = currentPathRef.current;
      if (!isSavedVirtualFolderPath(activePath)) {
        return;
      }

      const fileItem = savedItemToFileItem(savedItem);
      if (fileItem.isDirectory) {
        return;
      }

      const targetFolderPath = savedToVirtualPath(savedItem.file_path);
      const mediaKind = getSavedMediaKind(fileItem);
      const shouldApplyToGallery =
        activePath === GALLERY_VIRTUAL_PATH &&
        (mediaKind === "image" || mediaKind === "video");
      if (activePath !== targetFolderPath && !shouldApplyToGallery) {
        return;
      }

      const messageId = savedItem.message_id;
      const cacheEntry = savedPathCacheRef.current[activePath];
      const alreadyPresent =
        filesRef.current.some(
          (item) => item.messageId === messageId || item.path === fileItem.path,
        ) ||
        !!cacheEntry?.items.some(
          (item) => item.messageId === messageId || item.path === fileItem.path,
        );

      if (!alreadyPresent) {
        setFiles((prev) => mergeFileItemsByIdentity(prev, [fileItem]));
      }

      if (cacheEntry) {
        const merged = mergeFileItemsByIdentity(cacheEntry.items, [fileItem]);
        savedPathCacheRef.current[activePath] = {
          ...cacheEntry,
          items: merged,
          nextOffset: Math.max(cacheEntry.nextOffset, merged.length),
        };
      }

      if (!alreadyPresent && activePath === currentPathRef.current) {
        setSavedItemsOffset((prev) => Math.max(0, prev + 1));
      }

      void invoke<string | null>("tg_get_message_thumbnail", {
        messageId,
      })
        .then((thumbnailPath) => {
          const resolved = resolveThumbnailSrc(thumbnailPath);
          if (resolved) {
            applyFetchedThumbnailRef.current(messageId, resolved);
          }
        })
        .catch(() => {
          // ignore
        });
    },
    [applyFetchedThumbnailRef, currentPathRef, filesRef, setFiles],
  );

  const hydrateFolderSettings = useCallback(async (items: FileItem[]) => {
    const folderInputs = items
      .filter((item) => item.isDirectory)
      .map((item) => ({
        folderId: item.path,
        folderName: item.name,
      }));

    if (!folderInputs.length) {
      return items;
    }

    try {
      const rows = await invoke<FolderSettingsDto[]>(
        "folder_settings_bootstrap_many",
        {
          inputs: folderInputs,
        },
      );
      const settingsById = new Map(
        rows.map((row) => {
          const settings = mapFolderSettingsDto(row);
          return [normalizeFolderId(settings.folderId), settings] as const;
        }),
      );

      return items.map((item) => {
        if (!item.isDirectory) {
          return item;
        }

        return {
          ...item,
          folderSettings:
            settingsById.get(normalizeFolderId(item.path)) ||
            item.folderSettings ||
            null,
        };
      });
    } catch (error) {
      console.error("Failed to hydrate folder settings:", error);
      return items;
    }
  }, []);

  useEffect(() => {
    savedItemsOffsetRef.current = savedItemsOffset;
  }, [savedItemsOffset]);

  useEffect(() => {
    hasMoreSavedItemsRef.current = hasMoreSavedItems;
  }, [hasMoreSavedItems]);

  useEffect(() => {
    isLoadingMoreSavedItemsRef.current = isLoadingMoreSavedItems;
  }, [isLoadingMoreSavedItems]);

  const triggerSavedUpToDateIndicator = useCallback(() => {
    if (hasShownSavedUpToDateIndicatorRef.current) {
      return;
    }
    hasShownSavedUpToDateIndicatorRef.current = true;

    setShowSavedUpToDateIndicator(true);
    if (savedUpToDateHideTimerRef.current) {
      window.clearTimeout(savedUpToDateHideTimerRef.current);
    }
    savedUpToDateHideTimerRef.current = window.setTimeout(() => {
      setShowSavedUpToDateIndicator(false);
      savedUpToDateHideTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (savedUpToDateHideTimerRef.current) {
        window.clearTimeout(savedUpToDateHideTimerRef.current);
      }
    };
  }, []);

  const indexSavedMessages =
    useCallback(async (): Promise<TelegramIndexSavedMessagesResult | null> => {
      try {
        const result: TelegramIndexSavedMessagesResult = await invoke(
          "tg_index_saved_messages",
        );

        // Joining an in-flight run is expected on refresh, so it must be
        // checked before `notice`: it deliberately carries no notice *and* no
        // latest_message_id, which would otherwise trip the "No messages
        // found" branch below.
        if (result.already_running) {
          // Handled by the `account_sync_changed` snapshot the join publishes.
        } else if (result.notice) {
          toast({
            title: "Indexing issue",
            description: result.notice,
            variant: "destructive",
          });
        } else if (
          result.latest_message_id === 0 &&
          result.historical_sync_complete === false
        ) {
          toast({
            title: "No messages found",
            description:
              "The bot could not read the storage chat. Make sure it is an admin with Read Messages access, then retry.",
            variant: "destructive",
          });
        } else if (result.total_new_messages > 0) {
          setIsSavedSyncComplete(false);
          toast({
            title: "Saved Messages Synced",
            description: `Found ${result.total_new_messages} new item${result.total_new_messages === 1 ? "" : "s"}.`,
          });
        }

        return result;
      } catch (error) {
        console.error("Error indexing saved messages:", error);
        toast({
          title: "Indexing failed",
          description:
            error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
        return null;
      }
    }, []);

  const applySavedPathCache = useCallback(
    (path: string): boolean => {
      const cacheEntry = savedPathCacheRef.current[path];
      const sharedCacheEntry = cacheEntry ?? getCachedExplorerDirectory(path);
      if (!sharedCacheEntry) {
        return false;
      }

      savedPathCacheRef.current[path] = sharedCacheEntry;
      setFiles(sharedCacheEntry.items);
      setSavedItemsOffset(sharedCacheEntry.nextOffset);
      setHasMoreSavedItems(sharedCacheEntry.hasMore);
      setCurrentPath(path);
      prefetchThumbnailsForItems(sharedCacheEntry.items);
      return true;
    },
    [setCurrentPath, setFiles],
  );

  const cacheSavedPath = useCallback(
    (
      path: string,
      items: FileItem[],
      nextOffset: number,
      hasMore: boolean,
      isCompleteSnapshot: boolean,
    ) => {
      const snapshot = {
        items,
        nextOffset,
        hasMore,
        isCompleteSnapshot,
      };
      savedPathCacheRef.current[path] = snapshot;
      cacheExplorerDirectory(path, snapshot);
    },
    [],
  );

  const refreshVisibleFolderSettings = useCallback(
    async (path: string) => {
      if (currentPathRef.current !== path) {
        return;
      }

      const currentItems = filesRef.current;
      if (!currentItems.some((item) => item.isDirectory)) {
        return;
      }

      const hydratedItems = await hydrateFolderSettings(currentItems);
      if (currentPathRef.current !== path) {
        return;
      }

      setFiles(hydratedItems);
      setSelectedFile((previous) => {
        if (!previous?.isDirectory) {
          return previous;
        }

        return (
          hydratedItems.find((item) => item.path === previous.path) || previous
        );
      });

      if (path.startsWith("tg://saved")) {
        cacheSavedPath(
          path,
          hydratedItems,
          savedItemsOffsetRef.current,
          hasMoreSavedItemsRef.current,
          true,
        );
      }
    },
    [
      cacheSavedPath,
      currentPathRef,
      filesRef,
      hydrateFolderSettings,
      setFiles,
      setSelectedFile,
    ],
  );

  const loadSavedItemsPage = useCallback(
    async (path: string, offset: number, append: boolean) => {
      const savedPath = virtualToSavedPath(path);
      const result: TelegramSavedItemsPage = await invoke(
        "tg_list_saved_items_page",
        {
          filePath: savedPath,
          offset,
          limit: SAVED_ITEMS_PAGE_SIZE,
        },
      );

      const pageItems = result.items
        .map(savedItemToFileItem)
        .filter((item) => item.isDirectory || !!item.messageId);
      const hydratedPageItems = await hydrateFolderSettings(pageItems);
      const mergedItems = append
        ? [...filesRef.current, ...hydratedPageItems]
        : hydratedPageItems;
      setFiles(mergedItems);
      setSavedItemsOffset(result.next_offset);
      setHasMoreSavedItems(result.has_more);
      setCurrentPath(path);
      cacheSavedPath(
        path,
        mergedItems,
        result.next_offset,
        result.has_more,
        false,
      );
      prefetchThumbnailsForItems(mergedItems);
    },
    [
      cacheSavedPath,
      filesRef,
      hydrateFolderSettings,
      prefetchThumbnailsForItems,
      setCurrentPath,
      setFiles,
    ],
  );

  const loadChatDriveItemsPage = useCallback(
    async (path: string, offset: number, append: boolean) => {
      const chatId = parseDriveChatIdFromPath(path);
      if (!chatId) {
        throw new Error("Invalid drive path");
      }

      const result: TelegramChatDriveItemsPage = await invoke(
        "tg_list_chat_drive_items_page",
        {
          args: {
            chatId,
            offset,
            limit: SAVED_ITEMS_PAGE_SIZE,
          },
        },
      );

      const pageItems = await hydrateFolderSettings(
        (result.items || []).map(driveItemToFileItem),
      );

      if (offset === 0 && pageItems.length === 0) {
        if (!attemptedChatDriveAutoIndexRef.current.has(chatId)) {
          attemptedChatDriveAutoIndexRef.current.add(chatId);
          void invoke("tg_index_chat_drive", {
            args: {
              chatId,
              maxMessages: 25000,
            },
          }).catch(() => {
            // ignore
          });
        }
      }

      const mergedItems = append
        ? [...filesRef.current, ...pageItems]
        : pageItems;
      setFiles(mergedItems);
      setSavedItemsOffset(result.next_offset);
      setHasMoreSavedItems(result.has_more);
      setCurrentPath(path);
      cacheSavedPath(
        path,
        mergedItems,
        result.next_offset,
        result.has_more,
        false,
      );
      prefetchThumbnailsForItems(mergedItems);
    },
    [
      attemptedChatDriveAutoIndexRef,
      filesRef,
      hydrateFolderSettings,
      prefetchThumbnailsForItems,
      setCurrentPath,
      setFiles,
    ],
  );

  const loadAllSavedItems = useCallback(
    async (path: string) => {
      if (isGalleryPath(path)) {
        const [imageItems, videoItems] = await Promise.all([
          invoke<TelegramMessage[]>("tg_get_indexed_saved_messages", {
            category: "images",
          }),
          invoke<TelegramMessage[]>("tg_get_indexed_saved_messages", {
            category: "videos",
          }),
        ]);

        const galleryItems = mergeFileItemsByIdentity(
          imageItems.map(telegramMessageToFileItem),
          videoItems.map(telegramMessageToFileItem),
        )
          .filter((item) => {
            const mediaKind = getSavedMediaKind(item);
            return mediaKind === "image" || mediaKind === "video";
          })
          .sort((a, b) => {
            const aTime = new Date(a.modifiedAt || "").getTime();
            const bTime = new Date(b.modifiedAt || "").getTime();
            return bTime - aTime;
          });

        setFiles(galleryItems);
        setSavedItemsOffset(galleryItems.length);
        setHasMoreSavedItems(false);
        setCurrentPath(path);
        cacheSavedPath(path, galleryItems, galleryItems.length, false, true);
        prefetchThumbnailsForItems(galleryItems);
        return;
      }

      const savedPath = virtualToSavedPath(path);
      const result: TelegramSavedItem[] = await invoke("tg_list_saved_items", {
        filePath: savedPath,
      });

      const allItems = await hydrateFolderSettings(
        result.map(savedItemToFileItem),
      );
      setFiles(allItems);
      setSavedItemsOffset(allItems.length);
      setHasMoreSavedItems(false);
      setCurrentPath(path);
      cacheSavedPath(path, allItems, allItems.length, false, true);
      prefetchThumbnailsForItems(allItems);
    },
    [
      cacheSavedPath,
      hydrateFolderSettings,
      prefetchThumbnailsForItems,
      setCurrentPath,
      setFiles,
    ],
  );

  loadAllSavedItemsRef.current = loadAllSavedItems;
  loadSavedItemsPageRef.current = loadSavedItemsPage;
  loadChatDriveItemsPageRef.current = loadChatDriveItemsPage;

  const loadMoreVirtualItems = useCallback(async () => {
    if (
      !currentPath.startsWith("tg://saved") &&
      !isDriveVirtualFolderPath(currentPath)
    ) {
      return;
    }

    if (isGalleryPath(currentPath)) {
      return;
    }

    const now = Date.now();
    if (now - savedLoadMoreLastAttemptRef.current < 250) {
      return;
    }
    savedLoadMoreLastAttemptRef.current = now;

    if (isLoadingMoreSavedItemsRef.current) {
      return;
    }

    if (currentPath.startsWith("tg://saved")) {
      if (isSavedSyncComplete) {
        return;
      }
      if (!hasMoreSavedItemsRef.current && !isSavedBackfillSyncing) {
        return;
      }

      setIsLoadingMoreSavedItems(true);
      try {
        await loadSavedItemsPage(
          currentPath,
          savedItemsOffsetRef.current,
          true,
        );
      } catch (error) {
        console.error("Error loading more saved items:", error);
        setHasMoreSavedItems(false);
      } finally {
        setIsLoadingMoreSavedItems(false);
      }
      return;
    }

    if (!hasMoreSavedItemsRef.current) {
      return;
    }

    setIsLoadingMoreSavedItems(true);
    try {
      await loadChatDriveItemsPage(
        currentPath,
        savedItemsOffsetRef.current,
        true,
      );
    } catch (error) {
      console.error("Error loading more drive items:", error);
      setHasMoreSavedItems(false);
    } finally {
      setIsLoadingMoreSavedItems(false);
    }
  }, [
    currentPath,
    isSavedBackfillSyncing,
    isSavedSyncComplete,
    loadChatDriveItemsPage,
    loadSavedItemsPage,
  ]);

  const handleDirectoryScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (
        !currentPath.startsWith("tg://saved") &&
        !isDriveVirtualFolderPath(currentPath)
      ) {
        return;
      }

      const target = event.currentTarget;
      const reachedBottom =
        target.scrollTop + target.clientHeight >= target.scrollHeight - 120;
      if (reachedBottom) {
        void loadMoreVirtualItems();
      }
    },
    [currentPath, loadMoreVirtualItems],
  );

  const loadDirectory = useCallback(
    async (
      path: string,
      options?: { force?: boolean; background?: boolean },
    ) => {
      const forceReload = options?.force === true;
      // A background pass revalidates a stale cache entry without taking over
      // the spinner: the user is already looking at the cached listing.
      const isBackground = options?.background === true;
      if (!isBackground) {
        setError(null);
      }

      if (path && path !== currentPathRef.current) {
        currentPathRef.current = path;
        setCurrentPath(path);
      }

      // Record the visit before the cache shortcut: a served-from-cache local
      // directory is still a directory the user navigated to.
      if (!path.startsWith("tg://") && !isBackground) {
        void (async () => {
          try {
            await invoke("db_add_recent_path", { path });
            void refreshRecentPaths();
          } catch (error) {
            console.error("Error adding recent path:", error);
          }
        })();
      }

      if (!forceReload) {
        const hasCache = applySavedPathCache(path);
        if (hasCache) {
          const cacheEntry = savedPathCacheRef.current[path];
          if (
            path.startsWith("tg://saved") &&
            isSavedSyncComplete &&
            !cacheEntry.isCompleteSnapshot
          ) {
            void loadAllSavedItems(path).catch((error) => {
              console.error(
                "Error upgrading cached saved items view to full list:",
                error,
              );
            });
          } else if (!isDirectoryCacheFresh(path)) {
            // Serve the entry now, then refresh it silently so a revisit does
            // not show a spinner for data that is seconds old.
            void loadDirectoryRef
              .current(path, { force: true, background: true })
              .catch((error) => {
                console.error(
                  "Background directory revalidation failed:",
                  error,
                );
              });
          }
          return;
        }
      }

      if (!isBackground) {
        setIsLoading(true);
      }
      try {
        if (path.startsWith("tg://saved")) {
          setSavedItemsOffset(0);
          setHasMoreSavedItems(false);
          if (isGalleryPath(path) || isSavedSyncComplete) {
            await loadAllSavedItems(path);
          } else {
            await loadSavedItemsPage(path, 0, false);
          }
        } else if (isDriveVirtualFolderPath(path)) {
          setSavedItemsOffset(0);
          setHasMoreSavedItems(true);
          await loadChatDriveItemsPage(path, 0, false);
        } else {
          const result: FileEntry[] = await invoke("fs_list_dir", { path });
          const convertedFiles = await hydrateFolderSettings(
            result.map(convertFileEntryToFileItem),
          );
          if (!isBackground || currentPathRef.current === path) {
            setFiles(convertedFiles);
            setCurrentPath(path);
            setSavedItemsOffset(0);
            setHasMoreSavedItems(false);
          }
          cacheSavedPath(path, convertedFiles, 0, false, true);
        }
      } catch (error) {
        const typedError = error as FsError;
        // A background revalidation failing leaves the cached listing in place;
        // surfacing an error for data the user is already viewing would be noise.
        if (!isBackground) {
          setError(typedError.message || "An unknown error occurred");
          toast({
            title: "Error loading directory",
            description: typedError.message || "An unknown error occurred",
            variant: "destructive",
          });
        }
        console.error("Error loading directory:", error);
      } finally {
        if (!isBackground) {
          setIsLoading(false);
        }
      }
    },
    [
      applySavedPathCache,
      currentPathRef,
      isSavedSyncComplete,
      loadAllSavedItems,
      loadChatDriveItemsPage,
      loadSavedItemsPage,
      hydrateFolderSettings,
      refreshRecentPaths,
      setCurrentPath,
      setError,
      setFiles,
      setIsLoading,
    ],
  );

  loadDirectoryRef.current = loadDirectory;

  useEffect(() => {
    if (startupSyncRanRef.current || isOffline) {
      return;
    }

    startupSyncRanRef.current = true;

    let cancelled = false;

    const runSavedMessageSync = async () => {
      setShowStartupSavedSync(true);
      setIsConnecting(true);
      setIsSavedBackfillSyncing(true);
      setSavedSyncProgress(0);
      lastSavedSyncProgressAtRef.current = Date.now();
      lastBackendSyncProgressRef.current = 0;
      try {
        const syncResult = await indexSavedMessages();
        const complete = Boolean(syncResult?.historical_sync_complete);
        if (!cancelled) {
          setIsSavedSyncComplete(complete);
          setIsSavedBackfillSyncing(!complete);

          if (complete) {
            setSavedSyncProgress(100);
            setShowStartupSavedSync(false);
            triggerSavedUpToDateIndicator();
            setHasMoreSavedItems(false);
            if (currentPathRef.current.startsWith("tg://saved")) {
              await loadAllSavedItems(currentPathRef.current);
            }
          }
        }
      } catch (error) {
        console.error("Error syncing saved messages:", error);
        setSavedSyncProgress(0);
      } finally {
        if (!cancelled) {
          setIsConnecting(false);
        }
      }
    };

    void runSavedMessageSync();
    return () => {
      cancelled = true;
    };
  }, [
    indexSavedMessages,
    isOffline,
    loadAllSavedItems,
    currentPathRef,
    triggerSavedUpToDateIndicator,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const handleSnapshot = async (snapshot: SyncSnapshotDto) => {
      setIsConnecting(false);
      setShowStartupSavedSync((prev) => (prev ? false : prev));

      const state = snapshot.state;
      const hasProgressFields =
        typeof snapshot.indexed_count === "number" ||
        typeof snapshot.progress_percent === "number";
      const isNonIdleState = state !== "Idle";
      if (!hasProgressFields && !isNonIdleState) {
        return;
      }

      const progress = snapshot.progress_percent;
      const hasExplicitPercent =
        typeof progress === "number" && Number.isFinite(progress);
      const indexedCount =
        typeof snapshot.indexed_count === "number" &&
        snapshot.indexed_count >= 0
          ? snapshot.indexed_count
          : 0;

      // The backend's id-span percent is the real-time signal: it is now
      // published per item as the walk advances and never exceeds 99 until
      // the closing UpToDate snapshot. The indexed-count curve is only a
      // fallback for snapshots that carry no percent — on a small chat it
      // pins the bar to 1% no matter how much work is left.
      const realProgress = hasExplicitPercent
        ? progress
        : indexedCount > 0
          ? estimateSyncPercentFromIndexedCount(indexedCount)
          : 0;

      if (realProgress > 0 || hasExplicitPercent) {
        lastBackendSyncProgressRef.current = Math.max(
          lastBackendSyncProgressRef.current,
          realProgress,
        );
        setSavedSyncProgress((prev) => {
          const next =
            lastBackendSyncProgressRef.current > 0
              ? lastBackendSyncProgressRef.current
              : Math.max(prev, lastBackendSyncProgressRef.current);
          if (next !== prev) {
            lastSavedSyncProgressAtRef.current = Date.now();
          }
          return next;
        });
      } else if (state === "UpToDate") {
        setSavedSyncProgress(100);
        lastSavedSyncProgressAtRef.current = Date.now();
      }

      const wasUpToDate = hasReachedSavedUpToDateRef.current;
      if (state === "Syncing") {
        setIsSavedBackfillSyncing(true);
        // A new run invalidates any earlier "up to date" claim: keeping the
        // flag would show 100% while the walk is still running.
        setIsSavedSyncComplete(false);
      } else if (state === "UpToDate") {
        hasReachedSavedUpToDateRef.current = true;
        setIsSavedBackfillSyncing(false);
        setIsSavedSyncComplete(true);
        setSavedSyncProgress(100);
        triggerSavedUpToDateIndicator();
      } else if (state === "Idle") {
        if (hasReachedSavedUpToDateRef.current) {
          setIsSavedBackfillSyncing(false);
        }
      } else if (typeof state === "object" && state && "Error" in state) {
        const message = state.Error?.message || "Saved Messages sync failed";
        setIsSavedBackfillSyncing(false);
        if (!wasUpToDate) {
          setIsSavedSyncComplete(false);
        }

        const lowered = message.toLowerCase();
        if (!lowered.includes("(code 404)") && !lowered.includes("not found")) {
          toast({
            title: "Sync error",
            description: message,
            variant: "destructive",
          });
        }
      }

      const previousIndexed = lastSavedIndexedCountRef.current;
      lastSavedIndexedCountRef.current = indexedCount;

      const activePath = currentPathRef.current;
      if (!activePath.startsWith("tg://saved")) {
        return;
      }

      if (state === "UpToDate") {
        if (!wasUpToDate) {
          void loadAllSavedItemsRef.current(activePath);
        }
        return;
      }

      if (indexedCount > previousIndexed && filesRef.current.length === 0) {
        void loadSavedItemsPageRef.current(activePath, 0, false);
      }
    };

    listen<SyncSnapshotDto>("account_sync_changed", (event) => {
      void handleSnapshot(event.payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to listen for sync snapshots:", error);
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [currentPathRef, filesRef, triggerSavedUpToDateIndicator]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    type TelegramUpdatePayload = {
      message_id?: number | null;
      folder_kind?: string | null;
    };

    const folderKindToVirtualFolderPath = (
      folderKind?: string | null,
    ): string => {
      const normalized = (folderKind || "").toLowerCase().trim();
      const folderName =
        normalized === "images"
          ? "Images"
          : normalized === "videos"
            ? "Videos"
            : normalized === "audio"
              ? "Audio"
              : "Documents";
      return `tg://saved/${folderName}`;
    };

    listen("tg-update-received", (event) => {
      if (isOfflineRef.current) {
        return;
      }
      const now = Date.now();
      if (now - lastTelegramSyncReloadAtRef.current < 200) {
        return;
      }
      lastTelegramSyncReloadAtRef.current = now;

      const payload = event.payload as TelegramUpdatePayload | null;
      const messageId =
        payload &&
        typeof payload.message_id === "number" &&
        payload.message_id > 0
          ? payload.message_id
          : null;

      if (!messageId) {
        return;
      }

      const activePath = currentPathRef.current;
      if (!isSavedVirtualFolderPath(activePath)) {
        return;
      }

      const targetFolderPath = folderKindToVirtualFolderPath(
        payload?.folder_kind,
      );
      const shouldApplyToGallery =
        activePath === GALLERY_VIRTUAL_PATH &&
        (targetFolderPath === "tg://saved/Images" ||
          targetFolderPath === "tg://saved/Videos");
      if (activePath !== targetFolderPath && !shouldApplyToGallery) {
        return;
      }

      void invoke<TelegramSavedItem | null>("tg_get_saved_item_by_message_id", {
        messageId,
      })
        .then((savedItem) => {
          if (!savedItem) {
            return;
          }

          applySavedItemToActiveView(savedItem);
        })
        .catch((error) => {
          console.error("Failed to apply Telegram update:", error);
        });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to listen for Telegram updates:", error);
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [applySavedItemToActiveView, currentPathRef, isOfflineRef]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    type UploadIndexedPayload = {
      messageId?: number | null;
      filePath?: string | null;
    };

    listen<UploadIndexedPayload>("tg-upload-indexed", (event) => {
      if (isOfflineRef.current) {
        return;
      }

      const payload = event.payload;
      const messageId =
        payload &&
        typeof payload.messageId === "number" &&
        payload.messageId > 0
          ? payload.messageId
          : null;
      if (!messageId) {
        return;
      }

      const activePath = currentPathRef.current;

      // A drive upload: refetch that chat's live listing so the new message
      // appears with its real drive paths (no Mongo row involved).
      if (isDriveVirtualFolderPath(activePath)) {
        const uploadedChatId = payload.filePath
          ? parseDriveChatIdFromPath(payload.filePath)
          : null;
        const activeChatId = parseDriveChatIdFromPath(activePath);
        if (
          uploadedChatId &&
          activeChatId &&
          uploadedChatId === activeChatId
        ) {
          void loadChatDriveItemsPageRef.current(activePath, 0, false).catch(
            () => {
              // ignore
            },
          );
        }
        return;
      }

      if (!isSavedVirtualFolderPath(activePath)) {
        return;
      }

      const indexedFolderPath =
        typeof payload.filePath === "string" && payload.filePath.trim()
          ? savedToVirtualPath(payload.filePath)
          : null;
      if (
        indexedFolderPath &&
        activePath !== indexedFolderPath &&
        activePath !== GALLERY_VIRTUAL_PATH
      ) {
        return;
      }

      void invoke<TelegramSavedItem | null>("tg_get_saved_item_by_message_id", {
        messageId,
      })
        .then((savedItem) => {
          if (!savedItem) {
            return;
          }

          applySavedItemToActiveView(savedItem);
        })
        .catch((error) => {
          console.error("Failed to apply indexed upload:", error);
        });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to listen for indexed uploads:", error);
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [applySavedItemToActiveView, currentPathRef, isOfflineRef]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<TgUpdateEventPayload>("tg-update-received", (event) => {
      if (isOfflineRef.current) {
        return;
      }
      const payload = event.payload;
      if (!payload) {
        return;
      }

      const reason = payload.reason;
      if (
        reason !== "message_deleted" &&
        reason !== "messages_deleted" &&
        reason !== "message_filtered_out"
      ) {
        return;
      }

      const ids = Array.isArray(payload.message_ids)
        ? payload.message_ids
        : typeof payload.message_id === "number"
          ? [payload.message_id]
          : [];
      const normalizedIds = ids
        .map((value) => Math.floor(value))
        .filter((value) => Number.isFinite(value) && value > 0);
      if (
        !normalizedIds.length ||
        !currentPathRef.current.startsWith("tg://saved")
      ) {
        return;
      }

      const idSet = new Set(normalizedIds);
      setFiles((prev) =>
        prev.filter((item) => !(item.messageId && idSet.has(item.messageId))),
      );
      setSelectedFile((prev) =>
        prev && prev.messageId && idSet.has(prev.messageId) ? null : prev,
      );
      // A remote deletion affects that message in every folder it was listed
      // in. Saved-file paths are tg://msg/<id>, so filter by that path across
      // each cached listing instead of discarding them all.
      const removedItemPaths = normalizedIds.map((id) => `tg://msg/${id}`);
      removeItemsFromCache(removedItemPaths);
      const removedPathSet = new Set(removedItemPaths);
      savedPathCacheRef.current = Object.fromEntries(
        Object.entries(savedPathCacheRef.current).map(([dirPath, entry]) => [
          dirPath,
          {
            ...entry,
            items: entry.items.filter(
              (item) => !removedPathSet.has(item.path),
            ),
          },
        ]),
      );
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to listen for Telegram updates:", error);
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [currentPathRef, isOfflineRef, setFiles, setSelectedFile]);

  // The session store broadcasts removals (cut/drag moves, restores) so this
  // hook's own mirror cannot keep serving items that no longer exist.
  useEffect(() => {
    const handlePathsRemoved = (event: Event) => {
      const detail = (event as CustomEvent<{ paths?: unknown }>).detail;
      const paths = Array.isArray(detail?.paths)
        ? detail.paths
            .filter((path): path is string => typeof path === "string")
            .map((path) => normalizePath(path))
        : [];
      if (!paths.length) {
        return;
      }
      const removedPathSet = new Set(paths);
      savedPathCacheRef.current = Object.fromEntries(
        Object.entries(savedPathCacheRef.current).map(([dirPath, entry]) => [
          dirPath,
          {
            ...entry,
            items: entry.items.filter(
              (item) => !removedPathSet.has(normalizePath(item.path)),
            ),
          },
        ]),
      );
    };

    window.addEventListener(
      "skybox-explorer-paths-removed",
      handlePathsRemoved,
    );
    return () => {
      window.removeEventListener(
        "skybox-explorer-paths-removed",
        handlePathsRemoved,
      );
    };
  }, []);

  // Server-side truth for filesystem mutations: the backend publishes
  // fs-updated with the one directory it changed. Invalidate just that entry
  // (and revalidate it if it is on screen) rather than trusting optimistic
  // client-side guesses about what a 204 response produced.
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<{ path?: unknown }>("fs-updated", (event) => {
      const rawPath = event.payload?.path;
      if (typeof rawPath !== "string" || !rawPath) {
        return;
      }
      const changedPath = normalizePath(rawPath);
      invalidateDirectoryCache(changedPath);

      const cached = savedPathCacheRef.current[changedPath];
      if (cached) {
        delete savedPathCacheRef.current[changedPath];
      }

      if (
        normalizePath(currentPathRef.current) === changedPath &&
        !isOfflineRef.current
      ) {
        void loadDirectoryRef.current(changedPath, {
          force: true,
          background: true,
        }).catch((error) => {
          console.error("Reload after fs-updated failed:", error);
        });
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to listen for fs-updated:", error);
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [currentPathRef, isOfflineRef]);

  useEffect(() => {
    let unlisten: null | (() => void) = null;
    void (async () => {
      unlisten = await listen<{
        chat_id?: number;
        indexed_items?: number;
        done?: boolean;
      }>("tg-chat-drive-index-progress", (event) => {
        const payload = event.payload;
        const chatId = payload?.chat_id;
        if (
          typeof chatId !== "number" ||
          !Number.isFinite(chatId) ||
          chatId === 0
        ) {
          return;
        }

        const activePath = currentPathRef.current;
        if (!isDriveVirtualFolderPath(activePath)) {
          return;
        }

        const activeChatId = parseDriveChatIdFromPath(activePath);
        if (!activeChatId || activeChatId !== chatId) {
          return;
        }

        const now = Date.now();
        if (now - lastChatDriveAutoRefreshAtRef.current < 750) {
          return;
        }
        lastChatDriveAutoRefreshAtRef.current = now;

        const indexed =
          typeof payload.indexed_items === "number" &&
          payload.indexed_items >= 0
            ? payload.indexed_items
            : null;

        if (payload.done === true) {
          void loadChatDriveItemsPageRef
            .current(activePath, 0, false)
            .catch(() => {
              // ignore
            });
          return;
        }

        const visibleCount = filesRef.current.length;
        if (visibleCount === 0) {
          void loadChatDriveItemsPageRef
            .current(activePath, 0, false)
            .catch(() => {
              // ignore
            });
          return;
        }

        if (
          indexed !== null &&
          indexed > visibleCount &&
          !isLoadingMoreSavedItemsRef.current
        ) {
          void loadChatDriveItemsPageRef
            .current(activePath, savedItemsOffsetRef.current, true)
            .catch(() => {
              // ignore
            });
        }
      });
    })();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [currentPathRef, filesRef]);

  useEffect(() => {
    let unlisten: null | (() => void) = null;

    void (async () => {
      unlisten = await listen<{
        parent_id?: string | null;
        reason?: string | null;
      }>("explorer_entries_invalidated", (event) => {
        const parentId = event.payload?.parent_id?.trim();
        if (
          event.payload?.reason !== "folder_settings_scan_complete" ||
          !parentId ||
          parentId !== currentPathRef.current
        ) {
          return;
        }

        void refreshVisibleFolderSettings(parentId);
      });
    })();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [currentPathRef, refreshVisibleFolderSettings]);

  const isSavedSyncUiActive =
    currentPath.startsWith("tg://saved") &&
    (showStartupSavedSync || isConnecting || isSavedBackfillSyncing);
  const shouldShowSavedSyncToolbarIndicator =
    currentPath.startsWith("tg://saved") &&
    (isSavedSyncUiActive ||
      (isSavedSyncComplete && showSavedUpToDateIndicator));

  useEffect(() => {
    if (!isSavedSyncUiActive || isSavedSyncComplete) {
      return;
    }

    const interval = window.setInterval(() => {
      const now = Date.now();
      if (now - lastSavedSyncProgressAtRef.current < 1500) {
        return;
      }

      setSavedSyncProgress((prev) => {
        // Never creep past what the backend has actually reported. The creep
        // exists to fill the gap before the first real progress_percent lands;
        // once the backend has spoken, its number is the ceiling.
        const ceiling =
          lastBackendSyncProgressRef.current > 0
            ? lastBackendSyncProgressRef.current
            : 90;
        if (prev >= ceiling) {
          return prev;
        }

        const bump = prev < 10 ? 2 : 1;
        const next = Math.min(ceiling, prev + bump);
        if (next !== prev) {
          lastSavedSyncProgressAtRef.current = now;
        }
        return next;
      });
    }, 900);

    return () => {
      window.clearInterval(interval);
    };
  }, [isSavedSyncComplete, isSavedSyncUiActive]);

  const savedSyncPercent = isSavedSyncUiActive
    ? Math.min(99, Math.max(0, Math.round(savedSyncProgress)))
    : isSavedSyncComplete
      ? 100
      : Math.min(100, Math.max(0, Math.round(savedSyncProgress)));
  const syncProgressLabel = `${savedSyncPercent}%`;
  const savedSyncStatusLabel = isConnecting
    ? "Connecting..."
    : showStartupSavedSync || isSavedBackfillSyncing
      ? "Syncing..."
      : isSavedSyncComplete
        ? "Up to date"
        : "Not syncing";

  return {
    handleDirectoryScroll,
    hasMoreSavedItems,
    hasMoreSavedItemsRef,
    isConnecting,
    isLoadingMoreSavedItems,
    isLoadingMoreSavedItemsRef,
    isSavedBackfillSyncing,
    isSavedSyncComplete,
    loadAllSavedItemsRef,
    loadChatDriveItemsPageRef,
    loadDirectory,
    loadDirectoryRef,
    loadMoreVirtualItems,
    loadSavedItemsPageRef,
    savedItemsOffset,
    savedItemsOffsetRef,
    savedPathCacheRef,
    savedSyncPercent,
    savedSyncStatusLabel,
    setHasMoreSavedItems,
    setIsLoadingMoreSavedItems,
    setSavedItemsOffset,
    shouldShowSavedSyncToolbarIndicator,
    showStartupSavedSync,
    syncProgressLabel,
  };
}
