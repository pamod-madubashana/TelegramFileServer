import {
  useEffect,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type DragEventHandler,
  type MouseEvent,
  type MouseEventHandler,
  type RefObject,
  type SetStateAction,
  type UIEventHandler,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useLocation, useNavigate } from "react-router-dom";
import { ExplorerSidebar } from "@/components/skybox/ExplorerSidebar";
import { SearchBar } from "@/components/skybox/SearchBar";
import { Breadcrumbs } from "@/components/skybox/Breadcrumbs";
import {
  FileRow,
  formatFileSize,
  type FileItem,
} from "@/components/skybox/FileRow";
import { FileGrid } from "@/components/skybox/FileGrid";
import { MiniAudioPlayer } from "@/components/skybox/MiniAudioPlayer";
import { TelegramButton } from "@/components/skybox/TelegramButton";
import { TransferListPopover } from "@/components/skybox/TransferListPopover";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit3,
  FolderPlus,
  Grid,
  List,
  RefreshCw,
  RotateCcw,
  Settings,
  SortAsc,
  Trash2,
} from "lucide-react";
import { type SettingsRouteState } from "@/pages/explorer/explorerSessionStore";
import type {
  DownloadProgressPayload,
  ExplorerContextMenuState,
  ExplorerSortDirection,
  ExplorerSortField,
  ExplorerViewMode,
  SelectionBoxState,
  UploadQueueItemState,
  UserInfo,
} from "@/pages/explorer/shared";

interface TransferDownloadItem {
  fileName: string;
  statusLabel: string;
  detailMessage?: string | null;
  progressPercent: number;
  canCancel: boolean;
  onCancel: () => void;
}

interface TransferUploadItem {
  id: string;
  fileName: string;
  statusLabel: string;
  message?: string;
  progress: number;
  isInProgress: boolean;
  trailingLabel: string;
}

