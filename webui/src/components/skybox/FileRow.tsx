import { FolderArtwork } from "@/components/skybox/FolderArtwork";
import { resolveThumbnailSrc } from "@/lib/thumbnail-src";
import { useProgressiveThumbnail } from "@/lib/use-progressive-thumbnail";
import { ThemedFileIcon } from "@/components/skybox/fileIcons";
import { Skeleton } from "@/components/ui/skeleton";
import { type FolderSettings } from "@/lib/folder-settings";

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  folderSettings?: FolderSettings | null;
  size?: number;
  modifiedAt?: string;
  extension?: string;
  /** Server-side media type (`photo`, `video`, `audio`, `document`, `text`). */
  fileType?: string;
  messageId?: number;
  chatId?: number;
  thumbnail?: string;
  caption?: string;
  noteText?: string;
  isNoteMessage?: boolean;
  isUploading?: boolean;
}

interface FileRowProps {
  file: FileItem;
  isSelected?: boolean;
  isCutItem?: boolean;
  isDragging?: boolean;
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onOpen?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  isDropTarget?: boolean;
  isDropSuccess?: boolean;
}

const formatFileSize = (bytes?: number): string => {
  if (bytes === undefined) return "—";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const formatDate = (dateStr?: string): string => {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
};

export function FileRow({
  file,
  isSelected,
  isCutItem,
  isDragging,
  onSelect,
  onOpen,
  onContextMenu,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  isDropTarget,
  isDropSuccess,
}: FileRowProps) {
  // Paint the cheap preview the listing already advertises, then upgrade to
  // the larger tier once the server has it cached and the browser decodes it.
  const { thumbUrl, isFetchingThumbnail, dismissThumbnail } =
    useProgressiveThumbnail(
      file.isUploading ? undefined : resolveThumbnailSrc(file.thumbnail),
      file.isDirectory || file.isNoteMessage ? undefined : file.messageId,
    );
  const showThumbnailPlaceholder =
    !file.isDirectory &&
    !!file.messageId &&
    !thumbUrl &&
    !file.isNoteMessage &&
    isFetchingThumbnail;

  if (file.isNoteMessage) {
    return (
      <div
        data-file-item="true"
        data-file-path={file.path}
        onClick={(event) => onSelect?.(event)}
        onDoubleClick={onOpen}
        onContextMenu={onContextMenu}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`px-2 py-1 rounded-lg transition-[transform,opacity,background-color,box-shadow] duration-200 ease-out ${
          isSelected ? "bg-primary/14" : "hover:bg-primary/8"
        } ${isDropTarget ? "scale-[1.01] ring-1 ring-primary/60 bg-primary/12 shadow-[0_10px_24px_rgba(16,185,129,0.12)]" : ""} ${isDropSuccess ? "ring-1 ring-primary/55 bg-primary/10 shadow-[0_0_0_1px_rgba(34,197,94,0.08),0_8px_24px_rgba(34,197,94,0.12)]" : ""} ${isDragging ? "scale-[0.985] opacity-45" : ""} ${isCutItem ? "opacity-50 grayscale" : ""}`}
      >
        <div className="ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-primary/30 px-3 py-2">
          <p className="text-body text-foreground whitespace-pre-wrap break-words leading-5">
            {file.noteText || file.name}
          </p>
          <p className="mt-1 text-small text-muted-foreground/90 text-right">
            {formatDate(file.modifiedAt)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-file-item="true"
      data-file-path={file.path}
      onClick={(event) => onSelect?.(event)}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex items-center gap-3 px-3 py-1 rounded-lg transition-[transform,opacity,background-color,box-shadow] duration-200 ease-out ${
        isSelected
          ? "bg-sidebar-accent text-foreground"
          : "hover:bg-sidebar-accent/50"
      } ${isDropTarget ? "translate-y-[-1px] scale-[1.01] ring-1 ring-primary/60 bg-primary/10 shadow-[0_10px_24px_rgba(16,185,129,0.12)]" : ""} ${isDropSuccess ? "ring-1 ring-primary/55 bg-primary/10 shadow-[0_0_0_1px_rgba(34,197,94,0.08),0_8px_24px_rgba(34,197,94,0.12)]" : ""} ${isDragging ? "scale-[0.985] opacity-45" : ""} ${isCutItem ? "opacity-50 grayscale" : ""}`}
    >
      <div className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={file.name}
            className="w-full h-full object-cover"
              onError={dismissThumbnail}
          />
        ) : file.isDirectory ? (
          <FolderArtwork
            name={file.name}
            path={file.path}
            settings={file.folderSettings}
            size={24}
            symbolClassName="absolute left-1/2 top-[56%] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 text-black/55 mix-blend-multiply"
            badgeClassName="-right-1 -top-1 px-1 py-0 text-[8px]"
          />
        ) : showThumbnailPlaceholder ? (
          <>
            <div className="absolute inset-0 bg-gradient-to-br from-secondary/70 via-secondary/30 to-secondary/70 animate-pulse" />
            <ThemedFileIcon file={file} size="sm" className="relative z-[1]" />
          </>
        ) : (
          <ThemedFileIcon file={file} size="sm" />
        )}

        {file.isUploading ? (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-primary/10 animate-pulse" />
            <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-primary/35" />
          </div>
        ) : null}
      </div>
      <span className="flex-1 text-body text-foreground truncate flex items-center gap-2">
        <span className="truncate">{file.name}</span>
        {file.isUploading ? (
          <Skeleton className="skeleton-shimmer h-3 w-16 bg-secondary/55" />
        ) : null}
      </span>
      {!file.isDirectory && (
        <span className="text-small text-muted-foreground">
          {formatFileSize(file.size)}
        </span>
      )}
      <span className="text-small text-muted-foreground w-20 text-right">
        {formatDate(file.modifiedAt)}
      </span>
    </div>
  );
}

export { formatFileSize, formatDate };
