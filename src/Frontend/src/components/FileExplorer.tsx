import { useState, useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { FileGrid } from "./FileGrid";
import { FileItem } from "./types";
import { useFileOperations } from "@/hooks/useFileOperations";
import { useFiles } from "@/hooks/useFiles";
import { DeleteDialog } from "./DeleteDialog";
import { toast } from "sonner";

export const FileExplorer = () => {
  const [currentPath, setCurrentPath] = useState<string[]>(["Home"]);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [deleteDialog, setDeleteDialog] = useState<{ item: FileItem; index: number } | null>(null);
  const [renamingItem, setRenamingItem] = useState<{ item: FileItem; index: number } | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<string>("all");

  const currentFolder = currentPath[currentPath.length - 1];

  // Define virtual folders
  const virtualFolders: FileItem[] = [
    { name: "Images", type: "folder", icon: "📁", fileType: "photo" },
    { name: "Documents", type: "folder", icon: "📁", fileType: "document" },
    { name: "Videos", type: "folder", icon: "📁", fileType: "video" },
    { name: "Audio", type: "folder", icon: "📁", fileType: "audio" },
    { name: "Voice Messages", type: "folder", icon: "📁", fileType: "voice" },
  ];

  // Check if current folder is a virtual folder
  const isVirtualFolder = virtualFolders.some(f => f.name === currentFolder);

  // Convert currentPath to API path format
  // For virtual folders, use "all" to fetch all files, otherwise use the actual path
  const currentApiPath = isVirtualFolder
    ? "all"  // Special value to fetch all files for virtual folders
    : currentPath.length === 1 && currentPath[0] === "Home"
      ? "/"
      : `/${currentPath.slice(1).join('/')}`;

  const { files, isLoading, isError, error, refetch } = useFiles(currentApiPath);
  const { clipboard, copyItem, cutItem, clearClipboard, hasClipboard } = useFileOperations();

  // Filter files based on current path and search query
  const getFilteredItems = (): FileItem[] => {
    // If we're in Home and no filter is selected, show virtual folders and user-created folders
    if (currentFolder === "Home" && selectedFilter === "all") {
      const filteredFolders = virtualFolders.filter((folder) =>
        folder.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      // Add user-created folders (those with type 'folder')
      const userFolders = files.filter((f) => f.type === "folder" || f.fileType === "folder");
      const filteredUserFolders = userFolders.filter((folder) =>
        folder.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      return [...filteredFolders, ...filteredUserFolders];
    }

    // If we're in a specific folder or have a filter, show files
    let filteredFiles = files;

    // Filter by folder/type
    if (currentFolder === "Images" || selectedFilter === "photo") {
      filteredFiles = files.filter((f) => f.fileType === "photo");
    } else if (currentFolder === "Documents" || selectedFilter === "document") {
      filteredFiles = files.filter((f) => f.fileType === "document");
    } else if (currentFolder === "Videos" || selectedFilter === "video") {
      filteredFiles = files.filter((f) => f.fileType === "video");
    } else if (currentFolder === "Audio" || selectedFilter === "audio") {
      filteredFiles = files.filter((f) => f.fileType === "audio");
    } else if (currentFolder === "Voice Messages" || selectedFilter === "voice") {
      filteredFiles = files.filter((f) => f.fileType === "voice");
    } else if (currentFolder !== "Home") {
      // Check if we're in a user-created folder
      const isUserFolder = files.some(f => (f.type === "folder" || f.fileType === "folder") && f.name === currentFolder);
      if (isUserFolder) {
        // Filter files that belong to this folder (by file_path or folder association)
        // For now, show empty array since files don't have file_path set yet
        // TODO: When files are moved to folders, filter by file_path === currentFolder
        filteredFiles = files.filter((f) => f.file_path === currentFolder);
      }
    }

    // Apply search filter
    if (searchQuery) {
      filteredFiles = filteredFiles.filter((item) =>
        item.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    return filteredFiles;
  };

  const filteredItems = getFilteredItems();

  const handleNavigate = (folderName: string) => {
    // Navigate into virtual folders OR user-created folders
    const isVirtualFolder = virtualFolders.some(f => f.name === folderName);
    const isUserFolder = files.some(f => (f.type === "folder" || f.fileType === "folder") && f.name === folderName);

    if (isVirtualFolder || isUserFolder) {
      setCurrentPath([...currentPath, folderName]);
      setSelectedFilter("all"); // Reset filter when navigating
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
    // Paste functionality disabled for now - requires backend API
    toast.info("Paste functionality coming soon");
  };

  const handleDelete = (item: FileItem, index: number) => {
    setDeleteDialog({ item, index });
  };

  const confirmDelete = () => {
    if (!deleteDialog) return;

    // Delete functionality disabled for now - requires backend API
    toast.info("Delete functionality coming soon");
    setDeleteDialog(null);
  };

  const handleRename = (item: FileItem, index: number) => {
    setRenamingItem({ item, index });
  };

  const confirmRename = (newName: string) => {
    if (!renamingItem) return;

    // Rename functionality disabled for now - requires backend API
    toast.info("Rename functionality coming soon");
    setRenamingItem(null);
  };

  const handleMove = (item: FileItem, targetFolder: string) => {
    // Move functionality disabled for now - requires backend API
    toast.info("Move functionality coming soon");
  };

  const handleFilterChange = (filter: string) => {
    setSelectedFilter(filter);
    setCurrentPath(["Home"]);
  };

  const handleNewFolder = async () => {
    const folderName = prompt("Enter folder name:");
    if (!folderName) return;

    try {
      const response = await fetch("/api/folders/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          folderName,
          currentPath: currentFolder,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to create folder");
      }

      toast.success(`Folder "${folderName}" created successfully`);
      // Refresh the file list for current path
      refetch();
    } catch (error) {
      toast.error("Failed to create folder");
      console.error(error);
    }
  };

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex h-screen bg-background text-foreground items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading files...</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (isError) {
    return (
      <div className="flex h-screen bg-background text-foreground items-center justify-center">
        <div className="text-center">
          <p className="text-destructive mb-4">Failed to load files</p>
          <p className="text-sm text-muted-foreground">{error?.message || "Unknown error"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar
        currentPath={currentPath}
        onNavigate={handleFilterChange}
        onDrop={handleMove}
        files={files}
        selectedFilter={selectedFilter}
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
          onNewFolder={handleNewFolder}
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
