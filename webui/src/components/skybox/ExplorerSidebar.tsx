import { Images, Star, FolderOpen, Trash2, Clock, HardDrive } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getDefaultFolderSymbol } from "@/components/skybox/folderSymbols";
import { apiJson } from "@/lib/auth";
import {
  INTERNAL_DRAG_MIME,
  INTERNAL_DRAG_MIME_LIST,
  STORAGE_KEY_CHAT_DRIVES,
  isGalleryPath,
  isRecycleBinPath,
} from "@/pages/explorer/shared";

interface SidebarItem {
  id: string;
  label: string;
  icon: React.ElementType;
  path?: string;
  onClick?: () => void;
}

const DEFAULT_HOME_PATH = "tg://saved";

const savedSubItems: SidebarItem[] = [
  {
    id: "saved-recycle-bin",
    label: "Recycle Bin",
    icon: Trash2,
    path: "tg://saved/Recycle Bin",
  },
];

interface UserInfo {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  profile_photo?: string;
}

/** One user-registered extra chat browsable as a drive. */
interface DriveEntry {
  chat_id: number;
  label?: string;
}

interface ExplorerSidebarProps {
  currentPath?: string;
  favoritePaths?: string[];
  recentPaths?: string[];
  showFavorites?: boolean;
  homePath?: string;
  userInfo?: UserInfo;
  avatarUrl?: string | null;
  bottomSlot?: ReactNode;
}

