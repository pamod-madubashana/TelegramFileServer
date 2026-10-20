import type { ChangeEvent, CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MoreHorizontal,
  Plus,
  Send,
  Smile,
  X,
  EyeOff,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Play,
} from "lucide-react";
import Plyr from "plyr";
import "plyr/dist/plyr.css";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import plyrSpriteUrl from "@/assets/plyr/plyr.svg?url";

export type UploadSendAsMode = "photo" | "file";

type UploadMediaKind = "image" | "video" | "media" | "none";

export interface UploadConfirmOptions {
  sendAs: UploadSendAsMode;
  highQuality: boolean;
  hideWithSpoiler: boolean;
  moveCaptionUp: boolean;
}

export type UploadDraftEntry = {
  id: string;
  file: File;
  relativePath: string;
  sourcePath?: string;
};

export interface UploadConfirmDraft {
  entries: UploadDraftEntry[];
  selection: Record<string, boolean>;
  caption: string;
  options: UploadConfirmOptions;
}

interface UploadConfirmWidgetProps {
  isOpen: boolean;
  draft: UploadConfirmDraft;
  maxFileBytes: number;
  onChange: (next: UploadConfirmDraft) => void;
  onClose: () => void;
  onConfirm: () => void;
}

type PreviewItem = {
  key: string;
  file: File;
  url: string | null;
  isImage: boolean;
  isVideo: boolean;
};

type TreeNode = {
  id: string;
  name: string;
  kind: "folder" | "file";
  children: TreeNode[];
  entry?: UploadDraftEntry;
};

type PlyrInstance = {
  destroy: () => void;
  on?: (event: string, callback: () => void) => void;
};

const makeFileKey = (file: File): string => {
  return `${file.name}:${file.size}:${file.lastModified}`;
};

const getUploadMediaKind = (files: File[]): UploadMediaKind => {
  if (!files.length) return "none";
  const isImage = (file: File) => file.type.startsWith("image/");
  const isVideo = (file: File) => file.type.startsWith("video/");
  const allImages = files.every(isImage);
  if (allImages) return "image";
  const allVideos = files.every(isVideo);
  if (allVideos) return "video";
  const allMedia = files.every((file) => isImage(file) || isVideo(file));
  return allMedia ? "media" : "none";
};

function UploadPreviewVideo({
  src,
  muted = true,
  className,
}: {
  src: string;
  muted?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<PlyrInstance | null>(null);
  const lastInitErrorKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    playerRef.current?.destroy();
    playerRef.current = null;

    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    if (!src.trim()) {
      return;
    }

    const target = document.createElement("video");
    target.className = "h-full w-full";
    target.playsInline = true;
    target.muted = muted;
    target.controls = false;
    target.preload = "metadata";

    const source = document.createElement("source");
    source.src = src;
    target.appendChild(source);
    container.appendChild(target);

    let verifyTimer: number | null = null;

    try {
      const player = new Plyr(target, {
        controls: [
          "play-large",
          "play",
          "progress",
          "current-time",
          "duration",
          "mute",
          "volume",
        ],
        resetOnEnd: false,
        hideControls: false,
        keyboard: { focused: true, global: false },
        fullscreen: { enabled: false, fallback: false, iosNative: false },
        iconUrl: plyrSpriteUrl,
      }) as unknown as PlyrInstance;

      player.on?.("ready", () => {
        target.controls = false;
      });

      verifyTimer = window.setTimeout(() => {
        const plyrRoot = target.closest(".plyr");
        const controls = plyrRoot?.querySelector(".plyr__controls");
        if (!plyrRoot || !controls) {
          const key = src;
          if (lastInitErrorKeyRef.current !== key) {
            lastInitErrorKeyRef.current = key;
            console.error(
              "Plyr init incomplete in upload preview; falling back to native controls",
              { src },
            );
          }
          try {
            player.destroy();
          } catch {
            // ignore
          }
          playerRef.current = null;
          target.controls = true;
          return;
        }

        target.controls = false;
      }, 0);

      playerRef.current = player;
    } catch (error) {
      const key = src;
      if (lastInitErrorKeyRef.current !== key) {
        lastInitErrorKeyRef.current = key;
        console.error(
          "Plyr init failed in upload preview; falling back to native controls",
          error,
        );
      }
      target.controls = true;
    }

    return () => {
      if (verifyTimer !== null) {
        window.clearTimeout(verifyTimer);
      }
      playerRef.current?.destroy();
      playerRef.current = null;

      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
    };
  }, [muted, src]);

  return <div ref={containerRef} className={className} />;
}

