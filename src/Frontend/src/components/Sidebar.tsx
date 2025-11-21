import { useState } from "react";
import { Home, Image, HardDrive, Download, FileText, Music, Video, Folder, Network } from "lucide-react";

interface SidebarProps {
  currentPath: string[];
  onNavigate: (folder: string) => void;
  onDrop: (item: any, targetFolder: string) => void;
}

export const Sidebar = ({ currentPath, onNavigate, onDrop }: SidebarProps) => {
  const currentFolder = currentPath[currentPath.length - 1];
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

  const folders = [
    { name: "Home", icon: Home, path: "Home" },
    { name: "Gallery", icon: Image, path: "Pictures", active: true },
    { name: "Desktop", icon: Folder, path: "Desktop" },
    { name: "Downloads", icon: Download, path: "Downloads" },
    { name: "Documents", icon: FileText, path: "Documents" },
    { name: "Music", icon: Music, path: "Music" },
    { name: "Videos", icon: Video, path: "Videos" },
  ];

  return (
    <div className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 text-sidebar-primary-foreground">
          <Image className="w-5 h-5 text-primary" />
          <span className="font-semibold">Pictures</span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {folders.map((folder) => {
          const Icon = folder.icon;
          const isActive = currentFolder === folder.path;
          const isDragOver = dragOverFolder === folder.path;
          
          return (
            <button
              key={folder.path}
              onClick={() => onNavigate(folder.path)}
              onDragOver={(e) => handleDragOver(e, folder.path)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, folder.path)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-all ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50"
              } ${isDragOver ? "ring-2 ring-primary ring-inset" : ""}`}
            >
              <Icon className="w-4 h-4" />
              <span>{folder.name}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-4">
        <div className="space-y-2">
          <button className="w-full flex items-center gap-3 px-2 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 rounded transition-colors">
            <HardDrive className="w-4 h-4" />
            <span>This PC</span>
          </button>
          <button className="w-full flex items-center gap-3 px-2 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 rounded transition-colors">
            <Network className="w-4 h-4" />
            <span>Network</span>
          </button>
        </div>
      </div>
    </div>
  );
};