export function ExplorerSidebar({
  currentPath,
  favoritePaths = [],
  recentPaths = [],
  showFavorites = true,
  homePath = DEFAULT_HOME_PATH,
  userInfo,
  avatarUrl,
  bottomSlot,
}: ExplorerSidebarProps) {
  const location = useLocation();
  const photoUrl = avatarUrl?.trim();
  const [photoFailed, setPhotoFailed] = useState(false);
  const [drives, setDrives] = useState<DriveEntry[]>([]);
  const activateOnDragTimerRef = useRef<number | null>(null);
  const activateOnDragPathRef = useRef<string | null>(null);
  const folderFavoritePaths = favoritePaths.filter(
    (path) => !path.startsWith("tg://msg/"),
  );
  const dedupedRecentPaths = Array.from(
    new Set(
      recentPaths.filter((path) => typeof path === "string" && path.trim()),
    ),
  );

  const mainItems: SidebarItem[] = [
    {
      id: "saved-gallery",
      label: "Gallery",
      icon: Images,
      path: "tg://saved/Gallery",
    },
    {
      id: "saved",
      label: "Files",
      icon: FolderOpen,
      path: homePath && homePath.trim() ? homePath.trim() : DEFAULT_HOME_PATH,
    },
  ];

  useEffect(() => {
    setPhotoFailed(false);
  }, [photoUrl]);

  useEffect(() => {
    let cancelled = false;
    apiJson<{ drives?: DriveEntry[] }>("/api/storage/drives")
      .then((result) => {
        if (cancelled) return;
        const list = Array.isArray(result?.drives) ? result.drives : [];
        setDrives(list);
        // Explorer tab titles read this cache for friendly drive names.
        try {
          window.localStorage.setItem(
            STORAGE_KEY_CHAT_DRIVES,
            JSON.stringify(
              list.map((drive) => ({
                id: drive.chat_id,
                title:
                  drive.label?.trim() || `Chat ${drive.chat_id}`,
              })),
            ),
          );
        } catch {
          // localStorage failures only cost the friendly tab title.
        }
      })
      .catch(() => {
        // Signed out or offline: the Drives section just stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (activateOnDragTimerRef.current !== null) {
        window.clearTimeout(activateOnDragTimerRef.current);
      }
      activateOnDragPathRef.current = null;
    };
  }, []);

  const handleRootClick = (path: string) => {
    // Navigate to explorer with the selected path
    // We'll handle the path navigation in the ExplorerPage
    window.dispatchEvent(new CustomEvent("navigate-to-path", { detail: path }));
  };

  const hasInternalExplorerDrag = (event: React.DragEvent) => {
    const dragTypes = Array.from(event.dataTransfer.types || []);
    return (
      dragTypes.includes(INTERNAL_DRAG_MIME) ||
      dragTypes.includes(INTERNAL_DRAG_MIME_LIST)
    );
  };

  const scheduleDragNavigation = (path: string) => {
    if (!path || currentPath === path) {
      return;
    }

    if (
      activateOnDragTimerRef.current !== null &&
      activateOnDragPathRef.current === path
    ) {
      return;
    }

    if (activateOnDragTimerRef.current !== null) {
      window.clearTimeout(activateOnDragTimerRef.current);
    }

    activateOnDragPathRef.current = path;

    activateOnDragTimerRef.current = window.setTimeout(() => {
      handleRootClick(path);
      activateOnDragTimerRef.current = null;
      activateOnDragPathRef.current = null;
    }, 220);
  };

  const clearScheduledDragNavigation = () => {
    if (activateOnDragTimerRef.current !== null) {
      window.clearTimeout(activateOnDragTimerRef.current);
      activateOnDragTimerRef.current = null;
    }
    activateOnDragPathRef.current = null;
  };

  const getFavoriteLabel = (path: string): string => {
    if (!path) {
      return "Favorite";
    }
    if (path.startsWith("tg://saved")) {
      const relative = path.replace(/^tg:\/\/saved\/?/, "");
      if (!relative) {
        return "Home";
      }
      const parts = relative.split("/").filter(Boolean);
      return parts[parts.length - 1] || "Home";
    }

    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  };

  const getRecentLabel = (path: string): string => {
    return getFavoriteLabel(path);
  };

  const nameParts = [
    userInfo?.first_name?.trim(),
    userInfo?.last_name?.trim(),
  ].filter((value): value is string => Boolean(value && value.length > 0));
  const displayName = nameParts.join(" ");
  const usernameLabel = userInfo?.username?.trim();

  // Get initials for the avatar
  const getInitials = () => {
    if (!userInfo) return "U";

    const firstNameInitial = userInfo.first_name
      ? userInfo.first_name.charAt(0).toUpperCase()
      : "";
    const lastNameInitial = userInfo.last_name
      ? userInfo.last_name.charAt(0).toUpperCase()
      : "";

    if (firstNameInitial && lastNameInitial) {
      return firstNameInitial + lastNameInitial;
    } else if (firstNameInitial) {
      return firstNameInitial;
    } else if (lastNameInitial) {
      return lastNameInitial;
    } else if (userInfo.username) {
      return userInfo.username.charAt(0).toUpperCase();
    }

    return "U";
  };

  return (
    <div className="w-64 h-full glass-sidebar flex flex-col relative overflow-hidden">
      {/* User Profile Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-3 w-full text-left p-2 rounded-lg">
          <Avatar className="w-10 h-10 flex-shrink-0">
            {photoUrl && !photoFailed ? (
              <AvatarImage
                src={photoUrl}
                alt={displayName || "User"}
                onError={() => setPhotoFailed(true)}
              />
            ) : null}
            <AvatarFallback className="bg-primary text-primary-foreground font-semibold text-body">
              {getInitials()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-body font-medium text-foreground truncate">
              {displayName || "User"}
            </p>
            {usernameLabel ? (
              <p className="text-small text-muted-foreground truncate">
                @{usernameLabel}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main navigation */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <div className="px-2 py-1.5">
          <span className="text-small text-muted-foreground uppercase tracking-wider">
            Browse
          </span>
        </div>

        {mainItems.map((item) => {
          const Icon = item.icon;
          const isVirtual = item.path?.startsWith("tg://");
          const isActive = isVirtual
            ? item.id === "saved-gallery"
              ? !!currentPath && isGalleryPath(currentPath)
              : item.id === "saved"
                ? !!currentPath &&
                  currentPath.startsWith("tg://saved") &&
                  !isGalleryPath(currentPath) &&
                  !isRecycleBinPath(currentPath)
                : currentPath === item.path
            : location.pathname === item.path;

          const content = (
            <>
              <Icon className="w-5 h-5" />
              <span className="text-body font-medium">{item.label}</span>
            </>
          );

          const className = `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full text-left ${
            isActive
              ? "bg-sidebar-accent text-primary font-medium"
              : "text-foreground hover:bg-sidebar-accent/50"
          }`;

          if (isVirtual) {
            return (
              <button
                key={item.id}
                onClick={() => item.path && handleRootClick(item.path)}
                className={className}
                onDragOver={(event) => {
                  if (!item.path || !hasInternalExplorerDrag(event)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  scheduleDragNavigation(item.path);
                }}
                onDragLeave={clearScheduledDragNavigation}
                onDrop={clearScheduledDragNavigation}
              >
                {content}
              </button>
            );
          }

          return (
            <NavLink key={item.id} to={item.path || "#"} className={className}>
              {content}
            </NavLink>
          );
        })}

        {savedSubItems.map((item) => {
          const Icon = item.icon;
          const itemPath = item.path || "";
          const isActive =
            !!itemPath &&
            !!currentPath &&
            (currentPath === itemPath ||
              currentPath.startsWith(`${itemPath}/`));

          return (
            <button
              key={item.id}
              onClick={() => item.path && handleRootClick(item.path)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full text-left ${
                isActive
                  ? "bg-sidebar-accent text-primary font-medium"
                  : "text-foreground hover:bg-sidebar-accent/50"
              }`}
              onDragOver={(event) => {
                if (!item.path || !hasInternalExplorerDrag(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                scheduleDragNavigation(item.path);
              }}
              onDragLeave={clearScheduledDragNavigation}
              onDrop={clearScheduledDragNavigation}
            >
              <Icon className="w-5 h-5" />
              <span className="text-body font-medium">{item.label}</span>
            </button>
          );
        })}

        {drives.length > 0 && (
          <>
            <div className="px-2 pt-4 pb-1.5">
              <span className="text-small text-muted-foreground uppercase tracking-wider inline-flex items-center gap-2">
                <HardDrive className="w-4 h-4" />
                Drives
              </span>
            </div>

            {drives.map((drive) => {
              const itemPath = `tg://drive/${drive.chat_id}`;
              const label =
                drive.label?.trim() || `Chat ${drive.chat_id}`;
              const isActive =
                !!currentPath &&
                (currentPath === itemPath ||
                  currentPath.startsWith(`${itemPath}/`));
              return (
                <button
                  key={drive.chat_id}
                  onClick={() => handleRootClick(itemPath)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full text-left ${
                    isActive
                      ? "bg-sidebar-accent text-primary font-medium"
                      : "text-foreground hover:bg-sidebar-accent/50"
                  }`}
                  title={itemPath}
                >
                  <HardDrive className="w-5 h-5 flex-shrink-0" />
                  <span className="text-body font-medium truncate">
                    {label}
                  </span>
                </button>
              );
            })}
          </>
        )}

        {dedupedRecentPaths.length > 0 && (
          <>
            <div className="px-2 pt-4 pb-1.5">
              <span className="text-small text-muted-foreground uppercase tracking-wider inline-flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Recents
              </span>
            </div>

            {dedupedRecentPaths.map((path) => {
              const isActive =
                !!currentPath &&
                (currentPath === path || currentPath.startsWith(`${path}/`));
              const label = getRecentLabel(path);
              return (
                <button
                  key={path}
                  onClick={() => handleRootClick(path)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full text-left ${
                    isActive
                      ? "bg-sidebar-accent text-primary font-medium"
                      : "text-foreground hover:bg-sidebar-accent/50"
                  }`}
                  title={path}
                >
                  <span className="text-body font-medium truncate">
                    {label}
                  </span>
                </button>
              );
            })}
          </>
        )}

        {showFavorites && folderFavoritePaths.length > 0 && (
          <>
            <div className="px-2 pt-4 pb-1.5">
              <span className="text-small text-muted-foreground uppercase tracking-wider inline-flex items-center gap-2">
                <Star className="w-4 h-4" />
                Favorites
              </span>
            </div>

            {folderFavoritePaths.map((path) => {
              const isActive =
                !!currentPath &&
                (currentPath === path || currentPath.startsWith(`${path}/`));
              const label = getFavoriteLabel(path);
              const SymbolIcon = getDefaultFolderSymbol(label, path);
              return (
                <button
                  key={path}
                  onClick={() => handleRootClick(path)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full text-left ${
                    isActive
                      ? "bg-sidebar-accent text-primary font-medium"
                      : "text-foreground hover:bg-sidebar-accent/50"
                  }`}
                  title={path}
                >
                  <div className="relative">
                    <div
                      className="skybox-folder-icon"
                      style={{ "--folder-size": "22px" } as CSSProperties}
                    />
                    {SymbolIcon ? (
                      <SymbolIcon className="absolute left-1/2 top-[56%] -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 text-black/55 mix-blend-multiply" />
                    ) : null}
                  </div>
                  <span className="text-body font-medium truncate">
                    {label}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>

      {bottomSlot ? (
        <div className="shrink-0 p-3 border-t border-border">{bottomSlot}</div>
      ) : null}
    </div>
  );
}
