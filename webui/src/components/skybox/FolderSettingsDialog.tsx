import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ImagePlus, RefreshCcw, Upload } from "lucide-react";
import { FolderArtwork } from "@/components/skybox/FolderArtwork";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { type FileItem } from "@/components/skybox/FileRow";
import { resolveThumbnailSrc } from "@/lib/thumbnail-src";
import {
  ALLOWED_FOLDER_ICON_EXTENSIONS,
  getFolderSettingsErrorMessage,
  getFolderTypeLabel,
  isTmdbFolderType,
  supportsArtworkVariants,
  type FolderIconMode,
  type FolderSettings,
  type FolderSettingsDto,
  type FolderSettingsSaveInput,
  type FolderType,
  mapFolderSettingsDto,
} from "@/lib/folder-settings";

interface FolderSettingsDialogProps {
  folder: FileItem | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function getParentFolderInput(folderPath: string): {
  folderId: string;
  folderName: string;
} | null {
  const normalizedPath = folderPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!normalizedPath || /^[a-zA-Z]:$/.test(normalizedPath)) {
    return null;
  }

  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return null;
  }

  const parentId = normalizedPath.slice(0, lastSlashIndex);
  if (!parentId || /^[a-zA-Z]:$/.test(parentId)) {
    return null;
  }

  const parentName = parentId.slice(parentId.lastIndexOf("/") + 1);
  if (!parentName) {
    return null;
  }

  return {
    folderId: parentId,
    folderName: parentName,
  };
}

function getFolderTypeForDialog(
  folderType: FolderType,
  parentCollectionType: FolderType | null,
): FolderType {
  if (parentCollectionType === "movie_collection") {
    return folderType === "movie" ? "movie" : "normal";
  }

  if (parentCollectionType === "tv_collection") {
    return folderType === "tv" ? "tv" : "normal";
  }

  if (folderType === "movie") {
    return "movie_collection";
  }

  if (folderType === "tv") {
    return "tv_collection";
  }

  if (folderType === "music") {
    return "normal";
  }

  return folderType;
}

const folderIconModeOptions: Array<{
  value: FolderIconMode;
  label: string;
  description: string;
}> = [
  {
    value: "default",
    label: "Default",
    description: "Use the standard TFS folder look.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "Apply saved folder type styling.",
  },
  {
    value: "custom",
    label: "Custom icon",
    description: "Use your uploaded folder icon.",
  },
];

function getIconModeForDialog(
  iconMode: FolderIconMode | null | undefined,
  allowAutoAppearanceMode: boolean,
): FolderIconMode {
  if (iconMode === "custom") {
    return "custom";
  }

  if (iconMode === "default") {
    return "default";
  }

  return allowAutoAppearanceMode ? "auto" : "default";
}

const rootFolderTypeOptions: Array<{
  value: FolderType;
  label: string;
  description: string;
}> = [
  {
    value: "normal",
    label: "Default",
    description: "Keep the regular folder classification.",
  },
  {
    value: "movie_collection",
    label: "Movie collection",
    description: "Treat this folder as a movie library root.",
  },
  {
    value: "tv_collection",
    label: "TV collection",
    description: "Treat this folder as a TV library root.",
  },
];

const nestedMovieFolderTypeOptions: Array<{
  value: FolderType;
  label: string;
  description: string;
}> = [
  {
    value: "normal",
    label: "Default",
    description: "Keep the folder on default behavior inside the collection.",
  },
  {
    value: "movie",
    label: "Movie",
    description: "Mark this folder as a movie item in the collection.",
  },
];

const nestedTvFolderTypeOptions: Array<{
  value: FolderType;
  label: string;
  description: string;
}> = [
  {
    value: "normal",
    label: "Default",
    description: "Keep the folder on default behavior inside the collection.",
  },
  {
    value: "tv",
    label: "TV",
    description: "Mark this folder as a TV item in the collection.",
  },
];