interface ExplorerMainPaneProps {
  currentPath: string;
  contextMenuState: ExplorerContextMenuState | null;
  onRootClick: () => void;
  favoritePaths: string[];
  recentPaths: string[];
  showFavorites: boolean;
  homePath: string;
  userInfo: UserInfo | null;
  avatarUrl: string | null;
  audioPlayerSrc: string | null;
  audioPlayerLoading: boolean;
  onCloseAudioPlayer: () => void;
  backHistoryLength: number;
  onGoBack: () => void;
  forwardHistoryLength: number;
  onGoForward: () => void;
  onRefresh: () => void;
  isLoading: boolean;
  breadcrumbItems: Array<{ name: string; path: string }>;
  onNavigateToPath: (path: string) => void;
  breadcrumbsHomePath: string;
  search: string;
  onSearchChange: Dispatch<SetStateAction<string>>;
  isNotesFolderView: boolean;
  viewMode: ExplorerViewMode;
  onViewModeChange: (mode: ExplorerViewMode) => void;
  sortField: ExplorerSortField;
  sortDirection: ExplorerSortDirection;
  onToggleNameSort: () => void;
  isRecycleBinView: boolean;
  isGalleryView: boolean;
  selectedFile: FileItem | null;
  selectedPaths: string[];
  onNewFolder: () => void;
  onCopyPath: () => void;
  onRename: () => void;
  onRequestDeleteTargets: (targets: FileItem[]) => void;
  onRestoreAllFromRecycleBin: () => void;
  onEmptyRecycleBin: () => void;
  isOffline: boolean;
  shouldShowSavedSyncToolbarIndicator: boolean;
  isLoadingSavedFiles: boolean;
  isSavedSyncComplete: boolean;
  savedSyncStatusLabel: string;
  savedSyncPercent: number;
  syncProgressLabel: string;
  transferMenuTriggerRef: RefObject<HTMLDivElement | null>;
  activeDownload: DownloadProgressPayload | null;
  onToggleTransferMenu: () => void;
  downloadToolbarLabel: string;
  downloadProgressPercent: number;
  isUploadProgressMounted: boolean;
  uploadToolbarItem: UploadQueueItemState | null;
  isUploadProgressVisible: boolean;
  uploadToolbarTitle: string;
  uploadToolbarLabel: string;
  uploadToolbarPercent: number;
  sortedFiles: FileItem[];
  hasTransferEntries: boolean;
  transferDownloadItem: TransferDownloadItem | null;
  transferUploadItems: TransferUploadItem[];
  canCancelUploads: boolean;
  onCancelUploadQueue: () => void;
  isTransferMenuOpen: boolean;
  setIsTransferMenuOpen: Dispatch<SetStateAction<boolean>>;
  transferMenuRef: RefObject<HTMLDivElement | null>;
  explorerAreaRef: RefObject<HTMLDivElement | null>;
  onExplorerDragOver: DragEventHandler<HTMLDivElement>;
  onExplorerDragLeave: DragEventHandler<HTMLDivElement>;
  onExplorerDrop: DragEventHandler<HTMLDivElement>;
  onDirectoryScroll: UIEventHandler<HTMLDivElement>;
  onExplorerMouseDown: MouseEventHandler<HTMLDivElement>;
  onEmptyAreaContextMenu: MouseEventHandler<HTMLDivElement>;
  isExternalDragging: boolean;
  selectionBox: SelectionBoxState | null;
  selectionBoxStyle: CSSProperties | null;
  error: string | null;
  onRetry: () => void;
  isDirectoryLoading: boolean;
  effectiveViewMode: ExplorerViewMode;
  hasVisibleItems: boolean;
  onClearSearch: () => void;
  selectedPathSet: Set<string>;
  cutPathSet?: Set<string>;
  onFileSelect: (file: FileItem, event?: MouseEvent<HTMLDivElement>) => void;
  onFileOpen: (file: FileItem) => void;
  onFileContextMenu: (event: MouseEvent, file: FileItem) => void;
  isDraggableItem: (file: FileItem) => boolean;
  draggedPaths: string[];
  dropTargetPath: string | null;
  recentDropTargetPath: string | null;
  onItemDragStart: (event: DragEvent, file: FileItem) => void;
  onItemDragEnd: (event: DragEvent) => void;
  onItemDragOver: (event: DragEvent, file: FileItem) => void;
  onItemDragLeave: (file: FileItem) => void;
  onItemDrop: (event: DragEvent, file: FileItem) => void;
  shouldShowUploadPlaceholder: boolean;
  uploadPlaceholderItem: UploadQueueItemState | null;
  uploadSkeletonCount: number;
  pasteSkeletonCount: number;
  isLoadingMoreSavedItems: boolean;
  noteComposerValue: string;
  onNoteComposerChange: Dispatch<SetStateAction<string>>;
  onSendNoteMessage: () => void;
  isSendingNoteMessage: boolean;
}

