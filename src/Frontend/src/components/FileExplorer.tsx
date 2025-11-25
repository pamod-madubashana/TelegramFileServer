import { useState, useEffect } from "react";
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
    } else {
      // If we're already at the root, explicitly set to Home
      setCurrentPath(["Home"]);
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

  const handleDelete = async (item: FileItem, index: number) => {
    // Set the item to be deleted and show custom confirmation dialog
    setDeleteDialog({ item, index });
  };

  const confirmDelete = async () => {
    if (!deleteDialog) return;
    
    const { item, index } = deleteDialog;
    
    try {
      // Construct the request
      const request = {
        file_id: item.id || ""
      };
      
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetchWithTimeout(`${apiUrl}/files/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(request),
      }, 3000); // 3 second timeout

      if (!response.ok) {
        throw new Error("Failed to delete file");
      }
      
      toast.success(`Deleted "${item.name}" successfully`);
      
      // Get the current path for cache invalidation
      let currentApiPath = "/";
      if (currentPath.length > 1) {
        currentApiPath = `/${currentPath.slice(1).join('/')}`;
      }
      
      // Refresh the current path data to immediately update the UI
      queryClient.invalidateQueries({ queryKey: ['files', currentApiPath] });
      queryClient.refetchQueries({ queryKey: ['files', currentApiPath] });
      
      refetch(); // Refresh the file list
    } catch (error: any) {
      toast.error(error.message || "Failed to delete file");
      console.error(error);
    } finally {
      // Close the delete dialog
      setDeleteDialog(null);
    }
  };

  const cancelDelete = () => {
    setDeleteDialog(null);
  };

  const handleRename = (item: FileItem, index: number) => {
    setRenamingItem({ item, index });
  };

  const confirmRename = async (newName: string) => {
    if (!renamingItem) return;
    
    try {
      // Call the rename API
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetchWithTimeout(`${apiUrl}/files/rename`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          file_id: renamingItem.item.id,
          new_name: newName
        }),
      }, 3000); // 3 second timeout

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to rename item");
      }
      
      toast.success(`Renamed "${renamingItem.item.name}" to "${newName}" successfully`);
      
      // Get the current path for cache invalidation
      let currentApiPath = "/";
      if (currentPath.length > 1) {
        currentApiPath = `/${currentPath.slice(1).join('/')}`;
      }
      
      // Refresh the current path data to immediately update the UI
      queryClient.invalidateQueries({ queryKey: ['files', currentApiPath] });
      queryClient.refetchQueries({ queryKey: ['files', currentApiPath] });
      
      refetch(); // Refresh the file list
    } catch (error: any) {
      toast.error(error.message || "Failed to rename item");
      console.error(error);
    } finally {
      setRenamingItem(null);
    }
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
      
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetchWithTimeout(`${apiUrl}/files/move`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(request),
      }, 3000); // 3 second timeout

      if (!response.ok) {
        throw new Error("Failed to move file");
      }
      
      toast.success(`Moved "${item.name}" successfully`);
      
      // Source path is the current path where the file was moved from
      let sourcePath = "/";
      if (currentPath.length > 1) {
        sourcePath = `/${currentPath.slice(1).join('/')}`;
      }
      
      // Refresh both source and target paths from the server
      queryClient.invalidateQueries({ queryKey: ['files', sourcePath] });
      queryClient.invalidateQueries({ queryKey: ['files', targetPath] });
      
      // Force a refetch of the source path data to immediately update the UI
      queryClient.refetchQueries({ queryKey: ['files', sourcePath] });
      
      refetch(); // Refresh the current file list
    } catch (error: any) {
      toast.error(error.message || "Failed to move file");
      console.error(error);
    }
  };

  const handleDownload = (item: FileItem) => {
    try {
      // Create the download URL using the file name
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      const downloadUrl = `${apiUrl}/dl/${encodeURIComponent(item.name)}`;
      
      // Create a temporary anchor element
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = item.name; // Set the download attribute to the file name
      link.style.display = 'none';
      
      // Add to DOM, click and remove
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      toast.success(`Downloading "${item.name}"`);
    } catch (error: any) {
      toast.error(error.message || "Failed to download file");
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
      
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetchWithTimeout(`${apiUrl}/files/move`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(request),
      }, 3000); // 3 second timeout

      if (!response.ok) {
        throw new Error("Failed to move file");
      }
      
      toast.success(`Moved "${item.name}" successfully`);
      
      // Source path is the current path where the file was moved from
      let sourcePath = "/";
      if (currentPath.length > 1) {
        sourcePath = `/${currentPath.slice(1).join('/')}`;
      }
      
      // Refresh both source and target paths from the server
      queryClient.invalidateQueries({ queryKey: ['files', sourcePath] });
      queryClient.invalidateQueries({ queryKey: ['files', targetPath] });
      
      // Force a refetch of the source path data to immediately update the UI
      queryClient.refetchQueries({ queryKey: ['files', sourcePath] });
      
      refetch(); // Refresh the current file list
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
      // Explicitly set to Home when navigating to the root
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