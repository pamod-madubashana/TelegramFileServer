import { useState, useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { FileGrid } from "./FileGrid";
import { FileItem } from "./types";
import { useFileOperations } from "@/hooks/useFileOperations";
import { useFiles } from "@/hooks/useFiles";
import { DeleteDialog } from "./DeleteDialog";
import { NewFolderDialog } from "./NewFolderDialog";
import { toast } from "sonner";

export const FileExplorer = () => {
  const [currentPath, setCurrentPath] = useState<string[]>(["Home"]);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [deleteDialog, setDeleteDialog] = useState<{ item: FileItem; index: number } | null>(null);
  const [renamingItem, setRenamingItem] = useState<{ item: FileItem; index: number } | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<string>("all");
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);

  // Define virtual folders
  const virtualFolders: FileItem[] = [
    { name: "Images", type: "folder", icon: "📁", fileType: "photo" },
    { name: "Documents", type: "folder", icon: "📁", fileType: "document" },
    { name: "Videos", type: "folder", icon: "📁", fileType: "video" },
    { name: "Audio", type: "folder", icon: "📁", fileType: "audio" },
    { name: "Voice Messages", type: "folder", icon: "📁", fileType: "voice" },
  ];

  // Current folder name (last part of currentPath)
  const currentFolder = currentPath[currentPath.length - 1] || "Home";

  // Check if current folder is a virtual folder
  const isVirtualFolder = virtualFolders.some(f => f.name === currentFolder);

  // Convert currentPath to API path format
  // For virtual folders, use the folder name as path (e.g., /Images, /Documents)
  const currentApiPath = isVirtualFolder
    ? `/${currentFolder}`
    : currentPath.length === 1 && currentPath[0] === "Home"
      ? "/"
      : `/${currentPath.slice(1).join('/')}`;

  const { files, isLoading, isError, error, refetch } = useFiles(currentApiPath);
  const { clipboard, copyItem, cutItem, clearClipboard, hasClipboard, pasteItem } = useFileOperations();

  // Filter files based on current path and search query
  const getFilteredItems = (): FileItem[] => {
    // If we're in Home and no filter is selected, show virtual folders and user-created folders
    if (currentFolder === "Home" && selectedFilter === "all") {
      const filteredFolders = virtualFolders.filter((folder) =>
        folder.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      // Add user-created folders (those with type 'folder')
      const userFolders = files.filter((f) => f.type === "folder");
      const filteredUserFolders = userFolders.filter((folder) =>
        folder.name.toLowerCase().includes(searchQuery.toLowerCase())
      );

      return [...filteredFolders, ...filteredUserFolders];
    }

    // If we're in a specific folder or have a filter, show files
    let filteredFiles = files;

    // Filter by folder/type
    if (currentFolder === "Images" || selectedFilter === "photo") {
      // Show photos AND folders in the Images path
      filteredFiles = files.filter((f) => f.fileType === "photo" || f.type === "folder");
    } else if (currentFolder === "Documents" || selectedFilter === "document") {
      // Show documents AND folders in the Documents path
      filteredFiles = files.filter((f) => f.fileType === "document" || f.type === "folder");
    } else if (currentFolder === "Videos" || selectedFilter === "video") {
      // Show videos AND folders in the Videos path
      filteredFiles = files.filter((f) => f.fileType === "video" || f.type === "folder");
    } else if (currentFolder === "Audio" || selectedFilter === "audio") {
      // Show audio AND folders in the Audio path
      filteredFiles = files.filter((f) => f.fileType === "audio" || f.type === "folder");
    } else if (currentFolder === "Voice Messages" || selectedFilter === "voice") {
      // Show voice messages AND folders in the Voice Messages path
      filteredFiles = files.filter((f) => f.fileType === "voice" || f.type === "folder");
    } else if (currentFolder !== "Home") {
      // For user-created folders, we just show the files returned by the API
      // The API already filters by path, so we don't need to filter here
      filteredFiles = files;
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
    const isUserFolder = files.some(f => f.type === "folder" && f.name === folderName);

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

  const handlePaste = async () => {
    try {
      // Construct the target path
      let targetPath = "/";
      if (currentPath.length > 1) {
        targetPath = `/${currentPath.slice(1).join('/')}`;
      }
      
      await pasteItem(targetPath);
      toast.success("Operation completed successfully");
      refetch(); // Refresh the file list
    } catch (error: any) {
      toast.error(error.message || "Failed to complete operation");
      console.error(error);
    }
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

  const handleMove = async (item: FileItem, targetFolder: FileItem) => {
    try {
      // The target path should be the path of the target folder + the folder name
      // For example, if targetFolder has path "/" and name "TestFolder", 
      // the target path for files moved into it should be "/TestFolder"
      let targetPath = "/";
      if (targetFolder.file_path === "/") {
        targetPath = `/${targetFolder.name}`;
      } else {
        targetPath = `${targetFolder.file_path}/${targetFolder.name}`;
      }
      
      // For the move operation, we need to construct the request
      const request = {
        file_id: item.id || "",
        target_path: targetPath
      };
      
      const response = await fetch("/api/files/move", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(request),
      });
      
      if (!response.ok) {
        throw new Error("Failed to move file");
      }
      
      toast.success(`Moved "${item.name}" successfully`);
      refetch(); // Refresh the file list
    } catch (error: any) {
      toast.error(error.message || "Failed to move file");
      console.error(error);
    }
  };

  // Create a separate function for the Sidebar's onDrop
  const handleSidebarDrop = async (item: FileItem, targetFolderName: string) => {
    try {
      // Map the target folder name to its path
      let targetPath = "/";
      switch (targetFolderName) {
        case "Images":
          targetPath = "/Images";
          break;
        case "Documents":
          targetPath = "/Documents";
          break;
        case "Videos":
          targetPath = "/Videos";
          break;
        case "Audio":
          targetPath = "/Audio";
          break;
        case "Voice Messages":
          targetPath = "/Voice Messages";
          break;
        default:
          targetPath = "/";
      }
      
      // For the move operation, we need to construct the request
      const request = {
        file_id: item.id || "",
        target_path: targetPath
      };
      
      const response = await fetch("/api/files/move", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(request),
      });
      
      if (!response.ok) {
        throw new Error("Failed to move file");
      }
      
      toast.success(`Moved "${item.name}" successfully`);
      refetch(); // Refresh the file list
    } catch (error: any) {
      toast.error(error.message || "Failed to move file");
      console.error(error);
    }
  };

  const handleFilterChange = (filter: string) => {
    setSelectedFilter(filter);

    // Map filter to virtual folder name to ensure we fetch the correct files
    const filterToFolder: Record<string, string> = {
      "photo": "Images",
      "document": "Documents",
      "video": "Videos",
      "audio": "Audio",
      "voice": "Voice Messages",
      "all": "Home"
    };

    const folderName = filterToFolder[filter];
    if (folderName && folderName !== "Home") {
      setCurrentPath(["Home", folderName]);
    } else {
      setCurrentPath(["Home"]);
    }
  };

  const handleNewFolder = async (folderName: string) => {
    try {
      // Construct the correct path for the backend
      let backendPath = "/";
      if (currentPath.length > 1) {
        // If we're in a nested folder, construct the full path
        backendPath = `/${currentPath.slice(1).join('/')}`;
      }
      
      const response = await fetch("/api/folders/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          folderName,
          currentPath: backendPath,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to create folder");
      }

      toast.success(`Folder "${folderName}" created successfully`);
      setNewFolderDialogOpen(false);
      // Refresh the file list for current path
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to create folder");
      console.error(error);
    }
  };

  // Show loading state
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
        onDrop={handleSidebarDrop}
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
          onNewFolder={() => setNewFolderDialogOpen(true)}
          isLoading={isLoading}
        />
      </div>

      <DeleteDialog
        open={!!deleteDialog}
        itemName={deleteDialog?.item.name || ""}
        itemType={deleteDialog?.item.type || "file"}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteDialog(null)}
      />
      
      <NewFolderDialog
        open={newFolderDialogOpen}
        currentPath={currentApiPath}  // Pass the full path, not just the folder name
        onClose={() => setNewFolderDialogOpen(false)}
        onConfirm={handleNewFolder}
      />
    </div>
  );
};
