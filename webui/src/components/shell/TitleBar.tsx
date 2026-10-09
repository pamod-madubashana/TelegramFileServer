import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Minus,
  Square,
  X,
  Bell,
  Settings,
  Plus,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  WebviewWindow,
  getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { useRequiredChannelNotifications } from "@/lib/required-channel-notifications";
import {
  REQUIRED_CHANNEL_FALLBACK,
  type RequiredChannelConfig,
} from "@/lib/required-channel";
import { NotificationWidget } from "@/components/shell/NotificationWidget";
import { getDefaultFolderSymbol } from "@/components/skybox/folderSymbols";
import { markTitleBarInteraction } from "@/lib/overlay";
import {
  INTERNAL_DRAG_MIME,
  INTERNAL_DRAG_MIME_LIST,
} from "@/pages/explorer/shared";
import {
  getExplorerSessionState,
  queueExplorerScrollRestore,
  type SettingsRouteState,
} from "@/pages/explorer/explorerSessionStore";
import { useLocation, useNavigate } from "react-router-dom";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function currentWindow() {
  try {
    return WebviewWindow.getCurrent();
  } catch {
    try {
      return getCurrentWebviewWindow();
    } catch {
      return getCurrentWindow();
    }
  }
}

function getTabDropEdge(target: HTMLDivElement, clientX: number) {
  const rect = target.getBoundingClientRect();
  return clientX - rect.left > rect.width / 2 ? "after" : "before";
}

function reorderTabList<T extends { id: string }>(
  tabs: T[],
  draggedTabId: string,
  targetTabId: string,
  position: "before" | "after",
) {
  if (!draggedTabId || !targetTabId || draggedTabId === targetTabId) {
    return tabs;
  }

  const draggedIndex = tabs.findIndex((tab) => tab.id === draggedTabId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return tabs;
  }

  const next = [...tabs];
  const [draggedTab] = next.splice(draggedIndex, 1);
  const adjustedTargetIndex =
    draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertionIndex =
    position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex;
  next.splice(
    Math.max(0, Math.min(next.length, insertionIndex)),
    0,
    draggedTab,
  );
  return next;
}

function hasSameTabOrder(
  left: Array<{ id: string }>,
  right: Array<{ id: string }>,
) {
  return (
    left.length === right.length &&
    left.every((tab, index) => tab.id === right[index]?.id)
  );
}