export function UploadConfirmWidget({
  isOpen,
  draft,
  maxFileBytes,
  onChange,
  onClose,
  onConfirm,
}: UploadConfirmWidgetProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [spoilerRevealed, setSpoilerRevealed] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<
    Record<string, boolean>
  >({});

  const files = useMemo(
    () => draft.entries.map((entry) => entry.file),
    [draft.entries],
  );

  useEffect(() => {
    if (!isOpen) return;
    setSpoilerRevealed(false);
  }, [isOpen, draft.options.hideWithSpoiler]);

  const previews = useMemo<PreviewItem[]>(() => {
    return files.map((file) => {
      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");
      return {
        key: makeFileKey(file),
        file,
        url: isImage || isVideo ? URL.createObjectURL(file) : null,
        isImage,
        isVideo,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const previewByEntryId = useMemo(() => {
    const map = new Map<string, PreviewItem>();
    for (let index = 0; index < draft.entries.length; index += 1) {
      const entry = draft.entries[index];
      const preview = previews[index];
      if (entry && preview) {
        map.set(entry.id, preview);
      }
    }
    return map;
  }, [draft.entries, previews]);

  const uploadMediaKind = useMemo(() => {
    return getUploadMediaKind(files);
  }, [files]);

  const hasFolderTree = useMemo(() => {
    return draft.entries.some((entry) => entry.relativePath.includes("/"));
  }, [draft.entries]);

  const tree = useMemo<TreeNode[]>(() => {
    if (!hasFolderTree) {
      return [];
    }

    const root: TreeNode = {
      id: "__root__",
      name: "root",
      kind: "folder",
      children: [],
    };

    const ensureFolder = (
      parent: TreeNode,
      folderId: string,
      name: string,
    ): TreeNode => {
      const existing = parent.children.find(
        (child) => child.kind === "folder" && child.id === folderId,
      );
      if (existing) {
        return existing;
      }
      const created: TreeNode = {
        id: folderId,
        name,
        kind: "folder",
        children: [],
      };
      parent.children.push(created);
      return created;
    };

    for (const entry of draft.entries) {
      const rel = entry.relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
      const parts = rel.split("/").filter(Boolean);
      if (!parts.length) continue;

      let current = root;
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        if (isLast) {
          current.children.push({
            id: entry.id,
            name: part,
            kind: "file",
            children: [],
            entry,
          });
        } else {
          const folderPath = parts.slice(0, i + 1).join("/");
          const folderId = `${folderPath}/`;
          current = ensureFolder(current, folderId, part);
        }
      }
    }

    const sortNode = (node: TreeNode) => {
      node.children.sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "folder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      for (const child of node.children) {
        if (child.kind === "folder") {
          sortNode(child);
        }
      }
    };
    sortNode(root);

    return root.children;
  }, [draft.entries, hasFolderTree]);

  const collectFileIds = (node: TreeNode, out: string[]) => {
    if (node.kind === "file") {
      out.push(node.id);
      return;
    }
    for (const child of node.children) {
      collectFileIds(child, out);
    }
  };

  const allFileIds = useMemo(() => {
    if (!hasFolderTree) {
      return draft.entries.map((entry) => entry.id);
    }
    const ids: string[] = [];
    for (const node of tree) {
      collectFileIds(node, ids);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.entries, hasFolderTree, tree]);

  const selectedFileCount = useMemo(() => {
    let count = 0;
    for (const id of allFileIds) {
      if (draft.selection[id] !== false) {
        count += 1;
      }
    }
    return count;
  }, [allFileIds, draft.selection]);

  const selectAllState: boolean | "indeterminate" = useMemo(() => {
    if (!allFileIds.length) {
      return false;
    }
    const selectedCount = allFileIds.filter(
      (id) => draft.selection[id] !== false,
    ).length;
    if (selectedCount === 0) return false;
    if (selectedCount === allFileIds.length) return true;
    return "indeterminate";
  }, [allFileIds, draft.selection]);

  const oversizedFiles = useMemo(() => {
    const limit =
      Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 0;
    if (!limit) return [];
    const selected = draft.entries
      .filter((entry) => draft.selection[entry.id] !== false)
      .map((entry) => entry.file);
    return selected.filter((file) => file.size > limit);
  }, [draft.entries, draft.selection, files, maxFileBytes]);

  const canConfirm = selectedFileCount > 0 && oversizedFiles.length === 0;

  useEffect(() => {
    if (!hasFolderTree) {
      return;
    }

    setExpandedFolders((prev) => {
      const next = { ...prev };
      const ensureExpanded = (node: TreeNode) => {
        if (node.kind !== "folder") {
          return;
        }
        if (typeof next[node.id] !== "boolean") {
          next[node.id] = true;
        }
        for (const child of node.children) {
          ensureExpanded(child);
        }
      };
      for (const node of tree) {
        ensureExpanded(node);
      }
      return next;
    });
  }, [hasFolderTree, tree]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      const isMod = event.ctrlKey || event.metaKey;
      if (isMod && event.key === "Enter") {
        event.preventDefault();
        if (canConfirm) {
          onConfirm();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canConfirm, isOpen, onClose, onConfirm]);

  useEffect(() => {
    if (!isOpen) return;
    if (draft.options.sendAs !== "photo") return;
    if (uploadMediaKind !== "none") return;
    onChange({
      ...draft,
      options: { ...draft.options, sendAs: "file" },
    });
  }, [draft, isOpen, onChange, uploadMediaKind]);

  useEffect(() => {
    return () => {
      for (const item of previews) {
        if (item.url) {
          URL.revokeObjectURL(item.url);
        }
      }
    };
  }, [previews]);

  const sendLabel = useMemo(() => {
    const count = selectedFileCount;
    const noun =
      draft.options.sendAs === "photo"
        ? uploadMediaKind === "video"
          ? count === 1
            ? "video"
            : "videos"
          : uploadMediaKind === "image"
            ? count === 1
              ? "image"
              : "images"
            : count === 1
              ? "media"
              : "media"
        : count === 1
          ? "file"
          : "files";
    return `Upload ${count} ${noun}`;
  }, [draft.options.sendAs, selectedFileCount, uploadMediaKind]);

  const sendAsMediaLabel =
    uploadMediaKind === "video"
      ? "Upload as Video"
      : uploadMediaKind === "image"
        ? "Upload as Image"
        : "Upload as Media";

  const handlePickMoreFiles = () => {
    fileInputRef.current?.click();
  };

  const handleFilePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files || []);
    if (!picked.length) return;
    // Re-selecting an already staged file must not create a second entry:
    // duplicate entries upload twice and draw two placeholder rows for one
    // file.
    const existingIds = new Set(draft.entries.map((entry) => entry.id));
    const nextEntries: UploadDraftEntry[] = [];
    for (const file of picked) {
      const id = makeFileKey(file);
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      nextEntries.push({ id, file, relativePath: file.name });
    }
    if (!nextEntries.length) {
      event.target.value = "";
      return;
    }
    const mergedEntries = [...draft.entries, ...nextEntries];
    const mergedFiles = mergedEntries.map((entry) => entry.file);
    const nextSendAs =
      draft.options.sendAs === "photo" &&
      getUploadMediaKind(mergedFiles) === "none"
        ? "file"
        : draft.options.sendAs;
    const nextSelection: Record<string, boolean> = { ...draft.selection };
    for (const entry of nextEntries) {
      nextSelection[entry.id] = true;
    }
    onChange({
      ...draft,
      entries: mergedEntries,
      selection: nextSelection,
      options: {
        ...draft.options,
        sendAs: nextSendAs,
      },
    });
    event.target.value = "";
  };

  const previewIsSpoilerHidden =
    draft.options.hideWithSpoiler && !spoilerRevealed;

  const formatBytes = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unitIndex = 0;
    let size = value;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const decimals = unitIndex >= 3 ? 2 : unitIndex === 2 ? 1 : 0;
    return `${size.toFixed(decimals)} ${units[unitIndex]}`;
  };

  if (!isOpen) return null;

  const getSelectedStateForNode = (
    node: TreeNode,
  ): boolean | "indeterminate" => {
    if (node.kind === "file") {
      return draft.selection[node.id] !== false;
    }

    let any = false;
    let all = true;
    for (const child of node.children) {
      const state = getSelectedStateForNode(child);
      if (state === "indeterminate") {
        any = true;
        all = false;
        continue;
      }
      if (state) {
        any = true;
      } else {
        all = false;
      }
    }
    if (all) return true;
    if (!any) return false;
    return "indeterminate";
  };

  const primary = previews[0] ?? null;
  const secondary = previews.slice(1, 3);
  const remainingCount = Math.max(0, previews.length - 3);

  const findNodeById = (nodes: TreeNode[], id: string): TreeNode | null => {
    for (const node of nodes) {
      if (node.id === id) {
        return node;
      }
      if (node.kind === "folder") {
        const found = findNodeById(node.children, id);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };

  const handleToggleNode = (
    nodeId: string,
    kind: TreeNode["kind"],
    checked: boolean,
  ) => {
    const nextSelection: Record<string, boolean> = { ...draft.selection };
    if (kind === "file") {
      nextSelection[nodeId] = checked;
      onChange({ ...draft, selection: nextSelection });
      return;
    }

    const folderNode = findNodeById(tree, nodeId);
    if (!folderNode) {
      return;
    }

    const ids: string[] = [];
    collectFileIds(folderNode, ids);
    for (const id of ids) {
      nextSelection[id] = checked;
    }
    onChange({ ...draft, selection: nextSelection });
  };

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--titlebar-height)] z-[120] flex items-center justify-center p-3">
      <div
        className="absolute inset-0 bg-background/70 animate-fade-in"
        onClick={onClose}
      />

      <div className="relative w-[560px] max-h-[calc(100dvh-var(--titlebar-height)-24px)] max-w-[calc(100vw-24px)]">
        <div className="upload-confirm-backdrop absolute inset-0 rounded-xl" />
        <div className="upload-confirm-shell upload-confirm-widget relative flex max-h-full flex-col overflow-hidden rounded-xl shadow-2xl shadow-black/50 animate-scale-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-body font-semibold text-foreground">
              {sendLabel}
            </h2>
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="h-8 w-8 rounded-md hover:bg-sidebar-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                    aria-label="Upload options"
                  >
                    <MoreHorizontal className="w-4 h-4 mx-auto" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={8}
                  className="z-[140] min-w-[240px] rounded-xl border border-border bg-glass shadow-2xl shadow-black/40 backdrop-saturate-150"
                >
                  <DropdownMenuCheckboxItem
                    checked={draft.options.sendAs === "photo"}
                    disabled={uploadMediaKind === "none"}
                    onCheckedChange={(checked) => {
                      if (!checked) return;
                      onChange({
                        ...draft,
                        options: { ...draft.options, sendAs: "photo" },
                      });
                    }}
                  >
                    {sendAsMediaLabel}
                    <DropdownMenuShortcut>Ctrl+P</DropdownMenuShortcut>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={draft.options.sendAs === "file"}
                    onCheckedChange={(checked) => {
                      if (!checked) return;
                      onChange({
                        ...draft,
                        options: { ...draft.options, sendAs: "file" },
                      });
                    }}
                  >
                    Upload as File
                    <DropdownMenuShortcut>Ctrl+F</DropdownMenuShortcut>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={draft.options.highQuality}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...draft,
                        options: {
                          ...draft.options,
                          highQuality: Boolean(checked),
                        },
                      })
                    }
                  >
                    Upload in High Quality
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={draft.options.hideWithSpoiler}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...draft,
                        options: {
                          ...draft.options,
                          hideWithSpoiler: Boolean(checked),
                        },
                      })
                    }
                  >
                    <EyeOff className="w-4 h-4 mr-2" />
                    Hide with Spoiler
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={draft.options.moveCaptionUp}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...draft,
                        options: {
                          ...draft.options,
                          moveCaptionUp: Boolean(checked),
                        },
                      })
                    }
                  >
                    <ArrowUp className="w-4 h-4 mr-2" />
                    Move Caption Up
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <button
                type="button"
                onClick={handlePickMoreFiles}
                className="h-8 w-8 rounded-md hover:bg-sidebar-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Add files"
              >
                <Plus className="w-4 h-4 mx-auto" />
              </button>

              <button
                type="button"
                onClick={onClose}
                className="h-8 w-8 rounded-md hover:bg-sidebar-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="w-4 h-4 mx-auto" />
              </button>
            </div>
          </div>

          {draft.options.moveCaptionUp ? (
            <div className="shrink-0 px-4 py-3 border-b border-border">
              <input
                value={draft.caption}
                onChange={(e) =>
                  onChange({ ...draft, caption: e.target.value })
                }
                placeholder="Add a caption..."
                className="w-full bg-transparent text-body text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {hasFolderTree ? (
              <div className="rounded-xl overflow-hidden bg-black/30 border border-border">
                <div className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <label className="flex items-center gap-2 text-small text-foreground/90 select-none">
                      <Checkbox
                        checked={selectAllState}
                        onCheckedChange={(checked) => {
                          const value = checked === true;
                          const nextSelection: Record<string, boolean> = {
                            ...draft.selection,
                          };
                          for (const id of allFileIds) {
                            nextSelection[id] = value;
                          }
                          onChange({ ...draft, selection: nextSelection });
                        }}
                      />
                      Select all
                    </label>
                    <span className="text-xs text-muted-foreground">
                      {selectedFileCount}/{allFileIds.length}
                    </span>
                  </div>

                  <div className="max-h-[360px] overflow-auto pr-1">
                    {tree.map((node) => (
                      <UploadTreeRow
                        key={node.id}
                        node={node}
                        depth={0}
                        expandedFolders={expandedFolders}
                        onToggleExpand={(id) =>
                          setExpandedFolders((prev) => ({
                            ...prev,
                            [id]: !(prev[id] ?? true),
                          }))
                        }
                        getSelectedStateForNode={getSelectedStateForNode}
                        onToggleNode={handleToggleNode}
                        previewByEntryId={previewByEntryId}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div
                className="rounded-xl overflow-hidden"
                onClick={() => {
                  if (!draft.options.hideWithSpoiler) return;
                  setSpoilerRevealed((prev) => !prev);
                }}
                role={draft.options.hideWithSpoiler ? "button" : undefined}
                tabIndex={draft.options.hideWithSpoiler ? 0 : -1}
              >
                {previews.length <= 1 ? (
                  <div className="relative aspect-[16/10] flex items-center justify-center">
                    {primary?.isImage && primary.url ? (
                      <img
                        src={primary.url}
                        alt=""
                        draggable={false}
                        className={`h-full w-full object-contain transition-all duration-200 ${
                          previewIsSpoilerHidden ? "blur-xl scale-[1.02]" : ""
                        }`}
                      />
                    ) : primary?.isVideo && primary.url ? (
                      <UploadPreviewVideo
                        src={primary.url}
                        muted
                        className={`upload-confirm-plyr h-full w-full transition-all duration-200 ${
                          previewIsSpoilerHidden ? "blur-xl scale-[1.02]" : ""
                        }`}
                      />
                    ) : (
                      <div className="px-6 text-center">
                        <p className="text-body text-foreground/90 truncate">
                          {primary?.file.name || "File"}
                        </p>
                        <p className="mt-1 text-small text-muted-foreground">
                          Preview unavailable
                        </p>
                      </div>
                    )}
                    {draft.options.hideWithSpoiler ? (
                      <div className="absolute left-3 top-3 rounded-md bg-black/45 px-2 py-1 text-xs text-white/90 border border-white/10">
                        Spoiler
                      </div>
                    ) : null}
                    {draft.options.hideWithSpoiler ? (
                      <div className="absolute bottom-3 left-3 text-xs text-white/70">
                        Click to {previewIsSpoilerHidden ? "reveal" : "hide"}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="grid grid-rows-[1fr_auto] gap-[1px] bg-border">
                    <div className="relative aspect-[16/9] bg-black/50">
                      {primary?.isImage && primary.url ? (
                        <img
                          src={primary.url}
                          alt=""
                          draggable={false}
                          className={`h-full w-full object-cover transition-all duration-200 ${
                            previewIsSpoilerHidden ? "blur-xl scale-[1.02]" : ""
                          }`}
                        />
                      ) : primary?.isVideo && primary.url ? (
                        <video
                          src={primary.url}
                          muted
                          playsInline
                          className={`h-full w-full object-cover transition-all duration-200 ${
                            previewIsSpoilerHidden ? "blur-xl scale-[1.02]" : ""
                          }`}
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
                          <p className="text-small text-muted-foreground truncate">
                            {primary?.file.name || "File"}
                          </p>
                        </div>
                      )}
                      {draft.options.hideWithSpoiler ? (
                        <div className="absolute left-3 top-3 rounded-md bg-black/45 px-2 py-1 text-xs text-white/90 border border-white/10">
                          Spoiler
                        </div>
                      ) : null}
                    </div>
                    <div
                      className={`grid ${
                        secondary.length === 1 ? "grid-cols-1" : "grid-cols-2"
                      } gap-[1px] bg-border`}
                    >
                      {secondary.map((item, index) => {
                        const showRemaining = index === 1 && remainingCount > 0;
                        return (
                          <div
                            key={item.key}
                            className="relative aspect-[16/9] bg-black/50"
                          >
                            {item.isImage && item.url ? (
                              <img
                                src={item.url}
                                alt=""
                                draggable={false}
                                className={`h-full w-full object-cover transition-all duration-200 ${
                                  previewIsSpoilerHidden
                                    ? "blur-xl scale-[1.02]"
                                    : ""
                                }`}
                              />
                            ) : item.isVideo && item.url ? (
                              <video
                                src={item.url}
                                muted
                                playsInline
                                className={`h-full w-full object-cover transition-all duration-200 ${
                                  previewIsSpoilerHidden
                                    ? "blur-xl scale-[1.02]"
                                    : ""
                                }`}
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
                                <p className="text-xs text-muted-foreground truncate">
                                  {item.file.name}
                                </p>
                              </div>
                            )}
                            {showRemaining ? (
                              <div className="absolute inset-0 bg-black/55 flex items-center justify-center">
                                <span className="text-body font-semibold text-white">
                                  +{remainingCount}
                                </span>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {oversizedFiles.length ? (
              <div className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
                <p className="text-small text-destructive">
                  {oversizedFiles.length === 1
                    ? `File too large: ${oversizedFiles[0]?.name || "file"}`
                    : `Some files are too large (${oversizedFiles.length})`}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Max per file: {formatBytes(maxFileBytes)}
                </p>
              </div>
            ) : null}
          </div>

          {!draft.options.moveCaptionUp ? (
            <div className="shrink-0 px-4 pb-4">
              <div className="flex items-center gap-2 rounded-xl bg-primary/10 border border-border px-3 py-2">
                <input
                  value={draft.caption}
                  onChange={(e) =>
                    onChange({ ...draft, caption: e.target.value })
                  }
                  placeholder="Add a caption..."
                  className="flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                />
                <button
                  type="button"
                  className="h-8 w-8 rounded-md hover:bg-sidebar-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                  aria-label="Emoji"
                  disabled
                >
                  <Smile className="w-4 h-4 mx-auto" />
                </button>
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={!canConfirm}
                  className="h-9 w-9 rounded-full bg-primary text-primary-foreground hover:bg-accent transition-colors flex items-center justify-center disabled:opacity-50 disabled:hover:bg-primary"
                  aria-label="Upload"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Tip: Ctrl+Enter to upload
              </p>
            </div>
          ) : (
            <div className="shrink-0 px-4 pb-4 flex justify-end">
              <button
                type="button"
                onClick={onConfirm}
                disabled={!canConfirm}
                className="h-9 w-9 rounded-full bg-primary text-primary-foreground hover:bg-accent transition-colors flex items-center justify-center disabled:opacity-50 disabled:hover:bg-primary"
                aria-label="Upload"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFilePicked}
          />
        </div>
      </div>
    </div>
  );
}

function UploadTreeRow({
  node,
  depth,
  expandedFolders,
  onToggleExpand,
  getSelectedStateForNode,
  onToggleNode,
  previewByEntryId,
}: {
  node: TreeNode;
  depth: number;
  expandedFolders: Record<string, boolean>;
  onToggleExpand: (id: string) => void;
  getSelectedStateForNode: (node: TreeNode) => boolean | "indeterminate";
  onToggleNode: (id: string, kind: TreeNode["kind"], checked: boolean) => void;
  previewByEntryId: Map<string, PreviewItem>;
}) {
  const state = getSelectedStateForNode(node);
  const isExpanded =
    node.kind === "folder" ? expandedFolders[node.id] !== false : false;
  const paddingLeft = 8 + depth * 14;

  const preview = node.kind === "file" ? previewByEntryId.get(node.id) : null;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 rounded-md hover:bg-white/5"
        style={{ paddingLeft }}
      >
        {node.kind === "folder" ? (
          <button
            type="button"
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-white/5 text-muted-foreground"
            onClick={() => onToggleExpand(node.id)}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          <span className="h-6 w-6" />
        )}

        <Checkbox
          checked={state}
          onCheckedChange={(checked) =>
            onToggleNode(node.id, node.kind, checked === true)
          }
        />

        {node.kind === "folder" ? (
          <div
            className="skybox-folder-icon drop-shadow-[0_6px_10px_rgba(0,0,0,0.30)]"
            style={{ "--folder-size": "20px" } as unknown as CSSProperties}
          />
        ) : preview?.url && preview.isImage ? (
          <img
            src={preview.url}
            alt=""
            draggable={false}
            className="h-5 w-5 object-cover bg-black/20"
          />
        ) : preview?.url && preview.isVideo ? (
          <div className="relative h-5 w-5 overflow-hidden bg-black/30">
            <video
              src={preview.url}
              muted
              playsInline
              preload="metadata"
              className="h-full w-full object-cover"
            />
            <Play className="absolute inset-0 m-auto h-3 w-3 text-white/85" />
          </div>
        ) : (
          <FileIcon className="h-4 w-4 text-muted-foreground" />
        )}

        <span className="text-small text-foreground/90 truncate">
          {node.name}
        </span>
      </div>

      {node.kind === "folder" && isExpanded
        ? node.children.map((child) => (
            <UploadTreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedFolders={expandedFolders}
              onToggleExpand={onToggleExpand}
              getSelectedStateForNode={getSelectedStateForNode}
              onToggleNode={onToggleNode}
              previewByEntryId={previewByEntryId}
            />
          ))
        : null}
    </div>
  );
}
