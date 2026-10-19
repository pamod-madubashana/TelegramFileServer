import { FileItem, formatFileSize } from "./FileRow";
import { File, X, Star, Copy, ExternalLink, Trash2, Edit2 } from "lucide-react";
import { TelegramButton } from "./TelegramButton";
import { FolderArtwork } from "./FolderArtwork";
import { ThemedFileIcon } from "./fileIcons";
import { resolveThumbnailSrc } from "@/lib/thumbnail-src";
import {
  getEffectiveFolderType,
  getFolderTypeLabel,
} from "@/lib/folder-settings";
import { useProgressiveThumbnail } from "@/lib/use-progressive-thumbnail";

interface DetailsPanelProps {
  file: FileItem | null;
  isOpen?: boolean;
  onClose: () => void;
  onToggleFavorite?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onCopyPath?: () => void;
  onOpenLocation?: () => void;
  isFavorite?: boolean;
}

export function DetailsPanel({
  file,
  isOpen: _isOpen,
  onClose,
  onToggleFavorite,
  onRename,
  onDelete,
  onCopyPath,
  onOpenLocation,
  isFavorite = false,
}: DetailsPanelProps) {
  // Paint the cheap preview the listing already advertises, then upgrade to
  // the larger tier once the server has it cached and the browser decodes it.
  const { thumbUrl: previewThumb, dismissThumbnail } = useProgressiveThumbnail(
    resolveThumbnailSrc(file?.thumbnail),
    file?.isDirectory || file?.isNoteMessage ? undefined : file?.messageId,
  );

  if (!file) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-6">
        <File className="w-12 h-12 text-muted-foreground/50 mb-3" />
        <p className="text-body text-muted-foreground text-center">
          Select a file or folder to view details
        </p>
      </div>
    );
  }

  const fileTypeLabel = file.isDirectory
    ? getEffectiveFolderType(file.folderSettings) !== "normal"
      ? `${getFolderTypeLabel(getEffectiveFolderType(file.folderSettings))} folder`
      : "Folder"
    : file.extension?.toUpperCase() || "File";

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h2 className="text-body font-medium text-foreground">Details</h2>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-secondary transition-colors"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Preview area */}
      <div className="flex flex-col items-center border-b border-border p-6">
        <div className="mb-4 flex h-48 w-48 items-center justify-center overflow-hidden rounded-[28px] border border-white/6 bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_42px_rgba(0,0,0,0.22)] transition-all">
          {previewThumb ? (
            <img
              src={previewThumb}
              alt={file.name}
              className="h-full w-full object-cover animate-in fade-in zoom-in-95 duration-300"
              onError={dismissThumbnail}
            />
          ) : file.isDirectory ? (
            <FolderArtwork
              name={file.name}
              path={file.path}
              settings={file.folderSettings}
              size={140}
              folderClassName="drop-shadow-[0_16px_28px_rgba(0,0,0,0.28)]"
              symbolClassName="absolute left-1/2 top-[56%] h-10 w-10 -translate-x-1/2 -translate-y-1/2 text-black/70 mix-blend-multiply"
              badgeClassName="right-2 top-2 px-2 py-0.5 text-[11px]"
            />
          ) : (
            <ThemedFileIcon file={file} size="lg" className="h-32 w-32" />
          )}
        </div>
        <h3 className="text-body font-medium text-foreground text-center break-all">
          {file.name}
        </h3>
        <p className="text-small text-muted-foreground mt-1">{fileTypeLabel}</p>
      </div>

      {/* Metadata */}
      <div className="p-4 space-y-3 flex-1 overflow-y-auto">
        {!file.isDirectory && !file.isNoteMessage && file.caption ? (
          <div>
            <p className="text-small text-muted-foreground">Caption</p>
            <p className="text-body text-foreground whitespace-pre-wrap break-words">
              {file.caption}
            </p>
          </div>
        ) : null}
        {!file.isDirectory && file.size !== undefined && (
          <div>
            <p className="text-small text-muted-foreground">Size</p>
            <p className="text-body text-foreground">
              {formatFileSize(file.size)}
            </p>
          </div>
        )}
        {file.modifiedAt && (
          <div>
            <p className="text-small text-muted-foreground">Modified</p>
            <p className="text-body text-foreground">
              {new Date(file.modifiedAt).toLocaleString()}
            </p>
          </div>
        )}
        <div>
          <p className="text-small text-muted-foreground">Path</p>
          <p className="text-small text-foreground break-all">{file.path}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border space-y-2">
        <div className="flex gap-2">
          {file.isDirectory && onToggleFavorite ? (
            <TelegramButton
              variant="secondary"
              size="sm"
              onClick={onToggleFavorite}
              className="flex-1"
            >
              <Star
                className={`w-4 h-4 ${isFavorite ? "fill-primary text-primary" : ""}`}
              />
              {isFavorite ? "Unfavorite" : "Favorite"}
            </TelegramButton>
          ) : null}

          <TelegramButton
            variant="secondary"
            size="sm"
            onClick={onCopyPath}
            className={file.isDirectory && onToggleFavorite ? "" : "flex-1"}
          >
            <Copy className="w-4 h-4" />
          </TelegramButton>
        </div>
        <div className="flex gap-2">
          <TelegramButton
            variant="secondary"
            size="sm"
            onClick={onRename}
            className="flex-1"
          >
            <Edit2 className="w-4 h-4" />
            Rename
          </TelegramButton>
          <TelegramButton
            variant="secondary"
            size="sm"
            onClick={onOpenLocation}
          >
            <ExternalLink className="w-4 h-4" />
          </TelegramButton>
        </div>
        <TelegramButton variant="danger" size="sm" onClick={onDelete} fullWidth>
          <Trash2 className="w-4 h-4" />
          Delete
        </TelegramButton>
      </div>
    </div>
  );
}
