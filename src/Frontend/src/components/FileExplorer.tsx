import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { FileGrid } from "./FileGrid";
import { FileItem } from "./types";
import { useFileOperations } from "@/hooks/useFileOperations";
import { DeleteDialog } from "./DeleteDialog";
import { toast } from "sonner";

const mockFileSystem: Record<string, FileItem[]> = {
  Pictures: [
    { name: "Camera Roll", type: "folder", icon: "📁" },
    { name: "Chrom.bg", type: "folder", icon: "📁" },
    { name: "Feedback", type: "folder", icon: "📁" },
    { name: "Grub", type: "folder", icon: "📁" },
    { name: "MEmu Photo", type: "folder", icon: "📁" },
    { name: "Photos", type: "folder", icon: "📁" },
    { name: "Saved Pictures", type: "folder", icon: "📁" },
    { name: "Screenshots", type: "folder", icon: "📁" },
    { name: "SS", type: "folder", icon: "📁" },
    { name: "UbisoftConnect", type: "folder", icon: "📁" },
    { name: "v-log", type: "folder", icon: "📁" },
    { name: "Wallpapers", type: "folder", icon: "📁" },
    { name: "capsule_616x353.jpg", type: "file", icon: "🖼️", extension: "jpg" },
    { name: "doc.pdf", type: "file", icon: "📄", extension: "pdf" },
    { name: "MtFlash20220507.zip", type: "file", icon: "📦", extension: "zip" },
    { name: "Screenshot 2023-06-17 182445.png", type: "file", icon: "🖼️", extension: "png" },
  ],
  "Camera Roll": [
    { name: "photo1.jpg", type: "file", icon: "🖼️", extension: "jpg" },
    { name: "photo2.jpg", type: "file", icon: "🖼️", extension: "jpg" },
  ],
  Desktop: [
    { name: "Project.docx", type: "file", icon: "📄", extension: "docx" },
  ],
  Downloads: [
    { name: "setup.exe", type: "file", icon: "⚙️", extension: "exe" },
  ],
  Documents: [],
  Music: [],
  Videos: [],
};