export function ExplorerMainPane({
  currentPath,
  contextMenuState,
  onRootClick,
  favoritePaths,
  recentPaths,
  showFavorites,
  homePath,
  userInfo,
  avatarUrl,
  audioPlayerSrc,
  audioPlayerLoading,
  onCloseAudioPlayer,
  backHistoryLength,
  onGoBack,
  forwardHistoryLength,
  onGoForward,
  onRefresh,
  isLoading,
  breadcrumbItems,
  onNavigateToPath,
  breadcrumbsHomePath,
  search,
  onSearchChange,
  isNotesFolderView,
  viewMode,
  onViewModeChange,
  sortField,
  sortDirection,
  onToggleNameSort,
  isRecycleBinView,
  isGalleryView,
  selectedFile,
  selectedPaths,
  onNewFolder,
  onCopyPath,
  onRename,
  onRequestDeleteTargets,
  onRestoreAllFromRecycleBin,
  onEmptyRecycleBin,
  isOffline,
  shouldShowSavedSyncToolbarIndicator,
  isLoadingSavedFiles,
  isSavedSyncComplete,
  savedSyncStatusLabel,
  savedSyncPercent,
  syncProgressLabel,
  transferMenuTriggerRef,
  activeDownload,
  onToggleTransferMenu,
  downloadToolbarLabel,
  downloadProgressPercent,
  isUploadProgressMounted,
  uploadToolbarItem,
  isUploadProgressVisible,
  uploadToolbarTitle,
  uploadToolbarLabel,
  uploadToolbarPercent,
  sortedFiles,
  hasTransferEntries,
  transferDownloadItem,
  transferUploadItems,
  canCancelUploads,
  onCancelUploadQueue,
  isTransferMenuOpen,
  setIsTransferMenuOpen,
  transferMenuRef,
  explorerAreaRef,
  onExplorerDragOver,
  onExplorerDragLeave,
  onExplorerDrop,
  onDirectoryScroll,
  onExplorerMouseDown,
  onEmptyAreaContextMenu,
  isExternalDragging,
  selectionBox,
  selectionBoxStyle,
  error,
  onRetry,
  isDirectoryLoading,
  effectiveViewMode,
  hasVisibleItems,
  onClearSearch,
  selectedPathSet,
  cutPathSet,
  onFileSelect,
  onFileOpen,
  onFileContextMenu,
  isDraggableItem,
  draggedPaths,
  dropTargetPath,
  recentDropTargetPath,
  onItemDragStart,
  onItemDragEnd,
  onItemDragOver,
  onItemDragLeave,
  onItemDrop,
  shouldShowUploadPlaceholder,
  uploadPlaceholderItem,
  uploadSkeletonCount,
  pasteSkeletonCount,
  isLoadingMoreSavedItems,
  noteComposerValue,
  onNoteComposerChange,
  onSendNoteMessage,
  isSendingNoteMessage,
}: ExplorerMainPaneProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [appVersion, setAppVersion] = useState("...");

  const openSettings = () => {
    navigate("/settings/explorer", {
      state: {
        fromExplorer: true,
        returnTo: `${location.pathname}${location.search}${location.hash}`,
      } satisfies SettingsRouteState,
    });
  };
  const selectedItems = sortedFiles.filter((file) =>
    selectedPathSet.has(file.path),
  );
  const selectedItemsCount = selectedItems.length;
  const selectedItemsSize = selectedItems.reduce(
    (total, file) => total + (file.size || 0),
    0,
  );

  useEffect(() => {
    let cancelled = false;

    const loadVersion = async () => {
      try {
        const version = await getVersion();
        if (!cancelled) {
          setAppVersion(version);
        }
      } catch {
        if (!cancelled) {
          setAppVersion("unknown");
        }
      }
    };

    void loadVersion();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="relative h-full flex flex-col overflow-hidden"
      onClick={onRootClick}
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ExplorerSidebar
          currentPath={currentPath}
          favoritePaths={favoritePaths}
          recentPaths={recentPaths}
          showFavorites={showFavorites}
          homePath={homePath}
          userInfo={userInfo}
          avatarUrl={avatarUrl}
          bottomSlot={
            audioPlayerSrc || audioPlayerLoading ? (
              <MiniAudioPlayer
                src={audioPlayerSrc}
                isLoading={audioPlayerLoading}
                onClose={onCloseAudioPlayer}
              />
            ) : null
          }
        />

        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-14 bg-glass border-b border-border flex items-center justify-between px-4 gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={onGoBack}
                className="p-2 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
                disabled={!backHistoryLength}
                title="Back (Mouse Back / Alt+Left)"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={onGoForward}
                className="p-2 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-40"
                disabled={!forwardHistoryLength}
                title="Forward (Mouse Forward / Alt+Right)"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                onClick={onRefresh}
                className="p-2 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                disabled={isLoading}
                title="Refresh (Ctrl+R)"
              >
                <RefreshCw
                  className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
                />
              </button>
              <Breadcrumbs
                items={breadcrumbItems}
                onNavigate={onNavigateToPath}
                homePath={breadcrumbsHomePath}
              />
            </div>

            <div className="flex items-center gap-2">
              <SearchBar
                value={search}
                onChange={onSearchChange}
                placeholder="Search files..."
              />
              <button
                type="button"
                onClick={openSettings}
                className="p-2 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                aria-label="Open settings"
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>

          {!isGalleryView ? (
            <div className="h-12 bg-glass border-b border-border flex items-center justify-between px-4">
              <div className="flex items-center gap-2">
                {isRecycleBinView && (
                  <>
                    <TelegramButton
                      variant="secondary"
                      size="sm"
                      onClick={onRestoreAllFromRecycleBin}
                      disabled={!sortedFiles.length}
                    >
                      <RotateCcw className="w-4 h-4" />
                      Restore All
                    </TelegramButton>

                    <TelegramButton
                      variant="danger"
                      size="sm"
                      onClick={onEmptyRecycleBin}
                      disabled={!sortedFiles.length}
                    >
                      <Trash2 className="w-4 h-4" />
                      Empty Bin
                    </TelegramButton>
                  </>
                )}

                {!isRecycleBinView && !isNotesFolderView && (
                  <TelegramButton
                    variant="secondary"
                    size="sm"
                    onClick={onNewFolder}
                  >
                    <FolderPlus className="w-4 h-4" />
                    New Folder
                  </TelegramButton>
                )}

                {selectedFile &&
                  selectedPaths.length === 1 &&
                  !isRecycleBinView && (
                    <>
                      <TelegramButton
                        variant="secondary"
                        size="sm"
                        onClick={onCopyPath}
                        aria-label="Copy path (Ctrl+C)"
                      >
                        <Copy className="w-4 h-4" />
                      </TelegramButton>

                      <TelegramButton
                        variant="secondary"
                        size="sm"
                        onClick={onRename}
                        aria-label="Rename (F2)"
                      >
                        <Edit3 className="w-4 h-4" />
                      </TelegramButton>

                      <TelegramButton
                        variant="secondary"
                        size="sm"
                        onClick={() => onRequestDeleteTargets([selectedFile])}
                        aria-label="Delete (Del)"
                      >
                        <Trash2 className="w-4 h-4" />
                      </TelegramButton>
                    </>
                  )}
              </div>

              <div className="relative flex items-center gap-2 min-w-0">
                {isOffline && (
                  <span className="shrink-0 whitespace-nowrap text-small text-muted-foreground inline-flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                    <span>Connecting...</span>
                  </span>
                )}
                {shouldShowSavedSyncToolbarIndicator && (
                  <span className="shrink-0 whitespace-nowrap text-small text-muted-foreground inline-flex items-center gap-2">
                    {isLoadingSavedFiles ? (
                      <div className="animate-spin rounded-full h-3 w-3 border-b border-primary" />
                    ) : (
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          isSavedSyncComplete
                            ? "bg-emerald-400/80"
                            : "bg-primary animate-pulse"
                        }`}
                      />
                    )}
                    <span>{savedSyncStatusLabel}</span>
                    <Progress
                      value={savedSyncPercent}
                      className="h-1.5 w-20 bg-secondary/60"
                      aria-label="Saved Messages sync progress"
                    />
                    <span className="tabular-nums">{syncProgressLabel}</span>
                  </span>
                )}
                <div
                  ref={transferMenuTriggerRef}
                  className="flex items-center gap-2 min-w-0"
                >
                  {activeDownload && (
                    <button
                      type="button"
                      onClick={onToggleTransferMenu}
                      className="mr-1 flex items-center gap-2 min-w-[220px] rounded-md px-1.5 py-1 transition-colors hover:bg-secondary/40"
                    >
                      <span
                        className="max-w-[130px] truncate text-small text-muted-foreground"
                        title={`${activeDownload.fileName} - ${downloadToolbarLabel}`}
                      >
                        {downloadToolbarLabel}
                      </span>
                      <Progress
                        value={downloadProgressPercent}
                        className="h-1.5 w-24 bg-secondary/60"
                        aria-label="Download progress"
                      />
                      <span className="w-9 text-right text-small text-muted-foreground tabular-nums">
                        {downloadProgressPercent}%
                      </span>
                    </button>
                  )}
                  {isUploadProgressMounted && uploadToolbarItem && (
                    <button
                      type="button"
                      onClick={onToggleTransferMenu}
                      className={`mr-1 flex items-center gap-2 min-w-[220px] rounded-md px-1.5 py-1 transform-gpu transition-all duration-200 ease-out hover:bg-secondary/40 ${
                        isUploadProgressVisible
                          ? "translate-y-0 opacity-100"
                          : "-translate-y-3 opacity-0"
                      }`}
                    >
                      <span
                        className="max-w-[130px] truncate text-small text-muted-foreground"
                        title={uploadToolbarTitle}
                      >
                        {uploadToolbarLabel}
                      </span>
                      <Progress
                        value={uploadToolbarPercent}
                        className="h-1.5 w-24 bg-secondary/60"
                        aria-label={`Upload progress for ${uploadToolbarItem.fileName}`}
                      />
                      <span className="w-9 text-right text-small text-muted-foreground tabular-nums">
                        {uploadToolbarPercent}%
                      </span>
                    </button>
                  )}
                </div>
                {!isGalleryView ? (
                  <button
                    type="button"
                    onClick={onToggleNameSort}
                    className="flex items-center gap-1 px-2 py-1 rounded text-small text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  >
                    <SortAsc className="w-3 h-3" />
                    {sortField === "name" && sortDirection === "desc"
                      ? "Name Z-A"
                      : "Name"}
                  </button>
                ) : null}
                <span className="text-small text-muted-foreground">
                  {sortedFiles.length}{" "}
                  {sortedFiles.length === 1 ? "item" : "items"}
                </span>

                {isTransferMenuOpen && hasTransferEntries && (
                  <TransferListPopover
                    ref={transferMenuRef}
                    downloadItem={transferDownloadItem}
                    uploadSummaryLabel={uploadToolbarLabel}
                    uploadItems={transferUploadItems}
                    canCancelUploads={canCancelUploads}
                    onCancelUploads={onCancelUploadQueue}
                    onClose={() => setIsTransferMenuOpen(false)}
                  />
                )}
              </div>
            </div>
          ) : null}

          <div className="flex-1 flex min-h-0">
            <div className="relative flex-1 min-w-0 flex flex-col">
              <div
                ref={explorerAreaRef}
                className={`explorer-surface relative flex-1 overflow-y-auto p-4 ${isNotesFolderView ? "pb-3" : ""}`}
                onDragOver={onExplorerDragOver}
                onDragLeave={onExplorerDragLeave}
                onDrop={onExplorerDrop}
                onScroll={onDirectoryScroll}
                onMouseDown={onExplorerMouseDown}
                onContextMenu={onEmptyAreaContextMenu}
              >
                {isExternalDragging && (
                  <div className="pointer-events-none absolute inset-4 z-20 rounded-xl border-2 border-dashed border-primary/60 bg-primary/10 px-6 py-5">
                    <div className="flex h-full items-center justify-center">
                      <p className="text-body font-medium text-foreground">
                        Drop files here to upload to Saved Messages
                      </p>
                    </div>
                  </div>
                )}

                {selectionBox && selectionBoxStyle && (
                  <div
                    className="pointer-events-none absolute z-[60] rounded-md border border-primary/50 bg-primary/15"
                    style={selectionBoxStyle}
                  />
                )}

                {error ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <p className="text-body text-destructive mb-2">
                      Error: {error}
                    </p>
                    <TelegramButton onClick={onRetry}>Retry</TelegramButton>
                  </div>
                ) : isDirectoryLoading ? (
                  <div className="h-full">
                    {effectiveViewMode === "list" ? (
                      isNotesFolderView ? (
                        <div className="space-y-2">
                          {Array.from({ length: 10 }).map((_, index) => (
                            <div
                              key={`list-skeleton-${index}`}
                              className="px-2 py-1"
                            >
                              <div className="ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-primary/18 px-3 py-2">
                                <Skeleton className="skeleton-shimmer animate-none h-4 w-[72%] bg-primary/32" />
                                <Skeleton className="skeleton-shimmer animate-none h-4 w-[58%] mt-1.5 bg-primary/26" />
                                <Skeleton className="skeleton-shimmer animate-none h-3 w-14 mt-2 ml-auto bg-primary/20" />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {Array.from({ length: 10 }).map((_, index) => (
                            <div
                              key={`list-skeleton-${index}`}
                              className="flex items-center gap-3 px-3 py-1 rounded-lg bg-secondary/20"
                            >
                              <Skeleton className="skeleton-shimmer animate-none h-8 w-8 rounded-md bg-secondary/55" />
                              <Skeleton className="skeleton-shimmer animate-none h-4 flex-1 max-w-[45%] bg-secondary/45" />
                              <Skeleton className="skeleton-shimmer animate-none h-3 w-14 bg-secondary/40" />
                              <Skeleton className="skeleton-shimmer animate-none h-3 w-16 bg-secondary/40" />
                            </div>
                          ))}
                        </div>
                      )
                    ) : (
                      <div
                        className={
                          isGalleryView
                            ? "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-0"
                            : "grid [grid-template-columns:repeat(auto-fill,minmax(8.75rem,8.75rem))] justify-start gap-2"
                        }
                      >
                        {Array.from({ length: 12 }).map((_, index) => (
                          <div
                            key={`grid-skeleton-${index}`}
                            className={
                              isGalleryView
                                ? "aspect-square bg-secondary/20"
                                : "flex flex-col items-center p-2 rounded-xl bg-secondary/20"
                            }
                          >
                            <Skeleton
                              className={
                                isGalleryView
                                  ? "skeleton-shimmer animate-none h-full w-full rounded-none bg-secondary/40"
                                  : "skeleton-shimmer animate-none h-24 w-24 rounded-lg bg-secondary/50"
                              }
                            />
                            {!isGalleryView ? (
                              <>
                                <Skeleton className="skeleton-shimmer animate-none h-4 w-20 mt-3 bg-secondary/45" />
                                <Skeleton className="skeleton-shimmer animate-none h-3 w-12 mt-1.5 bg-secondary/40" />
                              </>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : !hasVisibleItems ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <p className="text-body text-muted-foreground mb-2">
                      {search
                        ? "No files match your search"
                        : isRecycleBinView
                          ? "Recycle bin is empty"
                          : "This folder is empty"}
                    </p>
                    {search && (
                      <button
                        onClick={onClearSearch}
                        className="text-body text-link mt-2"
                      >
                        Clear search
                      </button>
                    )}
                  </div>
                ) : (
                  <div
                    className={
                      effectiveViewMode === "list"
                        ? isNotesFolderView
                          ? "space-y-1.5"
                          : "space-y-0.5"
                        : isGalleryView
                          ? ""
                          : "p-1"
                    }
                  >
                    {effectiveViewMode === "list" ? (
                      <>
                        {sortedFiles.map((file) => (
                          <FileRow
                            key={file.path}
                            file={file}
                            isSelected={selectedPathSet.has(file.path)}
                            isCutItem={
                              cutPathSet ? cutPathSet.has(file.path) : false
                            }
                            onSelect={(event) => onFileSelect(file, event)}
                            onOpen={() => onFileOpen(file)}
                            onContextMenu={(event) =>
                              onFileContextMenu(event, file)
                            }
                            draggable={isDraggableItem(file)}
                            isDragging={draggedPaths.includes(file.path)}
                            isDropTarget={dropTargetPath === file.path}
                            isDropSuccess={recentDropTargetPath === file.path}
                            onDragStart={(event) =>
                              onItemDragStart(event, file)
                            }
                            onDragEnd={onItemDragEnd}
                            onDragOver={(event) => onItemDragOver(event, file)}
                            onDragLeave={() => onItemDragLeave(file)}
                            onDrop={(event) => onItemDrop(event, file)}
                          />
                        ))}

                        {shouldShowUploadPlaceholder ? (
                          <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-secondary/20">
                            <Skeleton className="skeleton-shimmer h-8 w-8 rounded-md bg-secondary/55" />
                            <div className="flex-1 min-w-0">
                              <p className="text-body text-foreground truncate">
                                {uploadPlaceholderItem?.fileName ||
                                  "Uploading..."}
                              </p>
                              <Skeleton className="skeleton-shimmer h-3 w-24 mt-1 bg-secondary/40" />
                            </div>
                            <Skeleton className="skeleton-shimmer h-3 w-14 bg-secondary/40" />
                            <Skeleton className="skeleton-shimmer h-3 w-16 bg-secondary/40" />
                          </div>
                        ) : null}

                        {Array.from({ length: uploadSkeletonCount }).map(
                          (_, index) =>
                            isNotesFolderView ? (
                              <div
                                key={`upload-list-skeleton-${index}`}
                                className="px-2 py-1"
                              >
                                <div className="ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-primary/18 px-3 py-2">
                                  <Skeleton className="skeleton-shimmer h-4 w-[66%] bg-primary/32" />
                                  <Skeleton className="skeleton-shimmer h-4 w-[42%] mt-1.5 bg-primary/26" />
                                  <Skeleton className="skeleton-shimmer h-3 w-12 mt-2 ml-auto bg-primary/20" />
                                </div>
                              </div>
                            ) : (
                              <div
                                key={`upload-list-skeleton-${index}`}
                                className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-secondary/20"
                              >
                                <Skeleton className="skeleton-shimmer h-8 w-8 rounded-md bg-secondary/55" />
                                <Skeleton className="skeleton-shimmer h-4 flex-1 max-w-[45%] bg-secondary/45" />
                                <Skeleton className="skeleton-shimmer h-3 w-14 bg-secondary/40" />
                                <Skeleton className="skeleton-shimmer h-3 w-16 bg-secondary/40" />
                              </div>
                            ),
                        )}

                        {pasteSkeletonCount > 0 &&
                          (isNotesFolderView ? (
                            <div
                              key="paste-list-skeleton"
                              className="px-2 py-1"
                            >
                              <div className="ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-primary/18 px-3 py-2">
                                <Skeleton className="skeleton-shimmer h-4 w-[64%] bg-primary/32" />
                                <Skeleton className="skeleton-shimmer h-4 w-[50%] mt-1.5 bg-primary/26" />
                                <Skeleton className="skeleton-shimmer h-3 w-12 mt-2 ml-auto bg-primary/20" />
                              </div>
                            </div>
                          ) : (
                            <div
                              key="paste-list-skeleton"
                              className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-secondary/20"
                            >
                              <Skeleton className="skeleton-shimmer h-8 w-8 rounded-md bg-secondary/55" />
                              <Skeleton className="skeleton-shimmer h-4 flex-1 max-w-[45%] bg-secondary/45" />
                              <Skeleton className="skeleton-shimmer h-3 w-14 bg-secondary/40" />
                              <Skeleton className="skeleton-shimmer h-3 w-16 bg-secondary/40" />
                            </div>
                          ))}
                      </>
                    ) : (
                      <FileGrid
                        files={sortedFiles}
                        selectedFile={selectedFile}
                        selectedPaths={selectedPathSet}
                        cutPaths={cutPathSet}
                        onSelect={onFileSelect}
                        onOpen={onFileOpen}
                        onContextMenu={(event, file) =>
                          onFileContextMenu(event, file)
                        }
                        isDraggable={isDraggableItem}
                        draggedPaths={draggedPaths}
                        isDropTarget={(file) => dropTargetPath === file.path}
                        isDropSuccess={(file) =>
                          recentDropTargetPath === file.path
                        }
                        onDragStart={(event, file) =>
                          onItemDragStart(event, file)
                        }
                        onDragEnd={(event) => onItemDragEnd(event)}
                        onDragOver={(event, file) =>
                          onItemDragOver(event, file)
                        }
                        onDragLeave={(_, file) => onItemDragLeave(file)}
                        onDrop={(event, file) => onItemDrop(event, file)}
                        galleryMode={isGalleryView}
                        appendItems={
                          isGalleryView ? null : (
                            <>
                              {shouldShowUploadPlaceholder ? (
                                <div className="flex flex-col items-center p-2 rounded-xl bg-secondary/20 border border-transparent">
                                  <Skeleton className="skeleton-shimmer h-24 w-24 rounded-lg bg-secondary/50" />
                                  <p className="mt-3 text-body font-medium text-foreground truncate w-24 text-center">
                                    {uploadPlaceholderItem?.fileName ||
                                      "Uploading..."}
                                  </p>
                                  <Skeleton className="skeleton-shimmer h-3 w-14 mt-1.5 bg-secondary/40" />
                                </div>
                              ) : null}
                              {Array.from({ length: uploadSkeletonCount }).map(
                                (_, index) => (
                                  <div
                                    key={`upload-grid-skeleton-${index}`}
                                    className="flex flex-col items-center p-2 rounded-xl bg-secondary/20"
                                  >
                                    <Skeleton className="skeleton-shimmer h-24 w-24 rounded-lg bg-secondary/50" />
                                    <Skeleton className="skeleton-shimmer h-4 w-20 mt-3 bg-secondary/45" />
                                    <Skeleton className="skeleton-shimmer h-3 w-12 mt-1.5 bg-secondary/40" />
                                  </div>
                                ),
                              )}
                              {pasteSkeletonCount > 0 && (
                                <div
                                  key="paste-grid-skeleton"
                                  className="flex flex-col items-center p-2 rounded-xl bg-secondary/20"
                                >
                                  <Skeleton className="skeleton-shimmer h-24 w-24 rounded-lg bg-secondary/50" />
                                  <Skeleton className="skeleton-shimmer h-4 w-20 mt-3 bg-secondary/45" />
                                  <Skeleton className="skeleton-shimmer h-3 w-12 mt-1.5 bg-secondary/40" />
                                </div>
                              )}
                            </>
                          )
                        }
                      />
                    )}

                    {isLoadingMoreSavedItems && (
                      <div className="flex items-center justify-center py-4">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {isNotesFolderView && (
                <div className="shrink-0 bg-glass px-4 py-3">
                  <div className="flex items-center gap-2 rounded-xl bg-primary/14 px-3 py-2">
                    <input
                      type="text"
                      value={noteComposerValue}
                      onChange={(event) =>
                        onNoteComposerChange(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          onSendNoteMessage();
                        }
                      }}
                      placeholder="Message"
                      className="flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                      disabled={isSendingNoteMessage}
                    />
                    <TelegramButton
                      variant="primary"
                      size="sm"
                      onClick={onSendNoteMessage}
                      disabled={
                        isSendingNoteMessage || !noteComposerValue.trim()
                      }
                    >
                      Send
                    </TelegramButton>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {!isNotesFolderView ? (
        <div className="relative flex h-8 shrink-0 items-center justify-between border-t border-border bg-black/20 px-3 text-small text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2 truncate">
            <span className="tabular-nums">
              {sortedFiles.length} {sortedFiles.length === 1 ? "item" : "items"}
            </span>
            {selectedItemsCount > 0 ? (
              <>
                <span className="h-3.5 w-px bg-border/60" />
                <span className="truncate">
                  {selectedItemsCount}{" "}
                  {selectedItemsCount === 1 ? "item" : "items"} selected
                  {selectedItemsSize > 0
                    ? ` ${formatFileSize(selectedItemsSize)}`
                    : ""}
                </span>
              </>
            ) : (
              <span className="h-3.5 w-px bg-border/60" />
            )}
          </div>

          <div className="pointer-events-none absolute inset-x-0 flex justify-center">
            <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground/90">
              TelegramFileServer {appVersion}
            </span>
          </div>

          {!isGalleryView ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => onViewModeChange("list")}
                className={`flex h-6 w-6 items-center justify-center rounded-sm transition-colors ${
                  viewMode === "list"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                }`}
                title="List view"
              >
                <List className="h-4 w-4" />
              </button>
              <button
                onClick={() => onViewModeChange("grid")}
                className={`flex h-6 w-6 items-center justify-center rounded-sm transition-colors ${
                  viewMode === "grid"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                }`}
                title="Grid view"
              >
                <Grid className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
