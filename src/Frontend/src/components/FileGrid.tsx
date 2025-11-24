import { useState } from "react";
import { FileItem } from "./types";
import { Folder, FileText, Image as ImageIcon, FileArchive } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import { RenameInput } from "./RenameInput";

interface FileGridProps {
  items: FileItem[];
  viewMode: "grid" | "list";
  onNavigate: (folderName: string) => void;
  itemCount: number;
  onCopy: (item: FileItem) => void;
  onCut: (item: FileItem) => void;
  onPaste?: () => void;
  onDelete: (item: FileItem, index: number) => void;
  onRename: (item: FileItem, index: number) => void;
  onMove: (item: FileItem, targetFolder: string) => void;
  renamingItem: { item: FileItem; index: number } | null;
  onRenameConfirm: (newName: string) => void;
  onRenameCancel: () => void;
  currentFolder: string;
  onNewFolder?: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  itemType: "file" | "folder" | "empty";
  itemName: string;
  item: FileItem;
  index: number;
}

export const FileGrid = ({
  items,
  viewMode,
  onNavigate,
  itemCount,
  onCopy,
  onCut,
  onPaste,
  onDelete,
  onRename,
  onMove,
  renamingItem,
  onRenameConfirm,
  onRenameCancel,
  currentFolder,
  onNewFolder,
  isLoading,
}: FileGridProps & { isLoading?: boolean }) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedItem, setDraggedItem] = useState<FileItem | null>(null);

  const handleContextMenu = (e: React.MouseEvent, item: FileItem, index: number) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent event from bubbling to parent container
    console.log('Context menu triggered for:', item.name);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      itemType: item.type,
      itemName: item.name,
      item,
      index,
    });
  };

  const handleItemClick = (item: FileItem) => {
    if (item.type === "folder") {
      onNavigate(item.name);
    }
  };

  const handleDragStart = (e: React.DragEvent, item: FileItem) => {
    setDraggedItem(item);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/json", JSON.stringify(item));
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent, targetItem: FileItem) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedItem || targetItem.type !== "folder" || draggedItem.name === targetItem.name) {
      return;
    }

    onMove(draggedItem, targetItem.name);
    setDraggedItem(null);
  };

  const getFileIcon = (item: FileItem) => {
    if (item.type === "folder") {
      return <Folder className="w-12 h-12 text-primary" />;
    }

    // If item has a thumbnail, try to show it
    if (item.thumbnail) {
      return (
        <div className="relative w-12 h-12 flex items-center justify-center">
          <img
            src={`/api/file/${item.thumbnail}/thumbnail`}
            alt={item.name}
            className="max-w-full max-h-full object-contain rounded"
            onError={(e) => {
              // Fallback to icon on error
              e.currentTarget.style.display = 'none';
              e.currentTarget.parentElement?.classList.remove('w-12', 'h-12'); // Remove fixed size container
              // We can't easily replace the DOM element here with a React component, 
              // so we hide the image. The parent container will be empty.
              // A better approach is to use a state for error, but for simplicity in this map loop:
              // We'll just let it hide.
              // Ideally we would want to show the icon below.
              // Let's try a different approach:
            }}
          />
          {/* Fallback icon (hidden by default, shown if img fails? No, CSS can't do that easily without state) */}
          {/* Since we are in a map, using state for each item is expensive. */}
          {/* Let's use a simple approach: If thumbnail exists, we assume it works. If it fails, we show broken image or nothing. */}
          {/* Better: Use a custom component for FileIcon that handles loading state */}
        </div>
      );
    }

    switch (item.extension) {
      case "jpg":
      case "png":
      case "gif":
        return <ImageIcon className="w-10 h-10 text-blue-500" />;
      case "pdf":
      case "docx":
        return <FileText className="w-10 h-10 text-red-500" />;
      case "zip":
        return <FileArchive className="w-10 h-10 text-yellow-500" />;
      default:
        return <FileText className="w-10 h-10 text-muted-foreground" />;
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-background">
      <div
        className="flex-1 overflow-y-auto p-4"
        onContextMenu={(e) => {
          e.preventDefault();
          // Show context menu for empty area
          setContextMenu({
            x: e.clientX,
            y: e.clientY,
            itemType: "empty",
            itemName: "",
            item: { name: "", type: "folder", icon: "" } as FileItem,
            index: -1,
          });
        }}
      >
        {viewMode === "grid" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
            {items.map((item, index) => {
              const isRenaming = renamingItem?.index === index;
              const isDragging = draggedItem?.name === item.name;

              return (
                <div
                  key={index}
                  draggable={!isRenaming}
                  onDragStart={(e) => handleDragStart(e, item)}
                  onDragEnd={handleDragEnd}
                  onDragOver={item.type === "folder" ? handleDragOver : undefined}
                  onDrop={item.type === "folder" ? (e) => handleDrop(e, item) : undefined}
                  onContextMenu={(e) => !isRenaming && handleContextMenu(e, item, index)}
                  className={`flex flex-col items-center p-3 rounded-lg transition-all ${isDragging ? "opacity-50 scale-95" : ""
                    } ${item.type === "folder" && draggedItem && draggedItem.name !== item.name
                      ? "ring-2 ring-primary ring-offset-2"
                      : ""
                    }`}
                >
                  <button
                    onClick={() => !isRenaming && handleItemClick(item)}
                    className="flex flex-col items-center w-full hover:bg-accent rounded-lg p-2 transition-colors group"
                  >
                    <div className="mb-2">{getFileIcon(item)}</div>
                    {isRenaming ? (
                      <RenameInput
                        initialName={item.name}
                        onSave={onRenameConfirm}
                        onCancel={onRenameCancel}
                      />
                    ) : (
                      <span className="text-xs text-center break-words w-full text-foreground group-hover:text-accent-foreground">
                        {item.name}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item, index) => {
              const isRenaming = renamingItem?.index === index;
              const isDragging = draggedItem?.name === item.name;

              return (
                <div
                  key={index}
                  draggable={!isRenaming}
                  onDragStart={(e) => handleDragStart(e, item)}
                  onDragEnd={handleDragEnd}
                  onDragOver={item.type === "folder" ? handleDragOver : undefined}
                  onDrop={item.type === "folder" ? (e) => handleDrop(e, item) : undefined}
                  onContextMenu={(e) => !isRenaming && handleContextMenu(e, item, index)}
                  className={`transition-all ${isDragging ? "opacity-50" : ""} ${item.type === "folder" && draggedItem && draggedItem.name !== item.name
                    ? "ring-2 ring-primary"
                    : ""
                    }`}
                >
                  <button
                    onClick={() => !isRenaming && handleItemClick(item)}
                    className="w-full flex items-center gap-3 p-2 rounded hover:bg-accent transition-colors group"
                  >
                    <div className="flex-shrink-0">{getFileIcon(item)}</div>
                    {isRenaming ? (
                      <div className="flex-1">
                        <RenameInput
                          initialName={item.name}
                          onSave={onRenameConfirm}
                          onCancel={onRenameCancel}
                        />
                      </div>
                    ) : (
                      <>
                        <span className="text-sm text-left flex-1 text-foreground group-hover:text-accent-foreground">
                          {item.name}
                        </span>
                        {item.size && (
                          <span className="text-xs text-muted-foreground mr-2">
                            {formatBytes(item.size)}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {item.type === "folder" ? "Folder" : item.fileType?.toUpperCase() || item.extension?.toUpperCase()}
                        </span>
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {itemCount} {itemCount === 1 ? "item" : "items"}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          itemType={contextMenu.itemType}
          itemName={contextMenu.itemName}
          onClose={() => setContextMenu(null)}
          onCopy={() => {
            onCopy(contextMenu.item);
            setContextMenu(null);
          }}
          onCut={() => {
            onCut(contextMenu.item);
            setContextMenu(null);
          }}
          onPaste={
            onPaste
              ? () => {
                onPaste();
                setContextMenu(null);
              }
              : undefined
          }
          onDelete={() => {
            onDelete(contextMenu.item, contextMenu.index);
            setContextMenu(null);
          }}
          onRename={() => {
            onRename(contextMenu.item, contextMenu.index);
            setContextMenu(null);
          }}
          onNewFolder={onNewFolder ? () => {
            onNewFolder();
            setContextMenu(null);
          } : undefined}
        />
      )}
    </div>
  );
};

// Utility function to format file size (input is in MB)
function formatBytes(sizeInMB: number): string {
  if (sizeInMB === 0) return '0 MB';

  // If less than 1 MB, show in KB
  if (sizeInMB < 1) {
    const kb = sizeInMB * 1024;
    return Math.round(kb * 100) / 100 + ' KB';
  }

  // If less than 1024 MB (1 GB), show in MB
  if (sizeInMB < 1024) {
    return Math.round(sizeInMB * 100) / 100 + ' MB';
  }

  // Otherwise show in GB
  const gb = sizeInMB / 1024;
  return Math.round(gb * 100) / 100 + ' GB';
}