export const FileExplorer = () => {
  const [currentPath, setCurrentPath] = useState<string[]>(["Pictures"]);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [deleteDialog, setDeleteDialog] = useState<{ item: FileItem; index: number } | null>(null);
  const [renamingItem, setRenamingItem] = useState<{ item: FileItem; index: number } | null>(null);
  const [fileSystem, setFileSystem] = useState(mockFileSystem);

  const { clipboard, copyItem, cutItem, clearClipboard, hasClipboard } = useFileOperations();

  const currentFolder = currentPath[currentPath.length - 1];
  const currentItems = fileSystem[currentFolder] || [];

  const filteredItems = currentItems.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleNavigate = (folderName: string) => {
    if (mockFileSystem[folderName]) {
      setCurrentPath([...currentPath, folderName]);
    }
  };

  const handleBack = () => {
    if (currentPath.length > 1) {
      setCurrentPath(currentPath.slice(0, -1));
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    setCurrentPath(currentPath.slice(0, index + 1));
  };

  const handleCopy = (item: FileItem) => {
    copyItem(item, currentFolder);
    toast.success(`Copied "${item.name}"`);
  };

  const handleCut = (item: FileItem) => {
    cutItem(item, currentFolder);
    toast.success(`Cut "${item.name}"`);
  };

  const handlePaste = () => {
    if (!clipboard) return;

    const newFileSystem = { ...fileSystem };
    const targetFolder = currentFolder;

    // Check if item already exists in target folder
    const exists = newFileSystem[targetFolder]?.some(
      (item) => item.name === clipboard.item.name
    );

    if (exists) {
      toast.error(`"${clipboard.item.name}" already exists in this folder`);
      return;
    }

    // Add item to target folder
    if (!newFileSystem[targetFolder]) {
      newFileSystem[targetFolder] = [];
    }
    newFileSystem[targetFolder] = [...newFileSystem[targetFolder], clipboard.item];

    // If cut operation, remove from source folder
    if (clipboard.operation === "cut") {
      newFileSystem[clipboard.sourcePath] = newFileSystem[clipboard.sourcePath].filter(
        (item) => item.name !== clipboard.item.name
      );
      clearClipboard();
      toast.success(`Moved "${clipboard.item.name}"`);
    } else {
      toast.success(`Pasted "${clipboard.item.name}"`);
    }

    setFileSystem(newFileSystem);
  };

  const handleDelete = (item: FileItem, index: number) => {
    setDeleteDialog({ item, index });
  };

  const confirmDelete = () => {
    if (!deleteDialog) return;

    const newFileSystem = { ...fileSystem };
    newFileSystem[currentFolder] = currentItems.filter((_, i) => i !== deleteDialog.index);
    
    // If it's a folder, remove its contents from fileSystem
    if (deleteDialog.item.type === "folder") {
      delete newFileSystem[deleteDialog.item.name];
    }

    setFileSystem(newFileSystem);
    toast.success(`Deleted "${deleteDialog.item.name}"`);
    setDeleteDialog(null);
  };

  const handleRename = (item: FileItem, index: number) => {
    setRenamingItem({ item, index });
  };

  const confirmRename = (newName: string) => {
    if (!renamingItem) return;

    const newFileSystem = { ...fileSystem };
    const oldName = renamingItem.item.name;
    
    // Check if name already exists
    const exists = currentItems.some(
      (item, i) => item.name === newName && i !== renamingItem.index
    );

    if (exists) {
      toast.error(`"${newName}" already exists`);
      setRenamingItem(null);
      return;
    }

    // Update item name
    newFileSystem[currentFolder][renamingItem.index] = {
      ...renamingItem.item,
      name: newName,
    };

    // If it's a folder, update the folder key in fileSystem
    if (renamingItem.item.type === "folder" && newFileSystem[oldName]) {
      newFileSystem[newName] = newFileSystem[oldName];
      delete newFileSystem[oldName];
    }

    setFileSystem(newFileSystem);
    toast.success(`Renamed to "${newName}"`);
    setRenamingItem(null);
  };

  const handleMove = (item: FileItem, targetFolder: string) => {
    const newFileSystem = { ...fileSystem };
    
    // Check if item already exists in target folder
    const exists = newFileSystem[targetFolder]?.some(
      (existingItem) => existingItem.name === item.name
    );

    if (exists) {
      toast.error(`"${item.name}" already exists in ${targetFolder}`);
      return;
    }

    // Remove from current folder
    newFileSystem[currentFolder] = currentItems.filter((i) => i.name !== item.name);

    // Add to target folder
    if (!newFileSystem[targetFolder]) {
      newFileSystem[targetFolder] = [];
    }
    newFileSystem[targetFolder] = [...newFileSystem[targetFolder], item];

    setFileSystem(newFileSystem);
    toast.success(`Moved "${item.name}" to ${targetFolder}`);
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar
        currentPath={currentPath}
        onNavigate={(folder) => setCurrentPath([folder])}
        onDrop={handleMove}
      />
      
      <div className="flex-1 flex flex-col">
        <TopBar
          currentPath={currentPath}
          searchQuery={searchQuery}
          viewMode={viewMode}
          onSearchChange={setSearchQuery}
          onViewModeChange={setViewMode}
          onBack={handleBack}
          onBreadcrumbClick={handleBreadcrumbClick}
          onPaste={hasClipboard() ? handlePaste : undefined}
        />
        
        <FileGrid
          items={filteredItems}
          viewMode={viewMode}
          onNavigate={handleNavigate}
          itemCount={filteredItems.length}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={hasClipboard() ? handlePaste : undefined}
          onDelete={handleDelete}
          onRename={handleRename}
          onMove={handleMove}
          renamingItem={renamingItem}
          onRenameConfirm={confirmRename}
          onRenameCancel={() => setRenamingItem(null)}
          currentFolder={currentFolder}
        />
      </div>

      <DeleteDialog
        open={!!deleteDialog}
        itemName={deleteDialog?.item.name || ""}
        itemType={deleteDialog?.item.type || "file"}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteDialog(null)}
      />
    </div>
  );
};
