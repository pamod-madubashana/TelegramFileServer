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
  Eye,
  FileText,
  Star,
  Archive,
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

interface MenuItem {
  icon?: any;
  label: string;
  action: string;
  shortcut?: string;
  divider?: boolean;
  danger?: boolean;
  disabled?: boolean;
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

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("wheel", handleScroll);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("wheel", handleScroll);
      document.removeEventListener("keydown", handleEscape);
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

  const menuItems: MenuItem[] = [
    {
      icon: Eye,
      label: "Open",
      action: "open",
      shortcut: "Enter",
    },
    {
      icon: Download,
      label: "Download",
      action: "download",
      disabled: true,
    },
    { divider: true, label: "", action: "" },
    {
      icon: Copy,
      label: "Copy",
      action: "copy",
      shortcut: "Ctrl+C",
    },
    {
      icon: Scissors,
      label: "Cut",
      action: "cut",
      shortcut: "Ctrl+X",
    },
    ...(onPaste
      ? [
        {
          icon: Clipboard,
          label: "Paste",
          action: "paste",
          shortcut: "Ctrl+V",
        } as MenuItem,
      ]
      : []),
    { divider: true, label: "", action: "" },
    {
      icon: Pencil,
      label: "Rename",
      action: "rename",
      shortcut: "F2",
    },
    {
      icon: Share2,
      label: "Share",
      action: "share",
      disabled: true,
    },
    { divider: true, label: "", action: "" },
    {
      icon: Trash2,
      label: "Delete",
      action: "delete",
      shortcut: "Del",
      danger: true,
    },
    { divider: true, label: "", action: "" },
    {
      icon: Info,
      label: "Properties",
      action: "properties",
      shortcut: "Alt+Enter",
      disabled: true,
    },
  ];

  // Adjust position to keep menu on screen
  const menuWidth = 280;
  const menuHeight = menuItems.filter((item) => !item.divider).length * 36 + menuItems.filter((item) => item.divider).length * 9;
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 10);
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 10);

  return (
    <>
      {/* Backdrop for better visibility */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: "transparent" }}
        onClick={onClose}
      />

      <div
        ref={menuRef}
        className="fixed z-50 bg-background/95 backdrop-blur-sm border border-border/50 rounded-md shadow-2xl overflow-hidden"
        style={{
          left: `${adjustedX}px`,
          top: `${adjustedY}px`,
          width: `${menuWidth}px`,
          animation: "context-menu-in 0.1s ease-out",
        }}
      >
        <div className="py-1">
          {menuItems.map((item, index) => {
            if (item.divider) {
              return (
                <div
                  key={`divider-${index}`}
                  className="h-px bg-border/50 my-1 mx-1"
                />
              );
            }

            const Icon = item.icon;
            const isDisabled = item.disabled || (item.action === "paste" && !onPaste);

            return (
              <button
                key={index}
                onClick={() => !isDisabled && handleAction(item.action)}
                disabled={isDisabled}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-sm transition-all group ${isDisabled
                  ? "text-muted-foreground/40 cursor-not-allowed"
                  : item.danger
                    ? "text-foreground hover:bg-destructive hover:text-destructive-foreground"
                    : "text-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
              >
                <div className="flex items-center gap-3">
                  {Icon && (
                    <Icon
                      className={`w-4 h-4 flex-shrink-0 ${isDisabled ? "opacity-40" : ""
                        }`}
                    />
                  )}
                  <span className="font-normal">{item.label}</span>
                </div>
                {item.shortcut && (
                  <span
                    className={`text-xs font-mono ${isDisabled
                      ? "text-muted-foreground/30"
                      : "text-muted-foreground group-hover:text-accent-foreground/70"
                      }`}
                  >
                    {item.shortcut}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes context-menu-in {
          from {
            opacity: 0;
            transform: scale(0.95);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
      `}</style>
    </>
  );
};
