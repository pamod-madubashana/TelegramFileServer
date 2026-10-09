import { DetailsPanel } from "@/components/skybox/DetailsPanel";
import { SavedMediaViewer } from "@/components/skybox/SavedMediaViewer";
import {
  getExplorerPageLabel,
  useReactPageLogger,
} from "@/lib/reactPageLogger";
import { ExplorerDialogs } from "@/pages/explorer/components/ExplorerDialogs";
import { ExplorerMainPane } from "@/pages/explorer/components/ExplorerMainPane";
import { useExplorerPageController } from "@/pages/explorer/hooks/useExplorerPageController";
import { useLocation } from "react-router-dom";

export default function ExplorerPage() {
  const location = useLocation();
  const {
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
    handleToggleNameSort,
    isRecycleBinView,
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
    sortDirection,
    sortField,
    isGalleryView,
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
    handleDirectoryScroll,
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
  } = useExplorerPageController();

  useReactPageLogger(
    location.pathname.startsWith("/explorer")
      ? getExplorerPageLabel(currentPath)
      : null,
  );

  return (
    <div className="relative h-full">
      <ExplorerMainPane
        currentPath={currentPath}
        contextMenuState={contextMenuState}
        onRootClick={() => {
          if (contextMenuState) {
            closeContextMenu();
          }
        }}
        favoritePaths={favorites}
        recentPaths={recentPaths}
        showFavorites={showFavorites}
        homePath={explorerHomePath}
        userInfo={userInfo}
        avatarUrl={avatarUrl}
        audioPlayerSrc={audioPlayerSrc}
        audioPlayerLoading={audioPlayerLoading}
        onCloseAudioPlayer={closeAudioPlayer}
        backHistoryLength={backHistory.length}
        onGoBack={handleGoBack}
        forwardHistoryLength={forwardHistory.length}
        onGoForward={handleGoForward}
        onRefresh={handleRefresh}
        isLoading={isLoading}
        breadcrumbItems={breadcrumbItems}
        onNavigateToPath={handleNavigateToPath}
        breadcrumbsHomePath={breadcrumbsHomePath}
        search={search}
        onSearchChange={setSearch}
        isNotesFolderView={isNotesFolderView}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        sortField={sortField}
        sortDirection={sortDirection}
        onToggleNameSort={handleToggleNameSort}
        isRecycleBinView={isRecycleBinView}
        isGalleryView={isGalleryView}
        selectedFile={selectedFile}
        selectedPaths={selectedPaths}
        onNewFolder={handleNewFolder}
        onCopyPath={handleCopyPath}
        onRename={handleRename}
        onRequestDeleteTargets={requestDeleteTargets}
        onRestoreAllFromRecycleBin={() => {
          void handleRestoreAllFromRecycleBin();
        }}
        onEmptyRecycleBin={() => requestDeleteTargets(sortedFiles)}
        isOffline={isOffline}
        shouldShowSavedSyncToolbarIndicator={
          shouldShowSavedSyncToolbarIndicator
        }
        isLoadingSavedFiles={isLoadingSavedFiles}
        isSavedSyncComplete={isSavedSyncComplete}
        savedSyncStatusLabel={savedSyncStatusLabel}
        savedSyncPercent={savedSyncPercent}
        syncProgressLabel={syncProgressLabel}
        transferMenuTriggerRef={transferMenuTriggerRef}
        activeDownload={activeDownload}
        onToggleTransferMenu={handleToggleTransferMenu}
        downloadToolbarLabel={downloadToolbarLabel}
        downloadProgressPercent={downloadProgressPercent}
        isUploadProgressMounted={isUploadProgressMounted}
        uploadToolbarItem={uploadToolbarItem}
        isUploadProgressVisible={isUploadProgressVisible}
        uploadToolbarTitle={uploadToolbarTitle}
        uploadToolbarLabel={uploadToolbarLabel}
        uploadToolbarPercent={uploadToolbarPercent}
        sortedFiles={sortedFiles}
        hasTransferEntries={hasTransferEntries}
        transferDownloadItem={transferDownloadItem}
        transferUploadItems={transferUploadItems}
        canCancelUploads={canCancelUploads}
        onCancelUploadQueue={handleCancelUploadQueue}
        isTransferMenuOpen={isTransferMenuOpen}
        setIsTransferMenuOpen={setIsTransferMenuOpen}
        transferMenuRef={transferMenuRef}
        explorerAreaRef={explorerAreaRef}
        onExplorerDragOver={handleExplorerDragOver}
        onExplorerDragLeave={handleExplorerDragLeave}
        onExplorerDrop={handleExplorerDrop}
        onDirectoryScroll={handleDirectoryScroll}
        onExplorerMouseDown={handleExplorerMouseDown}
        onEmptyAreaContextMenu={handleEmptyAreaContextMenu}
        isExternalDragging={isExternalDragging}
        selectionBox={selectionBox}
        selectionBoxStyle={selectionBoxStyle}
        error={error}
        onRetry={() => {
          void loadDirectory(currentPath, { force: true });
        }}
        isDirectoryLoading={isDirectoryLoading}
        effectiveViewMode={effectiveViewMode}
        hasVisibleItems={hasVisibleItems}
        onClearSearch={() => setSearch("")}
        selectedPathSet={selectedPathSet}
        cutPathSet={cutPathSet}
        onFileSelect={handleFileSelect}
        onFileOpen={handleFileOpen}
        onFileContextMenu={handleFileContextMenu}
        isDraggableItem={isDraggableItem}
        draggedPaths={draggedPaths}
        dropTargetPath={dropTargetPath}
        recentDropTargetPath={recentDropTargetPath}
        onItemDragStart={handleItemDragStart}
        onItemDragEnd={handleItemDragEnd}
        onItemDragOver={handleItemDragOver}
        onItemDragLeave={handleItemDragLeave}
        onItemDrop={handleItemDrop}
        shouldShowUploadPlaceholder={shouldShowUploadPlaceholder}
        uploadPlaceholderItem={uploadPlaceholderItem}
        uploadSkeletonCount={uploadSkeletonCount}
        pasteSkeletonCount={pasteSkeletonCount}
        isLoadingMoreSavedItems={isLoadingMoreSavedItems}
        noteComposerValue={noteComposerValue}
        onNoteComposerChange={setNoteComposerValue}
        onSendNoteMessage={() => {
          void handleSendNoteMessage();
        }}
        isSendingNoteMessage={isSendingNoteMessage}
      />

      {/* Details panel overlay */}
      {showDetails && !isRecycleBinView && (
        <div
          ref={detailsPanelRef}
          className={`absolute inset-y-0 left-0 z-[70] w-64 ${
            isDetailsPanelOpen ? "" : "pointer-events-none"
          }`}
        >
          <div className="relative h-full">
            <div
              data-state={isDetailsPanelOpen ? "open" : "closed"}
              className="details-panel-backdrop absolute inset-0"
            />
            <div
              data-state={isDetailsPanelOpen ? "open" : "closed"}
              className="details-panel-shell relative h-full overflow-hidden"
            >
              <DetailsPanel
                file={selectedFile}
                isOpen={isDetailsPanelOpen}
                onClose={closeDetailsPanel}
                onToggleFavorite={
                  showFavorites ? handleToggleFavorite : undefined
                }
                onRename={handleRename}
                onDelete={() =>
                  selectedFile && requestDeleteTargets([selectedFile])
                }
                onCopyPath={handleCopyPath}
                onOpenLocation={() => toast({ title: "Reveal in folder" })}
                isFavorite={
                  showFavorites && selectedFile
                    ? favorites.includes(selectedFile.path)
                    : false
                }
              />
            </div>
          </div>
        </div>
      )}

      <SavedMediaViewer
        isOpen={isMediaViewerOpen}
        fileName={currentMediaViewerFile?.name || "Media"}
        mediaKind={currentMediaKind}
        thumbnailSrc={mediaViewerThumbnailSrc}
        mediaSrc={mediaViewerSrc}
        isLoading={isMediaViewerLoading}
        error={mediaViewerError}
        canGoPrevious={currentMediaKind === "image" && canGoToPreviousMedia}
        canGoNext={currentMediaKind === "image" && canGoToNextMedia}
        onPrevious={goToPreviousMedia}
        onNext={goToNextMedia}
        onClose={closeSavedMediaViewer}
      />

      <SavedMediaViewer
        isOpen={isLocalImageViewerOpen}
        fileName={currentLocalImageFile?.name || "Image"}
        mediaKind={currentLocalImageFile ? "image" : null}
        thumbnailSrc={localImageSrc}
        mediaSrc={localImageSrc}
        isLoading={false}
        error={localImageSrc ? null : "This image cannot be previewed."}
        canGoPrevious={canGoToPreviousLocalImage}
        canGoNext={canGoToNextLocalImage}
        onPrevious={goToPreviousLocalImage}
        onNext={goToNextLocalImage}
        onClose={closeLocalImageViewer}
      />

      <SavedMediaViewer
        isOpen={isLocalVideoViewerOpen}
        fileName={localVideoViewerFile?.name || "Video"}
        mediaKind={localVideoViewerFile ? "video" : null}
        thumbnailSrc={null}
        mediaSrc={localVideoSrc}
        isLoading={false}
        error={localVideoSrc ? null : "This video cannot be previewed."}
        canGoPrevious={false}
        canGoNext={false}
        onPrevious={() => {}}
        onNext={() => {}}
        onClose={closeLocalVideoViewer}
      />

      <ExplorerDialogs
        contextMenuRef={contextMenuRef}
        contextMenuState={contextMenuState}
        selectedPaths={selectedPaths}
        clipboardItem={clipboardItem}
        favorites={favorites}
        showFavorites={showFavorites}
        currentPath={currentPath}
        isRecycleBinView={isRecycleBinView}
        isNotesFolderView={isNotesFolderView}
        isNotesMessageContextMenu={isNotesMessageContextMenu}
        isMultiSelectionContextMenu={isMultiSelectionContextMenu}
        contextTargetFile={contextTargetFile}
        canPasteInCurrentPath={canPasteInCurrentPath}
        onCloseContextMenu={closeContextMenu}
        onContextOpen={handleContextOpen}
        onOpenInNewTab={handleOpenInNewTab}
        onContextDelete={handleContextDelete}
        onContextDetails={handleContextDetails}
        onCopyPath={handleCopyPath}
        onToggleFavorite={handleToggleFavorite}
        onRename={handleRename}
        onNewFolder={handleNewFolder}
        onPaste={handlePaste}
        onShare={handleShare}
        onCopyNoteText={handleCopyNoteText}
        onEditNoteMessage={handleEditNoteMessage}
        onRestoreFromRecycleBin={handleRestoreFromRecycleBin}
        onOpenFolderSettings={handleOpenFolderSettings}
        onStageClipboardItem={handleStageClipboardItem}
        onDownloadSavedFile={handleDownloadSavedFile}
        onDeleteNoteFromTelegram={handleDeleteNoteFromTelegram}
        isNewFolderDialogOpen={isNewFolderDialogOpen}
        newFolderName={newFolderName}
        setNewFolderName={setNewFolderName}
        onConfirmNewFolder={() => {
          void handleConfirmNewFolder();
        }}
        onCancelNewFolder={() => {
          setIsNewFolderDialogOpen(false);
          setNewFolderName("");
        }}
        folderSettingsTarget={folderSettingsTarget}
        onCloseFolderSettings={handleCloseFolderSettings}
        onFolderSettingsSaved={() => {
          void handleFolderSettingsSaved();
        }}
        renameTarget={renameTarget}
        renameValue={renameValue}
        setRenameValue={setRenameValue}
        onConfirmRename={() => {
          void handleConfirmRename();
        }}
        onCancelRename={() => {
          setRenameTarget(null);
          setRenameValue("");
        }}
        noteEditTarget={noteEditTarget}
        noteEditValue={noteEditValue}
        setNoteEditValue={setNoteEditValue}
        onConfirmEditNoteMessage={() => {
          void handleConfirmEditNoteMessage();
        }}
        onCancelEditNoteMessage={() => {
          setNoteEditTarget(null);
          setNoteEditValue("");
        }}
        pendingMoveConfirm={pendingMoveConfirm}
        setPendingMoveConfirm={setPendingMoveConfirm}
        pendingRenameConfirm={pendingRenameConfirm}
        setPendingRenameConfirm={setPendingRenameConfirm}
        onPerformRename={(file, newName) => {
          void performRename(file, newName);
        }}
        deleteTargets={deleteTargets}
        isPermanentDeleteTarget={isPermanentDeleteTarget}
        isSavedDeleteTarget={isSavedDeleteTarget}
        isMultiDelete={isMultiDelete}
        deleteTarget={deleteTarget}
        onConfirmDelete={(targets) => {
          setDeleteTargets([]);
          void handleDelete(targets);
        }}
        onCancelDelete={() => setDeleteTargets([])}
        shareTarget={shareTarget}
        onShareClose={handleShareClose}
        onShareToContact={handleShareToContact}
        onSearchContacts={handleSearchContacts}
        onGetRecentChats={handleGetRecentChats}
        uploadConfirmDraft={uploadConfirmDraft}
        uploadPremiumUser={uploadPremiumUser}
        setUploadConfirmDraft={setUploadConfirmDraft}
        onConfirmUploadDraft={handleConfirmUploadDraft}
        isChatDrivePickerOpen={isChatDrivePickerOpen}
        chatDriveCandidates={chatDriveCandidates}
        isChatDriveCandidatesLoading={isChatDriveCandidatesLoading}
        chatDriveCandidatesQuery={chatDriveCandidatesQuery}
        setChatDriveCandidatesQuery={setChatDriveCandidatesQuery}
        pendingChatDriveCandidate={pendingChatDriveCandidate}
        setPendingChatDriveCandidate={setPendingChatDriveCandidate}
        onCloseChatDrivePicker={() => setIsChatDrivePickerOpen(false)}
        onConfirmChatDriveCandidate={handleConfirmChatDriveCandidate}
      />
    </div>
  );
}
