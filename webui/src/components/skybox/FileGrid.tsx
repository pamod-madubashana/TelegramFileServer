import { FileItem, formatFileSize } from "./FileRow";
import type { ReactNode } from "react";
import { resolveThumbnailSrc } from "@/lib/thumbnail-src";
import { useProgressiveThumbnail } from "@/lib/use-progressive-thumbnail";
import { ThemedFileIcon } from "@/components/skybox/fileIcons";
import Folder from "@/components/skybox/Folder";
import { Skeleton } from "@/components/ui/skeleton";
import { getDefaultFolderSymbol } from "@/components/skybox/folderSymbols";

interface FileGridProps {
  files: FileItem[];
  selectedFile: FileItem | null;
  selectedPaths?: Set<string>;
  cutPaths?: Set<string>;
  onSelect: (file: FileItem, event: React.MouseEvent<HTMLDivElement>) => void;
  onOpen: (file: FileItem) => void;
  onContextMenu: (e: React.MouseEvent, file: FileItem) => void;
  isDraggable?: (file: FileItem) => boolean;
  draggedPaths?: string[];
  isDropTarget?: (file: FileItem) => boolean;
  isDropSuccess?: (file: FileItem) => boolean;
  onDragStart?: (e: React.DragEvent, file: FileItem) => void;
  onDragEnd?: (e: React.DragEvent, file: FileItem) => void;
  onDragOver?: (e: React.DragEvent, file: FileItem) => void;
  onDragLeave?: (e: React.DragEvent, file: FileItem) => void;
  onDrop?: (e: React.DragEvent, file: FileItem) => void;
  appendItems?: ReactNode;
  galleryMode?: boolean;
}

export function FileGrid({
  files,
  selectedFile,
  selectedPaths,
  cutPaths,
  onSelect,
  onOpen,
  onContextMenu,
  isDraggable,
  draggedPaths,
  isDropTarget,
  isDropSuccess,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  appendItems,
  galleryMode = false,
}: FileGridProps) {
  return (
    <div
      className={
        galleryMode
          ? "grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-[4px]"
          : "grid [grid-template-columns:repeat(auto-fill,minmax(7.75rem,4.75rem))] justify-start gap-2"
      }
    >
      {files.map((file) => {
        const isSelected = selectedPaths
          ? selectedPaths.has(file.path)
          : selectedFile?.path === file.path;
        const isCutItem = cutPaths ? cutPaths.has(file.path) : false;
        const draggable = isDraggable?.(file);
        const isDragging = draggedPaths
          ? draggedPaths.includes(file.path)
          : false;
        const dropTarget = isDropTarget?.(file);
        const dropSuccess = isDropSuccess?.(file);

        if (file.isDirectory) {
          return (
            <Folder
              key={file.path}
              name={file.name}
              path={file.path}
              settings={file.folderSettings}
              selected={isSelected}
              isCutItem={isCutItem}
              isDragging={isDragging}
              isDropTarget={dropTarget}
              isDropSuccess={dropSuccess}
              onClick={(event) => onSelect(file, event)}
              onDoubleClick={() => onOpen(file)}
              onContextMenu={(event) => onContextMenu(event, file)}
              draggable={draggable}
              onDragStart={(e) => onDragStart?.(e, file)}
              onDragEnd={(e) => onDragEnd?.(e, file)}
              onDragOver={(e) => onDragOver?.(e, file)}
              onDragLeave={(e) => onDragLeave?.(e, file)}
              onDrop={(e) => onDrop?.(e, file)}
            />
          );
        }

        return (
          <FileGridItem
            key={file.path}
            file={file}
            isSelected={isSelected}
            isCutItem={isCutItem}
            isDragging={isDragging}
            onSelect={(event) => onSelect(file, event)}
            onOpen={() => onOpen(file)}
            onContextMenu={(e) => onContextMenu(e, file)}
            draggable={draggable}
            isDropTarget={dropTarget}
            isDropSuccess={dropSuccess}
            onDragStart={(e) => onDragStart?.(e, file)}
            onDragEnd={(e) => onDragEnd?.(e, file)}
            onDragOver={(e) => onDragOver?.(e, file)}
            onDragLeave={(e) => onDragLeave?.(e, file)}
            onDrop={(e) => onDrop?.(e, file)}
            galleryMode={galleryMode}
          />
        );
      })}
      {appendItems}
    </div>
  );
}

interface FileGridItemProps {
  file: FileItem;
  isSelected: boolean;
  isCutItem?: boolean;
  isDragging?: boolean;
  onSelect: (event: React.MouseEvent<HTMLDivElement>) => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  draggable?: boolean;
  isDropTarget?: boolean;
  isDropSuccess?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  galleryMode?: boolean;
}

