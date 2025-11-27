import { useState } from "react";
import { FileText, Image, Music, Video, Mic, FolderOpen } from "lucide-react";
import { FileItem } from "./types";

interface SidebarProps {
  currentPath: string[];
  onNavigate: (filter: string) => void;
  onDrop: (item: any, targetFolder: string) => void;
  files: FileItem[];
  selectedFilter: string;
}

export const Sidebar = ({ currentPath, onNavigate, onDrop, files, selectedFilter }: SidebarProps) => {
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  const handleDragOver = (e: React.DragEvent, folderPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(folderPath);
  };

  const handleDragLeave = () => {
    setDragOverFolder(null);
  };

  const handleDrop = (e: React.DragEvent, folderPath: string) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      const itemData = e.dataTransfer.getData("application/json");
      if (itemData) {
        const item = JSON.parse(itemData);
        onDrop(item, folderPath);
      }
    } catch (error) {
      console.error("Failed to parse dropped item:", error);
    }

    setDragOverFolder(null);
  };

  const filters = [
    { name: "Home", icon: FolderOpen, filter: "all" },
    { name: "Images", icon: Image, filter: "photo" },
    { name: "Documents", icon: FileText, filter: "document" },
    { name: "Videos", icon: Video, filter: "video" },
    { name: "Audio", icon: Music, filter: "audio" },
    { name: "Voice Messages", icon: Mic, filter: "voice" },
  ];

  return (
    <div className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 text-sidebar-foreground">
          <FolderOpen className="w-5 h-5 text-primary" />
          <span className="font-semibold">File Server</span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {filters.map((filter) => {
          const Icon = filter.icon;
          const isActive = selectedFilter === filter.filter;
          const isDragOver = dragOverFolder === filter.filter;

          return (
            <button
              key={filter.filter}
              onClick={() => onNavigate(filter.filter)}
              onDragOver={(e) => handleDragOver(e, filter.filter)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, filter.filter)}
              className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-all ${isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                } ${isDragOver ? "ring-2 ring-primary ring-inset" : ""}`}
            >
              <div className="flex items-center gap-3">
                <Icon className="w-4 h-4" />
                <span>{filter.name}</span>
              </div>
            </button>
          );
        })}
      </nav>
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
