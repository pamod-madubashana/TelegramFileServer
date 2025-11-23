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
  const [currentPath, setCurrentPath] = useState<string[]>(["All Files"]);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [deleteDialog, setDeleteDialog] = useState<{ item: FileItem; index: number } | null>(null);
  const [renamingItem, setRenamingItem] = useState<{ item: FileItem; index: number } | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<string>("all");

  const { files, isLoading, isError, error } = useFiles();
  const { clipboard, copyItem, cutItem, clearClipboard, hasClipboard } = useFileOperations();


  const currentFolder = currentPath[currentPath.length - 1];

  // Filter files based on selected filter and search query
  const filteredItems = files.filter((item) => {
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase());

    if (selectedFilter === "all") return matchesSearch;

    // Filter by file type
    return matchesSearch && item.fileType === selectedFilter;
  });

  const handleNavigate = (folderName: string) => {
    // For now, we don't have folder navigation since API returns flat list
    // This could be extended later if needed
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
    setCurrentPath(["All Files"]);
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