export function FolderSettingsDialog({
  folder,
  isOpen,
  onClose,
  onSaved,
}: FolderSettingsDialogProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const appearanceModeSectionRef = useRef<HTMLElement | null>(null);
  const customIconSectionRef = useRef<HTMLElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [settings, setSettings] = useState<FolderSettings | null>(null);
  const [parentSettings, setParentSettings] = useState<FolderSettings | null>(
    null,
  );
  const [folderType, setFolderType] = useState<FolderType>("normal");
  const [iconMode, setIconMode] = useState<FolderIconMode>("default");
  const [selectedIconFile, setSelectedIconFile] = useState<File | null>(null);
  const [selectedIconPreview, setSelectedIconPreview] = useState<string | null>(
    null,
  );
  const [isCustomSectionMounted, setIsCustomSectionMounted] = useState(false);
  const [isCustomSectionVisible, setIsCustomSectionVisible] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [storedIconMissing, setStoredIconMissing] = useState(false);
  const parentCollectionType =
    parentSettings?.iconMode !== "default" &&
    (parentSettings?.folderType === "movie_collection" ||
      parentSettings?.folderType === "tv_collection")
      ? parentSettings.folderType
      : null;
  const allowAutoAppearanceMode = parentCollectionType !== null;

  const folderTypeOptions = useMemo<
    Array<{ value: FolderType; label: string; description: string }>
  >(
    () =>
      parentCollectionType === "movie_collection"
        ? nestedMovieFolderTypeOptions
        : parentCollectionType === "tv_collection"
          ? nestedTvFolderTypeOptions
          : rootFolderTypeOptions,
    [parentCollectionType],
  );
  const availableIconModeOptions = useMemo(
    () =>
      allowAutoAppearanceMode
        ? folderIconModeOptions
        : folderIconModeOptions.filter((option) => option.value !== "auto"),
    [allowAutoAppearanceMode],
  );
  const selectedFolderTypeOption = useMemo(
    () =>
      folderTypeOptions.find((option) => option.value === folderType) ||
      folderTypeOptions[0],
    [folderType, folderTypeOptions],
  );
  const selectedIconModeOption = useMemo(
    () =>
      availableIconModeOptions.find((option) => option.value === iconMode) ||
      availableIconModeOptions[0],
    [availableIconModeOptions, iconMode],
  );

  useEffect(() => {
    if (!selectedIconPreview) {
      return;
    }

    return () => {
      URL.revokeObjectURL(selectedIconPreview);
    };
  }, [selectedIconPreview]);

  useEffect(() => {
    if (isOpen) {
      return;
    }

    setSelectedIconFile(null);
    setSelectedIconPreview((currentPreview) => {
      if (currentPreview) {
        URL.revokeObjectURL(currentPreview);
      }
      return null;
    });
    setStoredIconMissing(false);
    setErrorMessage(null);
    setIsCustomSectionMounted(false);
    setIsCustomSectionVisible(false);
    setParentSettings(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !folder?.isDirectory) {
      return;
    }

    let cancelled = false;
    const parentFolderInput = getParentFolderInput(folder.path);
    setIsLoading(true);
    setErrorMessage(null);
    setStoredIconMissing(false);

    void invoke<FolderSettingsDto[]>("folder_settings_bootstrap_many", {
      inputs: [
        {
          folderId: folder.path,
          folderName: folder.name,
        },
        ...(parentFolderInput ? [parentFolderInput] : []),
      ],
    })
      .then((result) => {
        if (cancelled) {
          return;
        }

        const rowsById = new Map(
          result.map((entry) => [entry.folder_id, mapFolderSettingsDto(entry)]),
        );
        const nextSettings = rowsById.get(folder.path) || null;
        const nextParentSettings = parentFolderInput
          ? rowsById.get(parentFolderInput.folderId) || null
          : null;
        const nextParentCollectionType =
          nextParentSettings?.iconMode !== "default" &&
          (nextParentSettings?.folderType === "movie_collection" ||
            nextParentSettings?.folderType === "tv_collection")
            ? nextParentSettings.folderType
            : null;

        setSettings(nextSettings);
        setParentSettings(nextParentSettings);
        setFolderType(
          getFolderTypeForDialog(
            nextSettings?.folderType || "normal",
            nextParentCollectionType,
          ),
        );
        setIconMode(
          getIconModeForDialog(
            nextSettings?.iconMode,
            nextParentCollectionType !== null,
          ),
        );
        setSelectedIconFile(null);
        setSelectedIconPreview(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setErrorMessage(getFolderSettingsErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [folder, isOpen]);

  useEffect(() => {
    if (allowAutoAppearanceMode || iconMode !== "auto") {
      return;
    }

    setIconMode("default");
  }, [allowAutoAppearanceMode, iconMode]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let frame: number | null = null;
    let customTimeout: number | null = null;

    if (iconMode === "custom") {
      setIsCustomSectionMounted(true);
      frame = window.requestAnimationFrame(() => {
        setIsCustomSectionVisible(true);
        customIconSectionRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      });
    } else {
      appearanceModeSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
      setIsCustomSectionVisible(false);
      if (isCustomSectionMounted) {
        customTimeout = window.setTimeout(() => {
          setIsCustomSectionMounted(false);
        }, 220);
      }
    }

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      if (customTimeout !== null) {
        window.clearTimeout(customTimeout);
      }
    };
  }, [iconMode, isCustomSectionMounted, isOpen]);

  const managedArtworkVariant = supportsArtworkVariants(folderType)
    ? "folder_poster"
    : "case_plain";
  const effectiveIconMode =
    !allowAutoAppearanceMode && iconMode === "auto" ? "default" : iconMode;

  const previewSettings = useMemo<FolderSettings | null>(() => {
    if (!folder) {
      return settings;
    }

    if (selectedIconPreview && effectiveIconMode === "custom") {
      return {
        ...(settings || {
          folderId: folder.path,
          folderType,
          detectedType: folderType,
          iconMode: effectiveIconMode,
          isManualOverride: true,
          artworkVariant: managedArtworkVariant,
          updatedAt: Date.now(),
        }),
        folderId: folder.path,
        folderType,
        iconMode: effectiveIconMode,
        isManualOverride: true,
        artworkVariant: managedArtworkVariant,
        customIconAssetPath: selectedIconPreview,
        customIconIcoPath: null,
        sourceImageName: selectedIconFile?.name || null,
        updatedAt: Date.now(),
      };
    }

    return settings
      ? {
          ...settings,
          folderType,
          iconMode:
            effectiveIconMode === "auto" &&
            isTmdbFolderType(folderType) &&
            settings.tmdbLocalPosterPath
              ? "tmdb_poster"
              : effectiveIconMode,
          artworkVariant: managedArtworkVariant,
        }
      : null;
  }, [
    effectiveIconMode,
    folder,
    folderType,
    managedArtworkVariant,
    selectedIconFile?.name,
    selectedIconPreview,
    settings,
  ]);

  const currentStoredCustomPreview = useMemo(
    () =>
      resolveThumbnailSrc(
        settings?.customIconAssetPath || settings?.customIconIcoPath,
      ),
    [settings?.customIconAssetPath, settings?.customIconIcoPath],
  );

  const handleSelectIcon = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] || null;
    if (!nextFile) {
      return;
    }

    const lowerName = nextFile.name.toLowerCase();
    const isSupported = ALLOWED_FOLDER_ICON_EXTENSIONS.some((extension) =>
      lowerName.endsWith(extension),
    );

    if (!isSupported) {
      setErrorMessage(
        `Unsupported file type. Use ${ALLOWED_FOLDER_ICON_EXTENSIONS.join(", ")}.`,
      );
      event.target.value = "";
      return;
    }

    setErrorMessage(null);
    setStoredIconMissing(false);
    setSelectedIconFile(nextFile);
    setSelectedIconPreview((currentPreview) => {
      if (currentPreview) {
        URL.revokeObjectURL(currentPreview);
      }

      return URL.createObjectURL(nextFile);
    });
    setIconMode("custom");
    event.target.value = "";
  };

  const handleSave = async () => {
    if (!folder) {
      return;
    }

    setErrorMessage(null);
    if (iconMode === "custom" && storedIconMissing && !selectedIconFile) {
      setErrorMessage(
        "The saved custom icon file is missing. Upload a new icon or reset this folder.",
      );
      return;
    }

    const payload: FolderSettingsSaveInput = {
      folderId: folder.path,
      folderName: folder.name,
      folderType,
      iconMode:
        effectiveIconMode === "auto" &&
        isTmdbFolderType(folderType) &&
        settings?.tmdbLocalPosterPath
          ? "tmdb_poster"
          : effectiveIconMode,
      isManualOverride: true,
      artworkVariant: managedArtworkVariant,
      clearTmdbSelection:
        effectiveIconMode !== "auto" || !isTmdbFolderType(folderType),
    };
    const savedFolderName = folder.name;
    const savedTypeLabel = getFolderTypeLabel(folderType);

    onClose();

    try {
      if (selectedIconFile) {
        const bytes = Array.from(
          new Uint8Array(await selectedIconFile.arrayBuffer()),
        );
        payload.customIconFileName = selectedIconFile.name;
        payload.customIconBytes = bytes;
      }

      await invoke<FolderSettingsDto>("folder_settings_save", {
        input: payload,
      });

      toast({
        title: "Folder settings saved",
        description: `${savedFolderName} now uses ${savedTypeLabel} settings.`,
      });
      void onSaved();
    } catch (error) {
      toast({
        title: "Failed to save folder settings",
        description: getFolderSettingsErrorMessage(error),
        variant: "destructive",
      });
    }
  };

  const handleReset = async () => {
    if (!folder) {
      return;
    }

    setIsResetting(true);
    setErrorMessage(null);

    try {
      const reset = await invoke<FolderSettingsDto>("folder_settings_reset", {
        folderId: folder.path,
        folderName: folder.name,
      });

      setSettings(mapFolderSettingsDto(reset));
      setFolderType(
        getFolderTypeForDialog(reset.folder_type, parentCollectionType),
      );
      setIconMode(
        getIconModeForDialog(reset.icon_mode, allowAutoAppearanceMode),
      );
      setSelectedIconFile(null);
      setSelectedIconPreview(null);
      toast({
        title: "Folder settings reset",
        description: `${folder.name} returned to default behavior.`,
      });
      onSaved();
      onClose();
    } catch (error) {
      setErrorMessage(getFolderSettingsErrorMessage(error));
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[min(92vw,540px)] flex-col overflow-hidden border-primary/25 bg-background/95 p-0 shadow-[0_24px_60px_rgba(0,0,0,0.32)]">
        <DialogHeader>
          <div className="px-5 pt-5">
            <DialogTitle>Folder settings</DialogTitle>
            <DialogDescription>
              Choose how this folder is classified and rendered in TFS.
            </DialogDescription>
          </div>
        </DialogHeader>

        {!folder ? null : (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 pb-4">
            <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-secondary/20 p-3 sm:flex-row sm:items-center">
              <div className="flex justify-center sm:justify-start">
                <FolderArtwork
                  name={folder.name}
                  path={folder.path}
                  settings={previewSettings}
                  size={72}
                  folderClassName="drop-shadow-[0_12px_24px_rgba(0,0,0,0.24)]"
                  symbolClassName="absolute left-1/2 top-[56%] h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-black/75 mix-blend-multiply"
                  badgeClassName="-right-1 top-1"
                />
              </div>

              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  {folder.name}
                </p>
                <p className="text-sm text-muted-foreground break-all">
                  {folder.path}
                </p>
                <p className="text-xs text-muted-foreground">
                  Auto-detected type:{" "}
                  {getFolderTypeLabel(settings?.detectedType || "normal")}
                </p>
                {settings?.isManualOverride ? (
                  <p className="text-xs text-muted-foreground">
                    Manual override is active until you reset this folder.
                  </p>
                ) : null}
              </div>
            </div>

            <section ref={appearanceModeSectionRef} className="space-y-3">
              <div>
                <Label className="text-sm font-semibold">Folder type</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  This controls how TFS classifies the folder. Collection
                  types style library roots, while nested collection folders can
                  be assigned as Movie or TV items.
                </p>
              </div>

              <div className="space-y-2 rounded-xl border border-primary/15 bg-secondary/10 p-3">
                <Select
                  value={folderType}
                  onValueChange={(value) => setFolderType(value as FolderType)}
                >
                  <SelectTrigger className="h-11 border-primary/20 bg-background/70 text-left">
                    <SelectValue placeholder="Select folder type" />
                  </SelectTrigger>
                  <SelectContent>
                    {folderTypeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {selectedFolderTypeOption ? (
                  <p className="text-xs text-muted-foreground">
                    {selectedFolderTypeOption.description}
                  </p>
                ) : null}
              </div>
            </section>

            <section className="space-y-3">
              <div>
                <Label className="text-sm font-semibold">Appearance mode</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {allowAutoAppearanceMode
                    ? "Default keeps the regular folder, Auto uses the saved type, and Custom icon uses your uploaded artwork."
                    : "Default keeps the regular folder, and Custom icon uses your uploaded artwork. Auto only appears for folders inside a collection parent."}
                </p>
              </div>

              <div className="space-y-2 rounded-xl border border-primary/15 bg-secondary/10 p-3">
                <Select
                  value={effectiveIconMode}
                  onValueChange={(value) =>
                    setIconMode(value as FolderIconMode)
                  }
                >
                  <SelectTrigger className="h-11 border-primary/20 bg-background/70 text-left">
                    <SelectValue placeholder="Select appearance mode" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableIconModeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {selectedIconModeOption ? (
                  <p className="text-xs text-muted-foreground">
                    {selectedIconModeOption.description}
                  </p>
                ) : null}
              </div>
            </section>

            {isCustomSectionMounted ? (
              <div
                className={`grid overflow-hidden transition-all duration-200 ease-out ${
                  isCustomSectionVisible
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0"
                }`}
              >
                <section
                  ref={customIconSectionRef}
                  className="min-h-0 space-y-3 overflow-hidden pb-1"
                >
                  <div>
                    <Label className="text-sm font-semibold">Custom icon</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Supports `.ico`, `.png`, `.jpg`, `.jpeg`, and `.webp`.
                      Raster images convert to `.ico` locally when you save.
                    </p>
                  </div>

                  <div className="rounded-xl border border-dashed border-primary/20 bg-secondary/10 p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <p className="text-sm text-foreground">
                          {selectedIconFile?.name ||
                            settings?.sourceImageName ||
                            "No custom icon selected"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Custom icon mode is active.
                        </p>
                      </div>

                      <div className="flex gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept={ALLOWED_FOLDER_ICON_EXTENSIONS.join(",")}
                          className="hidden"
                          onChange={handleSelectIcon}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Upload className="h-4 w-4" />
                          Upload icon
                        </Button>
                        {selectedIconFile ? (
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              setSelectedIconFile(null);
                              setSelectedIconPreview((currentPreview) => {
                                if (currentPreview) {
                                  URL.revokeObjectURL(currentPreview);
                                }
                                return null;
                              });
                            }}
                          >
                            Clear
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {!selectedIconPreview && !currentStoredCustomPreview ? (
                      <div className="mt-4 flex items-center gap-2 rounded-lg bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                        <ImagePlus className="h-4 w-4" />
                        Upload an icon before saving custom mode.
                      </div>
                    ) : null}

                    {storedIconMissing ? (
                      <div className="mt-4 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        <RefreshCcw className="h-4 w-4" />
                        The saved custom icon file is missing. Upload a new icon
                        or reset this folder.
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            ) : null}

            {errorMessage ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="mt-auto flex items-center justify-between gap-2 border-t border-primary/15 px-5 py-4 sm:justify-between">
          <div>
            <Button
              type="button"
              variant="outline"
              className="border-primary/20 bg-secondary/10 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground"
              disabled={isLoading || isResetting || !folder}
              onClick={() => {
                void handleReset();
              }}
            >
              Reset to default
            </Button>
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="border-primary/20 bg-secondary/10 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground"
              disabled={isLoading || isResetting}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                isLoading ||
                isResetting ||
                !folder ||
                (iconMode === "custom" &&
                  ((!selectedIconFile &&
                    !settings?.customIconAssetPath &&
                    !settings?.customIconIcoPath) ||
                    (storedIconMissing && !selectedIconFile)))
              }
              onClick={() => {
                void handleSave();
              }}
            >
              Save
            </Button>
          </div>
        </DialogFooter>

        {currentStoredCustomPreview && !selectedIconPreview ? (
          <img
            src={currentStoredCustomPreview}
            alt=""
            className="hidden"
            onError={() => setStoredIconMissing(true)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
