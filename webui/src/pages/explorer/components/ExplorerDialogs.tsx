import type { Dispatch, RefObject, SetStateAction } from "react";
import { MessageCircle, X, Edit3 } from "lucide-react";
import { ConfirmDialog } from "@/components/skybox/ConfirmDialog";
import { ContextMenu } from "@/components/skybox/ContextMenu";
import { FolderSettingsDialog } from "@/components/skybox/FolderSettingsDialog";
import {
  ShareWidget,
  type TelegramContact,
} from "@/components/skybox/ShareWidget";
import {
  UploadConfirmWidget,
  type UploadConfirmDraft,
} from "@/components/skybox/UploadConfirmWidget";
import { TextInputDialog } from "@/components/skybox/TextInputDialog";
import type { FileItem } from "@/components/skybox/FileRow";
import type {
  ChatDriveCandidate,
  ClipboardMode,
  ExplorerClipboardItem,
  ExplorerContextMenuState,
} from "@/pages/explorer/shared";

interface ExplorerDialogsProps {
  contextMenuRef: RefObject<HTMLDivElement | null>;
  contextMenuState: ExplorerContextMenuState | null;
  selectedPaths: string[];
  clipboardItem: ExplorerClipboardItem | null;
  favorites: string[];
  showFavorites: boolean;
  currentPath: string;
  isRecycleBinView: boolean;
  isNotesFolderView: boolean;
  isNotesMessageContextMenu: boolean;
  isMultiSelectionContextMenu: boolean;
  contextTargetFile: FileItem | null;
  canPasteInCurrentPath: boolean;
  onCloseContextMenu: () => void;
  onContextOpen: () => void;
  onOpenInNewTab: (file: FileItem) => void;
  onContextDelete: () => void;
  onContextDetails: () => void;
  onCopyPath: () => void;
  onToggleFavorite: (file?: FileItem | null) => void;
  onRename: () => void;
  onNewFolder: () => void;
  onPaste: () => void;
  onShare: () => void;
  onCopyNoteText: () => void;
  onEditNoteMessage: () => void;
  onRestoreFromRecycleBin: () => void;
  onOpenFolderSettings: (file?: FileItem | null) => void;
  onStageClipboardItem: (mode: ClipboardMode, file?: FileItem) => void;
  onDownloadSavedFile: (file?: FileItem) => void;
  onDeleteNoteFromTelegram: (file?: FileItem) => void;
  isNewFolderDialogOpen: boolean;
  newFolderName: string;
  setNewFolderName: Dispatch<SetStateAction<string>>;
  onConfirmNewFolder: () => void;
  onCancelNewFolder: () => void;
  folderSettingsTarget: FileItem | null;
  onCloseFolderSettings: () => void;
  onFolderSettingsSaved: () => void;
  renameTarget: FileItem | null;
  renameValue: string;
  setRenameValue: Dispatch<SetStateAction<string>>;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  noteEditTarget: FileItem | null;
  noteEditValue: string;
  setNoteEditValue: Dispatch<SetStateAction<string>>;
  onConfirmEditNoteMessage: () => void;
  onCancelEditNoteMessage: () => void;
  pendingMoveConfirm: {
    title: string;
    message: string;
    run: () => Promise<void>;
    onCancel?: () => void;
  } | null;
  setPendingMoveConfirm: Dispatch<
    SetStateAction<{
      title: string;
      message: string;
      run: () => Promise<void>;
      onCancel?: () => void;
    } | null>
  >;
  pendingRenameConfirm: {
    file: FileItem;
    newName: string;
  } | null;
  setPendingRenameConfirm: Dispatch<
    SetStateAction<{
      file: FileItem;
      newName: string;
    } | null>
  >;
  onPerformRename: (file: FileItem, newName: string) => void;
  deleteTargets: FileItem[];
  isPermanentDeleteTarget: boolean;
  isSavedDeleteTarget: boolean;
  isMultiDelete: boolean;
  deleteTarget: FileItem | null;
  onConfirmDelete: (targets: FileItem[]) => void;
  onCancelDelete: () => void;
  shareTarget: FileItem | null;
  onShareClose: () => void;
  onShareToContact: (chatId: number) => Promise<void>;
  onSearchContacts: (query: string) => Promise<TelegramContact[]>;
  onGetRecentChats: () => Promise<TelegramContact[]>;
  uploadConfirmDraft: UploadConfirmDraft | null;
  uploadPremiumUser: boolean | null;
  setUploadConfirmDraft: Dispatch<SetStateAction<UploadConfirmDraft | null>>;
  onConfirmUploadDraft: (draft: UploadConfirmDraft) => void;
  isChatDrivePickerOpen: boolean;
  chatDriveCandidates: ChatDriveCandidate[];
  isChatDriveCandidatesLoading: boolean;
  chatDriveCandidatesQuery: string;
  setChatDriveCandidatesQuery: Dispatch<SetStateAction<string>>;
  pendingChatDriveCandidate: ChatDriveCandidate | null;
  setPendingChatDriveCandidate: Dispatch<
    SetStateAction<ChatDriveCandidate | null>
  >;
  onCloseChatDrivePicker: () => void;
  onConfirmChatDriveCandidate: (candidate: ChatDriveCandidate) => void;
}