function FileGridItem({
  file,
  isSelected,
  isCutItem,
  isDragging,
  onSelect,
  onOpen,
  onContextMenu,
  draggable,
  isDropTarget,
  isDropSuccess,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  galleryMode = false,
}: FileGridItemProps) {
  // Paint the cheap preview the listing already advertises, then upgrade to
  // the larger tier once the server has it cached and the browser decodes it.
  const { thumbUrl, isFetchingThumbnail, dismissThumbnail } =
    useProgressiveThumbnail(
      file.isUploading ? undefined : resolveThumbnailSrc(file.thumbnail),
      file.isDirectory || file.isNoteMessage ? undefined : file.messageId,
    );
  const VideoSymbol = getDefaultFolderSymbol("Videos", "tg://saved/Videos");
  const showThumbnailPlaceholder =
    !file.isDirectory &&
    !!file.messageId &&
    !thumbUrl &&
    !file.isNoteMessage &&
    isFetchingThumbnail;

  return (
    <div
      data-file-item="true"
      data-file-path={file.path}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={
        galleryMode
          ? `group relative aspect-square overflow-hidden transition-all duration-200 ${
              isSelected
                ? "ring-2 ring-primary/70 ring-inset"
                : "hover:brightness-110"
            } ${isDropTarget ? "scale-[1.015] ring-2 ring-primary/70 ring-inset shadow-[0_12px_28px_rgba(84,169,244,0.16)]" : ""} ${isDropSuccess ? "ring-2 ring-primary/60 ring-inset shadow-[0_0_0_1px_rgba(84,169,244,0.08),0_10px_24px_rgba(84,169,244,0.12)]" : ""} ${isDragging ? "scale-[0.96] opacity-45" : ""} ${isCutItem ? "opacity-50 grayscale" : ""}`
          : `group flex flex-col items-center p-2 rounded-xl transition-[transform,opacity,background-color,box-shadow,border-color] duration-200 ease-out border ${
              isSelected
                ? "bg-sidebar-accent border-primary/30 shadow-lg shadow-primary/5"
                : "hover:bg-sidebar-accent/50 border-transparent hover:border-border"
            } ${isDropTarget ? "translate-y-[-1px] scale-[1.02] ring-1 ring-primary/60 bg-primary/10 shadow-[0_12px_28px_rgba(84,169,244,0.14)]" : ""} ${isDropSuccess ? "ring-1 ring-primary/55 bg-primary/10 shadow-[0_0_0_1px_rgba(84,169,244,0.08),0_10px_24px_rgba(84,169,244,0.12)]" : ""} ${isDragging ? "scale-[0.97] opacity-45" : ""} ${isCutItem ? "opacity-50 grayscale" : ""}`
      }
    >
      <div
        className={
          galleryMode
            ? "relative flex h-full w-full items-center justify-center overflow-hidden transition-colors"
            : "relative mb-3 mx-auto flex aspect-square max-h-24 w-full max-w-24 items-center justify-center overflow-hidden transition-colors"
        }
      >
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={file.name}
            className={`w-full h-full ${galleryMode ? "object-cover" : "object-cover"}`}
            onError={dismissThumbnail}
          />
        ) : showThumbnailPlaceholder ? (
          <>
            <div className="absolute inset-0 bg-gradient-to-br from-secondary/60 via-secondary/20 to-secondary/60 animate-pulse" />
            <ThemedFileIcon
              file={file}
              size={galleryMode ? "md" : "lg"}
              className="relative z-[1] h-full w-full"
            />
          </>
        ) : (
          <ThemedFileIcon
            file={file}
            size={galleryMode ? "md" : "lg"}
            className="h-full w-full"
          />
        )}

        {file.isUploading ? (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-primary/10 animate-pulse" />
            <div className="absolute bottom-0 left-0 right-0 h-[4px] bg-primary/35" />
          </div>
        ) : null}

        {/* Overlay for directories or media indicators */}
        {file.isDirectory && (
          <div className="absolute inset-0 bg-primary/5 pointer-events-none" />
        )}

        {galleryMode &&
        file.extension?.match(/^(mp4|mkv|mov|avi|webm|wmv|m4v)$/i) ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/50 text-white/95 shadow-[0_8px_24px_rgba(0,0,0,0.3)] backdrop-blur-sm">
              {VideoSymbol ? <VideoSymbol className="h-7 w-7" /> : null}
            </div>
          </div>
        ) : null}
      </div>

      {!galleryMode ? (
        <div className="w-full text-center">
          <div className="w-full px-1 flex items-center justify-center gap-2">
            <p
              className="text-body font-medium text-foreground truncate"
              title={file.name}
            >
              {file.name}
            </p>
            {file.isUploading ? (
              <Skeleton className="skeleton-shimmer h-3 w-10 bg-secondary/45" />
            ) : null}
          </div>
          {!file.isDirectory && (
            <p className="text-small text-muted-foreground mt-0.5">
              {formatFileSize(file.size)}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
