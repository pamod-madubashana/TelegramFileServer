import { useEffect, useRef } from "react";
import {
  FolderOpen,
  Pencil,
  Trash2,
  Copy,
  Scissors,
  Clipboard,
  Info,
  Download,
  Share2,
} from "lucide-react";

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  itemType: "file" | "folder";
  itemName: string;
  onCopy: () => void;
  onCut: () => void;
  onPaste?: () => void;
  onDelete: () => void;
  onRename: () => void;
}

export const ContextMenu = ({
  x,
  y,
  onClose,
  itemType,
  itemName,
  onCopy,
  onCut,
  onPaste,
  onDelete,
  onRename,
}: ContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleScroll = () => {
      onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("wheel", handleScroll);
    document.addEventListener("contextmenu", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("wheel", handleScroll);
      document.removeEventListener("contextmenu", handleClickOutside);
    };
  }, [onClose]);

  const handleAction = (action: string) => {
    switch (action) {
      case "open":
        onClose();
        break;
      case "rename":
        onRename();
        break;
      case "copy":
        onCopy();
        break;
      case "cut":
        onCut();
        break;
      case "paste":
        onPaste?.();
        break;
      case "delete":
        onDelete();
        break;
      default:
        console.log(`${action} on ${itemName}`);
        onClose();
    }
  };

  const menuItems = [
    ...(itemType === "folder"
      ? [{ icon: FolderOpen, label: "Open", action: "open" }]
      : [{ icon: Download, label: "Open", action: "open" }]),
    { icon: Pencil, label: "Rename", action: "rename", divider: true },
    { icon: Copy, label: "Copy", action: "copy" },
    { icon: Scissors, label: "Cut", action: "cut" },
    ...(onPaste ? [{ icon: Clipboard, label: "Paste", action: "paste", divider: true }] : [{ divider: true } as any]),
    { icon: Share2, label: "Share", action: "share", divider: true },
    { icon: Trash2, label: "Delete", action: "delete", danger: true, divider: true },
    { icon: Info, label: "Properties", action: "properties" },
  ];

  // Adjust position to keep menu on screen
  const adjustedX = Math.min(x, window.innerWidth - 220);
  const adjustedY = Math.min(y, window.innerHeight - menuItems.length * 40);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-popover border border-border rounded-lg shadow-xl py-1 w-56 animate-scale-in"
      style={{
        left: `${adjustedX}px`,
        top: `${adjustedY}px`,
      }}
    >
      {menuItems.map((item, index) => {
        if (!item.icon) {
          return item.divider ? <div key={index} className="h-px bg-border my-1" /> : null;
        }

        const Icon = item.icon;
        const isDisabled = item.action === "paste" && !onPaste;

        return (
          <div key={index}>
            <button
              onClick={() => !isDisabled && handleAction(item.action)}
              disabled={isDisabled}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors ${
                isDisabled
                  ? "text-muted-foreground cursor-not-allowed opacity-50"
                  : item.danger
                  ? "text-destructive hover:bg-destructive/10"
                  : "text-popover-foreground hover:bg-accent"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </button>
            {item.divider && <div className="h-px bg-border my-1" />}
          </div>
        );
      })}
    </div>
  );
};