interface ChatDrivePickerDialogProps {
  isOpen: boolean;
  candidates: ChatDriveCandidate[];
  isLoading: boolean;
  query: string;
  onQueryChange: Dispatch<SetStateAction<string>>;
  onClose: () => void;
  onSelect: (candidate: ChatDriveCandidate) => void;
}

function ChatDrivePickerDialog({
  isOpen,
  candidates,
  isLoading,
  query,
  onQueryChange,
  onClose,
  onSelect,
}: ChatDrivePickerDialogProps) {
  if (!isOpen) {
    return null;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleCandidates = normalizedQuery
    ? candidates.filter((chat) =>
        chat.title.toLowerCase().includes(normalizedQuery),
      )
    : candidates;

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--titlebar-height)] z-[93] flex items-center justify-center p-3">
      <div
        className="absolute inset-0 bg-background/35 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-[520px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-glass shadow-2xl shadow-black/50 backdrop-saturate-150 overflow-hidden animate-scale-in">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <p className="text-body font-semibold text-foreground">Add chat</p>
            <p className="text-small text-muted-foreground">
              Choose a group or channel to index
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-md hover:bg-sidebar-accent/50 transition-colors"
            aria-label="Close"
          >
            <span className="sr-only">Close</span>
            <div className="h-full w-full flex items-center justify-center text-muted-foreground">
              <X className="h-4 w-4" />
            </div>
          </button>
        </div>

        <div className="p-3 border-b border-border">
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search groups / channels"
            className="w-full telegram-input py-2"
          />
        </div>

        <div className="max-h-[520px] overflow-y-auto p-2">
          {isLoading ? (
            <div className="p-4 text-small text-muted-foreground">
              Loading...
            </div>
          ) : !visibleCandidates.length ? (
            <div className="p-4 text-small text-muted-foreground">
              {normalizedQuery
                ? "No matches."
                : "No groups/channels found in your recent list."}
            </div>
          ) : (
            visibleCandidates.map((chat) => (
              <button
                key={chat.id}
                onClick={() => onSelect(chat)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-sidebar-accent/40 text-left"
              >
                <div className="h-9 w-9 rounded-lg bg-secondary/50 flex items-center justify-center overflow-hidden">
                  {chat.profilePhoto ? (
                    <img
                      src={chat.profilePhoto}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <MessageCircle className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium text-foreground truncate">
                    {chat.title}
                  </p>
                  {chat.kind ? (
                    <p className="text-small text-muted-foreground truncate">
                      {chat.kind}
                    </p>
                  ) : null}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function ExplorerDialogs({
  contextMenuRef,
  contextMenuState,
  selectedPaths,
  clipboardItem,
  favorites,
  showFavorites,
  currentPath,
  isRecycleBinView,
  isNotesFolderView,
  isNotesMessageContextMenu,
  isMultiSelectionContextMenu,
  contextTargetFile,
  canPasteInCurrentPath,
  onCloseContextMenu,
  onContextOpen,
  onOpenInNewTab,
  onContextDelete,
  onContextDetails,
  onCopyPath,
  onToggleFavorite,
  onRename,
  onNewFolder,
  onPaste,
  onShare,
  onCopyNoteText,
  onEditNoteMessage,
  onRestoreFromRecycleBin,
  onOpenFolderSettings,
  onStageClipboardItem,
  onDownloadSavedFile,
  onDeleteNoteFromTelegram,
  isNewFolderDialogOpen,
  newFolderName,
  setNewFolderName,
  onConfirmNewFolder,
  onCancelNewFolder,
  folderSettingsTarget,
  onCloseFolderSettings,
  onFolderSettingsSaved,
  renameTarget,
  renameValue,
  setRenameValue,
  onConfirmRename,
  onCancelRename,
  noteEditTarget,
  noteEditValue,
  setNoteEditValue,
  onConfirmEditNoteMessage,
  onCancelEditNoteMessage,
  pendingMoveConfirm,
  setPendingMoveConfirm,
  pendingRenameConfirm,
  setPendingRenameConfirm,
  onPerformRename,
  deleteTargets,
  isPermanentDeleteTarget,
  isSavedDeleteTarget,
  isMultiDelete,
  deleteTarget,
  onConfirmDelete,
  onCancelDelete,
  shareTarget,
  onShareClose,
  onShareToContact,
  onSearchContacts,
  onGetRecentChats,
  uploadConfirmDraft,
  uploadPremiumUser,
  setUploadConfirmDraft,
  onConfirmUploadDraft,
  isChatDrivePickerOpen,
  chatDriveCandidates,
  isChatDriveCandidatesLoading,
  chatDriveCandidatesQuery,
  setChatDriveCandidatesQuery,
  pendingChatDriveCandidate,
  setPendingChatDriveCandidate,
  onCloseChatDrivePicker,
  onConfirmChatDriveCandidate,
}: ExplorerDialogsProps) {
  return (
    <>
      <ContextMenu
        ref={contextMenuRef}
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
        onClose={onCloseContextMenu}
        onOpen={onContextOpen}
        onOpenInNewTab={onOpenInNewTab}
        onDelete={onContextDelete}
        onDetails={onContextDetails}
        onCopyPath={onCopyPath}
        onToggleFavorite={onToggleFavorite}
        onRename={onRename}
        onNewFolder={onNewFolder}
        onPaste={onPaste}
        onShare={onShare}
        onCopyNoteText={onCopyNoteText}
        onEditNoteMessage={onEditNoteMessage}
        onRestoreFromRecycleBin={onRestoreFromRecycleBin}
        onFolderSettings={onOpenFolderSettings}
        onCopy={(file) => onStageClipboardItem("copy", file)}
        onCut={(file) => onStageClipboardItem("cut", file)}
        onDownload={onDownloadSavedFile}
        onDeleteNoteFromTelegram={onDeleteNoteFromTelegram}
      />

      <FolderSettingsDialog
        folder={folderSettingsTarget}
        isOpen={!!folderSettingsTarget}
        onClose={onCloseFolderSettings}
        onSaved={onFolderSettingsSaved}
      />

      <TextInputDialog
        isOpen={isNewFolderDialogOpen}
        title="Create Folder"
        description="Enter a name for the new folder."
        value={newFolderName}
        placeholder="Folder name"
        confirmLabel="Create"
        cancelLabel="Cancel"
        onValueChange={setNewFolderName}
        onConfirm={onConfirmNewFolder}
        onCancel={onCancelNewFolder}
      />

      <TextInputDialog
        isOpen={!!renameTarget}
        title="Rename Item"
        description={renameTarget ? `Rename ${renameTarget.name}` : undefined}
        value={renameValue}
        placeholder="New name"
        confirmLabel="Rename"
        cancelLabel="Cancel"
        icon={<Edit3 className="w-4 h-4 text-primary" />}
        framed
        onValueChange={setRenameValue}
        onConfirm={onConfirmRename}
        onCancel={onCancelRename}
      />

      <TextInputDialog
        isOpen={!!noteEditTarget}
        title="Edit Message"
        description={noteEditTarget ? "Update note message text" : undefined}
        value={noteEditValue}
        placeholder="Message"
        confirmLabel="Save"
        cancelLabel="Cancel"
        icon={<Edit3 className="w-4 h-4 text-primary" />}
        framed
        onValueChange={setNoteEditValue}
        onConfirm={onConfirmEditNoteMessage}
        onCancel={onCancelEditNoteMessage}
      />

      <ConfirmDialog
        isOpen={!!pendingMoveConfirm}
        title={pendingMoveConfirm?.title || "Move items"}
        message={pendingMoveConfirm?.message || ""}
        confirmLabel="Move"
        cancelLabel="Cancel"
        variant="primary"
        onCancel={() => {
          const pending = pendingMoveConfirm;
          setPendingMoveConfirm(null);
          pending?.onCancel?.();
        }}
        onConfirm={() => {
          const pending = pendingMoveConfirm;
          setPendingMoveConfirm(null);
          if (!pending) return;
          void pending.run();
        }}
      />

      <ConfirmDialog
        isOpen={!!pendingRenameConfirm}
        title="Rename item"
        message={
          pendingRenameConfirm
            ? `Rename "${pendingRenameConfirm.file.name}" to "${pendingRenameConfirm.newName}"?`
            : ""
        }
        confirmLabel="Rename"
        cancelLabel="Cancel"
        variant="primary"
        onCancel={() => setPendingRenameConfirm(null)}
        onConfirm={() => {
          const pending = pendingRenameConfirm;
          setPendingRenameConfirm(null);
          if (!pending) return;
          onPerformRename(pending.file, pending.newName);
        }}
      />

      <ConfirmDialog
        isOpen={deleteTargets.length > 0}
        title={
          isPermanentDeleteTarget
            ? "Delete Permanently"
            : isSavedDeleteTarget
              ? "Move to Recycle Bin"
              : isMultiDelete
                ? "Delete Items"
                : "Delete Item"
        }
        message={
          <p>
            {isPermanentDeleteTarget ? (
              <>
                Delete{isMultiDelete ? "" : " "}
                <strong>
                  {isMultiDelete
                    ? `${deleteTargets.length} items`
                    : deleteTarget?.name}
                </strong>{" "}
                from Recycle Bin permanently? This action cannot be undone.
              </>
            ) : isSavedDeleteTarget ? (
              <>
                Move{isMultiDelete ? "" : " "}
                <strong>
                  {isMultiDelete
                    ? `${deleteTargets.length} items`
                    : deleteTarget?.name}
                </strong>{" "}
                to Recycle Bin? You can restore it later.
              </>
            ) : (
              <>
                Are you sure you want to delete{isMultiDelete ? "" : " "}
                <strong>
                  {isMultiDelete
                    ? `${deleteTargets.length} items`
                    : deleteTarget?.name}
                </strong>
                ? This action cannot be undone.
              </>
            )}
          </p>
        }
        confirmLabel={
          isPermanentDeleteTarget
            ? "Delete Permanently"
            : isSavedDeleteTarget
              ? "Move to Recycle Bin"
              : "Delete"
        }
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => onConfirmDelete(deleteTargets)}
        onCancel={onCancelDelete}
      />

      <ShareWidget
        isOpen={!!shareTarget}
        fileName={shareTarget?.name || ""}
        onClose={onShareClose}
        onShare={onShareToContact}
        onSearchContacts={onSearchContacts}
        onGetRecentChats={onGetRecentChats}
      />

      {uploadConfirmDraft ? (
        <UploadConfirmWidget
          isOpen
          draft={uploadConfirmDraft}
          maxFileBytes={(uploadPremiumUser ? 4 : 2) * 1024 * 1024 * 1024}
          onChange={(next) => setUploadConfirmDraft(next)}
          onClose={() => setUploadConfirmDraft(null)}
          onConfirm={() => onConfirmUploadDraft(uploadConfirmDraft)}
        />
      ) : null}

      <ChatDrivePickerDialog
        isOpen={isChatDrivePickerOpen}
        candidates={chatDriveCandidates}
        isLoading={isChatDriveCandidatesLoading}
        query={chatDriveCandidatesQuery}
        onQueryChange={setChatDriveCandidatesQuery}
        onClose={onCloseChatDrivePicker}
        onSelect={setPendingChatDriveCandidate}
      />

      <ConfirmDialog
        isOpen={!!pendingChatDriveCandidate}
        title="Add chat"
        message={
          pendingChatDriveCandidate
            ? `Add "${pendingChatDriveCandidate.title}" and start indexing its files?`
            : ""
        }
        confirmLabel="Add"
        cancelLabel="Cancel"
        variant="primary"
        onCancel={() => setPendingChatDriveCandidate(null)}
          onConfirm={() => {
            const candidate = pendingChatDriveCandidate;
            if (!candidate) return;
            setPendingChatDriveCandidate(null);
            onConfirmChatDriveCandidate(candidate);
          }}
        />
    </>
  );
}
