import { FolderArtwork } from "@/components/skybox/FolderArtwork";
import { type FolderSettings } from "@/lib/folder-settings";

interface FolderProps {
  name: string;
  path?: string;
  settings?: FolderSettings | null;
  selected?: boolean;
  isCutItem?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  isDropSuccess?: boolean;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

const Folder = ({
  name,
  path,
  settings,
  selected,
  isCutItem,
  isDragging,
  isDropTarget,
  isDropSuccess,
  onClick,
  onDoubleClick,
  onContextMenu,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: FolderProps) => {
  return (
    <div
      data-file-item="true"
      data-file-path={path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`group flex flex-col items-center rounded-2xl border px-2 py-2 transition-[transform,opacity,background-color,box-shadow,border-color] duration-200 ease-out ${
        selected
          ? "bg-sidebar-accent/70 border-primary/25 shadow-[0_18px_40px_rgba(0,0,0,0.18)]"
          : "border-transparent hover:border-border hover:bg-sidebar-accent/50"
      } ${isDropTarget ? "translate-y-[-1px] scale-[1.02] ring-1 ring-primary/60 bg-primary/10 shadow-[0_12px_28px_rgba(84,169,244,0.14)]" : ""} ${isDropSuccess ? "ring-1 ring-primary/55 bg-primary/10 shadow-[0_0_0_1px_rgba(84,169,244,0.08),0_10px_28px_rgba(84,169,244,0.12)]" : ""} ${isDragging ? "scale-[0.97] opacity-45" : ""} ${isCutItem ? "opacity-50 grayscale" : ""}`}
    >
      <div
        className={`relative mb-2 mx-auto flex aspect-square max-h-24 w-full max-w-24 items-center justify-center overflow-hidden rounded-xl transition-[transform,opacity,filter] duration-200 ease-out ${
          isDragging
            ? "scale-[0.94] opacity-80"
            : isDropTarget
              ? "scale-[1.04] brightness-110"
              : isDropSuccess
                ? "scale-[1.02] brightness-105"
                : ""
        }`}
      >
        <div className="relative transition-[filter] duration-200 ease-out group-hover:brightness-[1.04]">
          <FolderArtwork
            name={name}
            path={path}
            settings={settings}
            size={100}
            folderClassName="drop-shadow-[0_12px_18px_rgba(0,0,0,0.32)] group-hover:drop-shadow-[0_18px_28px_rgba(0,0,0,0.4)]"
            symbolClassName="absolute left-1/2 top-[56%] h-7 w-7 -translate-x-1/2 -translate-y-1/2 text-black/75 mix-blend-multiply"
            badgeClassName="-right-1 top-1"
          />
        </div>
      </div>

      <div className="w-full text-center">
        <p
          className={`w-full truncate px-1 text-[0.965rem] font-semibold tracking-[-0.01em] text-foreground/92 drop-shadow-[0_1px_1px_rgba(0,0,0,0.22)] transition-[opacity,color] duration-200 ease-out group-hover:text-foreground ${
            isDragging ? "opacity-75" : ""
          }`}
          title={name}
        >
          {name}
        </p>
      </div>
    </div>
  );
};

export default Folder;
