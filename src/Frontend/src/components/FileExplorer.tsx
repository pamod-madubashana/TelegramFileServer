import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileItem } from "@/components/types";
import { useFiles } from "@/hooks/useFiles";
import { useFileOperations } from "@/hooks/useFileOperations";
import { toast } from "sonner";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { FileGrid } from "./FileGrid";
import { DeleteDialog } from "./DeleteDialog";
import { NewFolderDialog } from "./NewFolderDialog";
import { RenameInput } from "./RenameInput";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { getApiBaseUrl, resetApiBaseUrl, updateApiBaseUrl, fetchWithTimeout } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const FileExplorer = () => {
  // Initialize currentPath from localStorage or default to ["Home"]
  const [currentPath, setCurrentPath] = useState<string[]>(() => {
    const savedPath = localStorage.getItem('fileExplorerPath');
    if (savedPath) {
      try {
        const parsedPath = JSON.parse(savedPath);
        if (Array.isArray(parsedPath)) {
          return parsedPath;
        }
      } catch (e) {
        console.error('Failed to parse saved path', e);
      }
    }
    return ["Home"];
  });
  
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedFilter, setSelectedFilter] = useState<string>("all");
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<{ item: FileItem; index: number } | null>(null);
  const [renamingItem, setRenamingItem] = useState<{ item: FileItem; index: number } | null>(null);
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [newBackendUrl, setNewBackendUrl] = useState("");
  const queryClient = useQueryClient();

  // Save currentPath to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('fileExplorerPath', JSON.stringify(currentPath));
  }, [currentPath]);

  // Update browser history when currentPath changes
  useEffect(() => {
    // Update the browser history with the new path
    const pathString = currentPath.length === 1 && currentPath[0] === "Home" 
      ? "/" 
      : "/" + currentPath.join('/');
    
    // Use replaceState for the initial load to avoid creating extra history entries
    if (window.history.state === null) {
      window.history.replaceState({ path: currentPath }, '', pathString);
    } else {
      window.history.pushState({ path: currentPath }, '', pathString);
    }
  }, [currentPath]);

  // Handle browser back/forward buttons
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (event.state && event.state.path) {
        setCurrentPath(event.state.path);
      } else {
        // Parse the path from the URL
        const pathSegments = window.location.pathname.split('/').filter(segment => segment.length > 0);
        if (pathSegments.length === 0) {
          setCurrentPath(["Home"]);
        } else {
          setCurrentPath(pathSegments);
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

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

  const handleBreadcrumbClick = (index: number) => {
    if (index === 0) {
      // If clicking on Home, explicitly set to Home
      setCurrentPath(["Home"]);
    } else {
      setCurrentPath(currentPath.slice(0, index + 1));
    }
  };

  const handleCopy = (item: FileItem) => {
    // Construct the source path correctly
    let sourcePath = "/";
    if (currentPath.length > 1) {
      sourcePath = `/${currentPath.slice(1).join('/')}`;
    }
    copyItem(item, sourcePath);
    toast.success(`Copied "${item.name}"`);
  };

  const handleCut = (item: FileItem) => {
    // Construct the source path correctly
    let sourcePath = "/";
    if (currentPath.length > 1) {
      sourcePath = `/${currentPath.slice(1).join('/')}`;
    }
    cutItem(item, sourcePath);
    toast.success(`Cut "${item.name}"`);
  };

  const handlePaste = async () => {
    try {
      // Construct the target path
      let targetPath = "/";
      if (currentPath.length > 1) {
        targetPath = `/${currentPath.slice(1).join('/')}`;
      }
      
      console.log("DEBUG: Pasting to", { targetPath });
      
      await pasteItem(targetPath);
      toast.success("Operation completed successfully");
      refetch(); // Refresh the file list
    } catch (error: any) {
      toast.error(error.message || "Failed to complete operation");
      console.error(error);
    }
  };

  const handleFilterChange = (filter: string) => {
    // Map filter to folder name
    const folderMap: Record<string, string> = {
      all: "Home",
      photo: "Images",
      document: "Documents",
      video: "Videos",
      audio: "Audio",
      voice: "Voice Messages"
    };
    
    const folderName = folderMap[filter] || "Home";
    setCurrentPath([folderName]);
    setSelectedFilter(filter);
  };

  const handleSidebarDrop = async (item: FileItem, targetFolderName: string) => {
    try {
      // Construct the source path correctly
      let sourcePath = "/";
      if (currentPath.length > 1) {
        sourcePath = `/${currentPath.slice(1).join('/')}`;
      }
      
      // Construct the target path
      let targetPath = "/";
      if (targetFolderName !== "Home") {
        // Map virtual folder names to their API paths
        const virtualFolderMap: Record<string, string> = {
          "Images": "/Images",
          "Documents": "/Documents",
          "Videos": "/Videos",
          "Audio": "/Audio",
          "Voice Messages": "/Voice Messages"
        };
        
        targetPath = virtualFolderMap[targetFolderName] || `/${targetFolderName}`;
      }
      
      console.log("DEBUG: Moving from", { sourcePath, targetPath });
      
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetchWithTimeout(`${apiUrl}/files/move`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_path: item.file_path,
          destination_path: targetPath,
        }),
      }, 3000); // 3 second timeout

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to move file");
      }

      toast.success(`Moved "${item.name}" to ${targetFolderName}`);
      refetch(); // Refresh the file list
    } catch (error: any) {
      toast.error(error.message || "Failed to move file");
      console.error(error);
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
      
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetchWithTimeout(`${apiUrl}/folders/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          folderName,
          currentPath: backendPath,
        }),
      }, 3000); // 3 second timeout

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

  // Show error state with recovery options
  useEffect(() => {
    if (isError) {
      const currentUrl = getApiBaseUrl();
      setErrorMessage(`Failed to connect to backend server at ${currentUrl}. Please check the URL and try again.`);
      setNewBackendUrl(currentUrl); // Pre-fill with current URL
      setErrorDialogOpen(true);
    }
  }, [isError]);

  const handleUrlChange = () => {
    // Validate and update the backend URL
    try {
      // Allow "/" as a special case for same-origin requests
      if (newBackendUrl === "/") {
        updateApiBaseUrl("/");
        window.location.reload();
        return;
      }
      
      // For full URLs, validate the format
      new URL(newBackendUrl);
      updateApiBaseUrl(newBackendUrl);
      window.location.reload();
    } catch {
      toast.error("Please enter a valid URL (e.g., http://localhost:8000)");
    }
  };

  // Add the missing functions
  const handleDelete = (item: FileItem) => {
    setDeleteDialog({ item, index: 0 }); // Index is not used in this context
  };

  const handleRename = (item: FileItem) => {
    setRenamingItem({ item, index: 0 }); // Index is not used in this context
  };

  const handleMove = (item: FileItem) => {
    // This would typically open a move dialog, but for now we'll just show a toast
    toast.info(`Move functionality for "${item.name}" would be implemented here`);
  };

  const handleDownload = (item: FileItem) => {
    try {
      const baseUrl = getApiBaseUrl();
      // Construct the download URL
      const downloadUrl = baseUrl 
        ? `${baseUrl}/dl${item.file_path}` 
        : `/dl${item.file_path}`;
      
      // Create a temporary link and trigger download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = item.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      toast.error("Failed to download file");
      console.error(error);
    }
  };

  const confirmRename = async (newName: string) => {
    if (!renamingItem) return;

    try {
      const item = renamingItem.item;
      
      // Construct the correct path for the backend
      let backendPath = "/";
      if (currentPath.length > 1) {
        // If we're in a nested folder, construct the full path
        backendPath = `/${currentPath.slice(1).join('/')}`;
      }
      
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetchWithTimeout(`${apiUrl}/files/rename`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_path: item.file_path,
          new_name: newName,
        }),
      }, 3000); // 3 second timeout

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to rename file");
      }

      toast.success(`Renamed "${item.name}" to "${newName}"`);
      setRenamingItem(null);
      // Refresh the file list for current path
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to rename file");
      console.error(error);
    }
  };

  const confirmDelete = async () => {
    if (!deleteDialog) return;

    try {
      const item = deleteDialog.item;
      
      // Construct the correct path for the backend
      let backendPath = "/";
      if (currentPath.length > 1) {
        // If we're in a nested folder, construct the full path
        backendPath = `/${currentPath.slice(1).join('/')}`;
      }
      
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetchWithTimeout(`${apiUrl}/files/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          file_path: item.file_path,
        }),
      }, 3000); // 3 second timeout

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to delete file");
      }

      toast.success(`Deleted "${item.name}"`);
      setDeleteDialog(null);
      // Refresh the file list for current path
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to delete file");
      console.error(error);
    }
  };

  const cancelDelete = () => {
    setDeleteDialog(null);
  };

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
          onBack={() => window.history.back()}
          onBreadcrumbClick={handleBreadcrumbClick}
          onPaste={hasClipboard ? handlePaste : undefined}
        />

        <FileGrid
          items={filteredItems}
          viewMode={viewMode}
          onNavigate={handleNavigate}
          itemCount={filteredItems.length}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={hasClipboard ? handlePaste : undefined}
          onDelete={handleDelete}
          onRename={handleRename}
          onMove={handleMove}
          onDownload={handleDownload}
          renamingItem={renamingItem}
          onRenameConfirm={confirmRename}
          onRenameCancel={() => setRenamingItem(null)}
          currentFolder={currentFolder}
          onNewFolder={() => setNewFolderDialogOpen(true)}
          isLoading={isLoading}
        />
      </div>

      <DeleteConfirmDialog
        open={!!deleteDialog}
        itemName={deleteDialog?.item.name || ""}
        itemType={deleteDialog?.item.type || "file"}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />

      <NewFolderDialog
        open={newFolderDialogOpen}
        currentPath={currentApiPath}  // Pass the full path, not just the folder name
        onClose={() => setNewFolderDialogOpen(false)}
        onConfirm={handleNewFolder}
      />

      {/* Custom Error Dialog with URL change option */}
      <Dialog open={errorDialogOpen} onOpenChange={setErrorDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connection Error</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-4">
              {errorMessage || "Failed to connect to the backend server. Please check your connection settings."}
            </p>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-backend-url">New Backend URL</Label>
                <Input
                  id="new-backend-url"
                  value={newBackendUrl}
                  onChange={(e) => setNewBackendUrl(e.target.value)}
                  placeholder="https://your-server.com"
                />
              </div>
              <p className="text-sm font-mono bg-muted p-2 rounded">
                Current URL: {getApiBaseUrl()}
              </p>
              <div className="flex flex-col gap-2">
                <Button onClick={handleUrlChange}>
                  Change URL and Continue
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    resetApiBaseUrl();
                    window.location.reload();
                  }}
                >
                  Reset to Default Settings
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setErrorDialogOpen(false);
                    refetch();
                  }}
                >
                  Retry Connection
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-4">
              Tip: Press Ctrl+Alt+R to reset settings from anywhere
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};