export function TitleBar() {
  const isOnline = useNetworkStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const channelConfig: RequiredChannelConfig = REQUIRED_CHANNEL_FALLBACK;
  const [isMaximized, setIsMaximized] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const notificationsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [explorerTabs, setExplorerTabs] = useState<{
    tabs: Array<{
      id: string;
      title: string;
      path: string;
      iconName?: string;
    }>;
    activeTabId: string;
  } | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTargetTabId, setDropTargetTabId] = useState<string | null>(null);
  const [dropTargetEdge, setDropTargetEdge] = useState<"before" | "after">(
    "before",
  );
  const [previewTabs, setPreviewTabs] = useState<
    Array<{
      id: string;
      title: string;
      path: string;
      iconName?: string;
    }>
  >([]);
  const didDropTabRef = useRef(false);
  const activateTabTimerRef = useRef<number | null>(null);
  const activateTabTargetRef = useRef<string | null>(null);
  const explorerDragPathsRef = useRef<string[]>([]);
  const tabElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const previousTabRectsRef = useRef<Record<string, DOMRect>>({});

  const { notifications, unreadCount, markAllRead } =
    useRequiredChannelNotifications(
      channelConfig.chatId,
      channelConfig.chatTitle,
    );

  useEffect(() => {
    const appWindow = currentWindow();
    appWindow
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {
        // ignore
      });
  }, []);

  useEffect(() => {
    return () => {
      if (activateTabTimerRef.current !== null) {
        window.clearTimeout(activateTabTimerRef.current);
      }
      activateTabTargetRef.current = null;
    };
  }, []);

  useEffect(() => {
    const appWindow = currentWindow();
    let unlisten: null | (() => void) = null;

    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setIsMaximized).catch(console.warn);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // ignore
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!isNotificationsOpen) return;
    markAllRead();
  }, [isNotificationsOpen, markAllRead]);

  useEffect(() => {
    const handler = (event: Event) => {
      const typed = event as CustomEvent<{
        tabs: Array<{
          id: string;
          title: string;
          path: string;
          iconName?: string;
        }>;
        activeTabId: string;
      } | null>;
      setExplorerTabs(typed.detail || null);
    };

    window.addEventListener("skybox-explorer-tabs-update", handler);
    return () => {
      window.removeEventListener("skybox-explorer-tabs-update", handler);
    };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const typed = event as CustomEvent<{ sourcePaths: string[] } | null>;
      explorerDragPathsRef.current = typed.detail?.sourcePaths || [];
    };

    window.addEventListener("skybox-explorer-drag-state", handler);
    return () => {
      window.removeEventListener("skybox-explorer-drag-state", handler);
    };
  }, []);

  const sendTabsAction = useCallback(
    (
      detail:
        | { type: "switch"; tabId: string }
        | { type: "close"; tabId: string }
        | { type: "new" }
        | {
            type: "reorder";
            draggedTabId: string;
            targetTabId: string;
            position: "before" | "after";
          }
        | {
            type: "reorder-order";
            orderedTabIds: string[];
          },
    ) => {
      window.dispatchEvent(
        new CustomEvent("skybox-explorer-tabs-action", { detail }),
      );
    },
    [],
  );

  const sendExplorerItemDropToTab = useCallback(
    (detail: { destinationPath: string; sourcePaths: string[] }) => {
      window.dispatchEvent(
        new CustomEvent("skybox-explorer-drop-to-tab", { detail }),
      );
    },
    [],
  );

  const badgeText = useMemo(() => {
    if (!unreadCount) return "";
    if (unreadCount > 9) return "9+";
    return String(unreadCount);
  }, [unreadCount]);

  const displayedTabs = useMemo(() => {
    if (
      previewTabs.length &&
      (!explorerTabs?.tabs || !hasSameTabOrder(previewTabs, explorerTabs.tabs))
    ) {
      return previewTabs;
    }

    return explorerTabs?.tabs || [];
  }, [explorerTabs?.tabs, previewTabs]);

  useEffect(() => {
    if (!explorerTabs?.tabs) {
      if (previewTabs.length) {
        setPreviewTabs([]);
      }
      return;
    }

    if (previewTabs.length && hasSameTabOrder(previewTabs, explorerTabs.tabs)) {
      setPreviewTabs([]);
    }
  }, [draggedTabId, explorerTabs?.tabs, previewTabs]);

  useLayoutEffect(() => {
    const nextRects: Record<string, DOMRect> = {};

    displayedTabs.forEach((tab) => {
      const element = tabElementRefs.current[tab.id];
      if (!element) {
        return;
      }

      const nextRect = element.getBoundingClientRect();
      nextRects[tab.id] = nextRect;

      const previousRect = previousTabRectsRef.current[tab.id];
      if (!previousRect) {
        return;
      }

      const deltaX = previousRect.left - nextRect.left;
      if (Math.abs(deltaX) < 1) {
        return;
      }

      element.style.transition = "none";
      element.style.transform = `translateX(${deltaX}px)`;
      element.getBoundingClientRect();
      element.style.transition =
        "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
      element.style.transform = "translateX(0)";
    });

    previousTabRectsRef.current = nextRects;
  }, [displayedTabs]);

  const scheduleTabActivationFromExplorerDrag = useCallback(
    (tabId: string) => {
      if (!explorerTabs || explorerTabs.activeTabId === tabId) {
        return;
      }

      if (
        activateTabTimerRef.current !== null &&
        activateTabTargetRef.current === tabId
      ) {
        return;
      }

      if (activateTabTimerRef.current !== null) {
        window.clearTimeout(activateTabTimerRef.current);
      }

      activateTabTargetRef.current = tabId;

      activateTabTimerRef.current = window.setTimeout(() => {
        sendTabsAction({ type: "switch", tabId });
        activateTabTimerRef.current = null;
        activateTabTargetRef.current = null;
      }, 220);
    },
    [explorerTabs, sendTabsAction],
  );

  const clearScheduledTabActivation = useCallback(() => {
    if (activateTabTimerRef.current !== null) {
      window.clearTimeout(activateTabTimerRef.current);
      activateTabTimerRef.current = null;
    }
    activateTabTargetRef.current = null;
  }, []);

  const openSettings = useCallback(() => {
    const explorerSession = getExplorerSessionState();
    const fromExplorer = location.pathname.startsWith("/explorer");

    if (fromExplorer) {
      queueExplorerScrollRestore(explorerSession.currentPath);
    }

    navigate("/settings/window", {
      state: {
        fromExplorer,
        returnTo: fromExplorer
          ? `${location.pathname}${location.search}${location.hash}`
          : "/explorer",
      } satisfies SettingsRouteState,
    });
  }, [location.hash, location.pathname, location.search, navigate]);

  const exitSettings = useCallback(() => {
    const routeState = (location.state || null) as SettingsRouteState | null;

    if (routeState?.fromExplorer) {
      navigate(-1);
      return;
    }

    navigate(routeState?.returnTo || "/explorer", { replace: true });
  }, [location.state, navigate]);

  const toggleMaximize = useCallback(async () => {
    const appWindow = currentWindow();
    try {
      await appWindow.toggleMaximize();
      const next = await appWindow.isMaximized();
      setIsMaximized(next);
    } catch (error) {
      console.warn("Failed to toggle maximize", error);
    }
  }, []);

  const minimize = useCallback(async () => {
    try {
      await currentWindow().minimize();
    } catch (error) {
      console.warn("Failed to minimize window", error);
    }
  }, []);

  const close = useCallback(async () => {
    // In Settings, treat close as "exit settings".
    if (location.pathname.startsWith("/settings")) {
      exitSettings();
      return;
    }

    try {
      const event = new Event("skybox-window-close-request", {
        cancelable: true,
      });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        return;
      }

      await currentWindow().close();
    } catch (error) {
      console.warn("Failed to close window", error);
    }
  }, [exitSettings, location.pathname, navigate]);

  const startDragging = useCallback(async () => {
    try {
      await currentWindow().startDragging();
    } catch (error) {
      console.warn("Failed to start dragging", error);
    }
  }, []);

  const settingsSectionLabel = useMemo(() => {
    const path = location.pathname;
    if (!path.startsWith("/settings")) return null;
    const section = path.split("/").filter(Boolean)[1] || "";
    switch (section) {
      case "window":
        return "Window & Tray";
      case "explorer":
        return "Explorer";
      case "downloads":
        return "Downloads";
      case "notifications":
        return "Notifications";
      case "accounts":
      case "storage":
        return "Storage";
      case "appearance":
        return "Appearance";
      case "about":
        return "About";
      default:
        return "Settings";
    }
  }, [location.pathname]);

  const isSettingsRoute = Boolean(settingsSectionLabel);

  return (
    <>
      <div
        data-skybox-titlebar="true"
        className="skybox-topbar relative z-[150] h-[var(--titlebar-height)] border-b border-border"
        onPointerDownCapture={() => {
          markTitleBarInteraction();
        }}
        onMouseDownCapture={() => {
          markTitleBarInteraction();
        }}
      >
        {/* Network status indicator: visible when offline */}
        {!isOnline && (
          <div className="absolute left-0 right-0 top-0 h-[22px] bg-red-600 text-white flex items-center justify-center text-xs font-semibold z-20 shadow-md select-none" style={{letterSpacing: '0.5px'}} role="status" aria-live="polite">
            <span className="inline-flex items-center gap-1">
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" className="inline-block align-middle"><path strokeLinecap="round" strokeLinejoin="round" d="M12 18.25v.01M12 3v10m0 0V3m0 10h0M4.93 19.07A10 10 0 0112 2a10 10 0 017.07 17.07" /></svg>
              <span>Offline: attempting to reconnect…</span>
            </span>
          </div>
        )}

        <div
          className="relative h-full flex items-center justify-between"
          onMouseDown={(event) => {
            if (!isTauri()) return;
            if (event.button !== 0) return;
            if (event.detail !== 1) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest("[data-no-drag='true']")) return;
            void startDragging();
          }}
          onDoubleClick={(event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest("[data-no-drag='true']")) return;
            void toggleMaximize();
          }}
          role="presentation"
        >
          {isSettingsRoute ? (
            <div className="pointer-events-none absolute left-1/2 top-0 h-full -translate-x-1/2 flex items-center">
              <span className="text-body font-medium text-foreground/90 truncate max-w-[60vw]">
                {settingsSectionLabel}
              </span>
            </div>
          ) : null}

          <div className="h-full flex items-center min-w-0 flex-1">
            {isSettingsRoute ? (
              <div className="h-full flex items-center px-2">
                <button
                  type="button"
                  onClick={() => {
                    exitSettings();
                  }}
                  className="h-full inline-flex items-center gap-2 px-3 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/40 transition-colors"
                  title="Back to Explorer"
                  aria-label="Back to Explorer"
                  data-no-drag="true"
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span className="text-body font-medium">
                    {settingsSectionLabel}
                  </span>
                </button>
              </div>
            ) : displayedTabs.length ? (
              <div className="h-full flex min-w-0 flex-1 items-center overflow-hidden">
                <div className="flex h-full w-full min-w-0 items-center px-2">
                  {displayedTabs.map((tab, index) => {
                    const isActive = tab.id === explorerTabs.activeTabId;
                    const isLastTab = index === displayedTabs.length - 1;
                    const SymbolIcon = getDefaultFolderSymbol(
                      tab.iconName || tab.title,
                      tab.path,
                    );
                    return (
                      <div
                        key={tab.id}
                        className="flex min-w-0 max-w-[250px] flex-[1_1_160px] items-center transition-[transform,opacity] duration-200 ease-out"
                        ref={(element) => {
                          tabElementRefs.current[tab.id] = element;
                        }}
                        data-no-drag="true"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", tab.id);
                          didDropTabRef.current = false;
                          setDraggedTabId(tab.id);
                          setDropTargetTabId(tab.id);
                          setDropTargetEdge("before");
                          setPreviewTabs(explorerTabs?.tabs || []);
                        }}
                        onDragOver={(event) => {
                          const types = Array.from(
                            event.dataTransfer.types || [],
                          );
                          const isExplorerItemDrag =
                            types.includes(INTERNAL_DRAG_MIME) ||
                            types.includes(INTERNAL_DRAG_MIME_LIST) ||
                            explorerDragPathsRef.current.length > 0;
                          if (isExplorerItemDrag) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            scheduleTabActivationFromExplorerDrag(tab.id);
                            return;
                          }

                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          const nextEdge = getTabDropEdge(
                            event.currentTarget,
                            event.clientX,
                          );
                          if (dropTargetTabId !== tab.id) {
                            setDropTargetTabId(tab.id);
                          }
                          if (dropTargetEdge !== nextEdge) {
                            setDropTargetEdge(nextEdge);
                          }
                          if (draggedTabId) {
                            setPreviewTabs((prev) => {
                              const sourceTabs = prev.length
                                ? prev
                                : explorerTabs?.tabs || [];
                              const nextTabs = reorderTabList(
                                sourceTabs,
                                draggedTabId,
                                tab.id,
                                nextEdge,
                              );
                              return hasSameTabOrder(sourceTabs, nextTabs)
                                ? sourceTabs
                                : nextTabs;
                            });
                          }
                        }}
                        onDrop={(event) => {
                          clearScheduledTabActivation();
                          event.preventDefault();
                          const types = Array.from(
                            event.dataTransfer.types || [],
                          );
                          const isExplorerItemDrag =
                            types.includes(INTERNAL_DRAG_MIME) ||
                            types.includes(INTERNAL_DRAG_MIME_LIST) ||
                            explorerDragPathsRef.current.length > 0;
                          if (isExplorerItemDrag) {
                            event.stopPropagation();
                            const listPayload = event.dataTransfer.getData(
                              INTERNAL_DRAG_MIME_LIST,
                            );
                            let sourcePaths: string[] = [];
                            if (listPayload) {
                              try {
                                const parsed = JSON.parse(
                                  listPayload,
                                ) as unknown;
                                if (Array.isArray(parsed)) {
                                  sourcePaths = parsed.filter(
                                    (value): value is string =>
                                      typeof value === "string",
                                  );
                                }
                              } catch {
                                // ignore malformed drag payload
                              }
                            }
                            if (!sourcePaths.length) {
                              const singlePath =
                                event.dataTransfer.getData(INTERNAL_DRAG_MIME);
                              if (singlePath) {
                                sourcePaths = [singlePath];
                              }
                            }
                            if (!sourcePaths.length) {
                              sourcePaths = explorerDragPathsRef.current;
                            }
                            if (!sourcePaths.length || !tab.path) {
                              return;
                            }
                            if (explorerTabs?.activeTabId !== tab.id) {
                              sendTabsAction({ type: "switch", tabId: tab.id });
                            }
                            window.setTimeout(() => {
                              sendExplorerItemDropToTab({
                                destinationPath: tab.path,
                                sourcePaths,
                              });
                            }, 0);
                            return;
                          }
                          const nextEdge = getTabDropEdge(
                            event.currentTarget,
                            event.clientX,
                          );
                          const movedTabId =
                            draggedTabId ||
                            event.dataTransfer.getData("text/plain");
                          const nextPreviewTabs = previewTabs.length
                            ? previewTabs
                            : explorerTabs?.tabs || [];
                          const canCommitPreviewOrder =
                            nextPreviewTabs.length > 0 &&
                            !hasSameTabOrder(
                              nextPreviewTabs,
                              explorerTabs?.tabs || [],
                            );

                          if (canCommitPreviewOrder) {
                            didDropTabRef.current = true;
                            sendTabsAction({
                              type: "reorder-order",
                              orderedTabIds: nextPreviewTabs.map(
                                (previewTab) => previewTab.id,
                              ),
                            });
                            setDraggedTabId(null);
                            setDropTargetTabId(null);
                            setDropTargetEdge("before");
                            return;
                          }

                          if (!movedTabId || movedTabId === tab.id) {
                            setDraggedTabId(null);
                            setDropTargetTabId(null);
                            setPreviewTabs([]);
                            return;
                          }
                          didDropTabRef.current = true;
                          sendTabsAction({
                            type: "reorder",
                            draggedTabId: movedTabId,
                            targetTabId: tab.id,
                            position: nextEdge,
                          });
                          setDraggedTabId(null);
                          setDropTargetTabId(null);
                          setDropTargetEdge("before");
                        }}
                        onDragEnd={() => {
                          clearScheduledTabActivation();
                          setDraggedTabId(null);
                          setDropTargetTabId(null);
                          setDropTargetEdge("before");
                          if (!didDropTabRef.current) {
                            setPreviewTabs([]);
                          }
                          didDropTabRef.current = false;
                        }}
                        onDragLeave={clearScheduledTabActivation}
                      >
                        <div
                          data-no-drag="true"
                          className={`group relative mt-1 mb-1 flex h-[calc(var(--titlebar-height)-8px)] min-w-0 flex-1 items-center rounded-md border transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 ease-out ${
                            isActive
                              ? "border-white/[0.06] bg-white/[0.045] shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_8px_18px_rgba(0,0,0,0.16)]"
                              : "border-transparent bg-transparent hover:bg-white/[0.03]"
                          } ${
                            draggedTabId === tab.id
                              ? "scale-[0.985] opacity-60"
                              : dropTargetTabId === tab.id && draggedTabId
                                ? "bg-white/[0.06]"
                                : ""
                          }`}
                        >
                          {dropTargetTabId === tab.id &&
                          draggedTabId &&
                          draggedTabId !== tab.id ? (
                            <div
                              className={`pointer-events-none absolute top-1 bottom-1 z-10 w-[2px] rounded-full bg-primary/75 shadow-[0_0_0_1px_rgba(34,197,94,0.18)] transition-[left,right,opacity] duration-150 ease-out ${
                                dropTargetEdge === "before"
                                  ? "left-[-2px]"
                                  : "right-[-2px]"
                              }`}
                            />
                          ) : null}
                          <button
                            type="button"
                            onClick={() =>
                              sendTabsAction({ type: "switch", tabId: tab.id })
                            }
                            className={`inline-flex min-w-0 flex-1 items-center gap-2 truncate px-3 py-1.5 text-body ${
                              isActive
                                ? "text-foreground"
                                : "text-muted-foreground group-hover:text-foreground"
                            }`}
                            data-no-drag="true"
                          >
                            <span className="relative h-4 w-4 shrink-0">
                              <div
                                className="skybox-folder-icon"
                                style={{ ["--folder-size" as any]: "16px" }}
                              />
                              {SymbolIcon ? (
                                <SymbolIcon className="absolute left-1/2 top-[56%] h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 text-black/70 mix-blend-multiply" />
                              ) : null}
                            </span>
                            {tab.title}
                          </button>
                          <button
                            type="button"
                            className={`mr-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground ${
                              displayedTabs.length <= 1
                                ? "opacity-40 pointer-events-none"
                                : ""
                            }`}
                            title={
                              displayedTabs.length <= 1
                                ? "Can't close last tab"
                                : "Close tab"
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              if (displayedTabs.length <= 1) {
                                return;
                              }
                              sendTabsAction({ type: "close", tabId: tab.id });
                            }}
                            data-no-drag="true"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        {!isLastTab ? (
                          <div className="mx-0.5 h-4 w-px shrink-0 bg-white/[0.08]" />
                        ) : null}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => sendTabsAction({ type: "new" })}
                    className="mt-1 mb-1 flex h-[calc(var(--titlebar-height)-8px)] w-9 shrink-0 items-center justify-center rounded-md bg-transparent text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
                    aria-label="New tab"
                    title="New tab"
                    data-no-drag="true"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="h-full flex-1" />
            )}
          </div>

          <div className="h-full flex items-center shrink-0">
            <div className="h-full w-16 shrink-0" aria-hidden="true" />

            <button
              ref={notificationsButtonRef}
              onClick={() => setIsNotificationsOpen((prev) => !prev)}
              className="relative h-full px-3 hover:bg-sidebar-accent/40 transition-colors"
              aria-label="Open notifications"
              data-no-drag="true"
            >
              <Bell className="h-4 w-4 text-muted-foreground" />
              {badgeText ? (
                <span className="absolute right-2 top-2 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] leading-4 text-center">
                  {badgeText}
                </span>
              ) : null}
            </button>

            <button
              onClick={() => {
                setIsNotificationsOpen(false);
                if (location.pathname.startsWith("/settings")) {
                  return;
                }

                openSettings();
              }}
              className={`h-full px-3 transition-colors ${"hover:bg-sidebar-accent/40"}`}
              aria-label="Open settings"
              data-no-drag="true"
              data-settings-button="true"
            >
              <Settings className="h-4 w-4 text-muted-foreground" />
            </button>

            <div className="flex h-full items-stretch">
              <button
                onClick={() => void minimize()}
                className="h-full w-12 flex items-center justify-center text-muted-foreground transition-colors hover:bg-white/8 hover:text-white"
                aria-label="Minimize"
                title="Minimize"
                data-no-drag="true"
              >
                <Minus className="h-4 w-4 transition-colors" />
              </button>
              <button
                onClick={() => void toggleMaximize()}
                className="h-full w-12 flex items-center justify-center text-muted-foreground transition-colors hover:bg-white/8 hover:text-white"
                aria-label={isMaximized ? "Restore" : "Maximize"}
                title={isMaximized ? "Restore" : "Maximize"}
                data-no-drag="true"
              >
                <Square className="h-4 w-4 transition-colors" />
              </button>
              <button
                onClick={() => void close()}
                className="h-full w-12 flex items-center justify-center text-muted-foreground transition-colors hover:bg-white/8 hover:text-[#e81123]"
                aria-label={isSettingsRoute ? "Close settings" : "Close"}
                title={isSettingsRoute ? "Close settings" : "Close"}
                data-no-drag="true"
              >
                <X className="h-4 w-4 transition-colors" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <NotificationWidget
        isOpen={isNotificationsOpen}
        channelTitle={channelConfig.chatTitle}
        notifications={notifications}
        onClose={() => setIsNotificationsOpen(false)}
        triggerRef={notificationsButtonRef}
      />
    </>
  );
}
