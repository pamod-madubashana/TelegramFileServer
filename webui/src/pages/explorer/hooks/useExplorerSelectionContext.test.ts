import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type FileItem } from "@/components/skybox/FileRow";
import type { UploadQueueItemState } from "@/pages/explorer/shared";
import { useExplorerSelectionContext } from "./useExplorerSelectionContext";

type Args = Parameters<typeof useExplorerSelectionContext>[0];

const CURRENT_PATH = "tg://saved/MyFolder";

const fileItem = (name: string): FileItem =>
  ({ name, path: `${CURRENT_PATH}/${name}` }) as unknown as FileItem;

const queueItem = (
  overrides: Partial<UploadQueueItemState> & { fileName: string },
): UploadQueueItemState => ({
  id: overrides.fileName,
  status: "uploading",
  progress: 0,
  destinationVirtualPath: CURRENT_PATH,
  ...overrides,
});

const makeArgs = (overrides: Partial<Args> = {}): Args => ({
  activePaste: null,
  clipboardItem: null,
  closeDetailsPanel: () => {},
  contextMenuState: null,
  currentPath: CURRENT_PATH,
  filesRef: { current: [] },
  isUploadInProgress: true,
  onOpenFile: () => {},
  openDetailsPanel: () => {},
  requestDeleteTargets: () => {},
  selectedFile: null,
  selectedPaths: [],
  selectionAnchorPathRef: { current: null },
  selectionBox: null,
  setContextMenuState: () => {},
  setSelectedFile: () => {},
  setSelectedPaths: () => {},
  sortedFiles: [],
  uploadActivePlaceholderPath: CURRENT_PATH,
  uploadQueueItems: [],
  viewMode: "list",
  ...overrides,
});

const renderSelection = (overrides: Partial<Args> = {}) =>
  renderHook(() => useExplorerSelectionContext(makeArgs(overrides))).result
    .current;

describe("useExplorerSelectionContext upload placeholder", () => {
  it("draws only the named placeholder while an upload is in flight", () => {
    const result = renderSelection({
      uploadQueueItems: [queueItem({ fileName: "a.jpg" })],
    });

    expect(result.uploadPlaceholderItem?.fileName).toBe("a.jpg");
    expect(result.shouldShowUploadPlaceholder).toBe(true);
    expect(result.uploadSkeletonCount).toBe(0);
  });

  it("drops the placeholder once the file landed in the listing", () => {
    const result = renderSelection({
      sortedFiles: [fileItem("a.jpg")],
      uploadQueueItems: [queueItem({ fileName: "a.jpg" })],
    });

    expect(result.uploadPlaceholderItem).toBeNull();
    expect(result.shouldShowUploadPlaceholder).toBe(false);
    expect(result.uploadSkeletonCount).toBe(0);
    expect(result.hasVisibleItems).toBe(true);
  });

  it("matches folder-prefixed queue names against the listing", () => {
    const result = renderSelection({
      sortedFiles: [fileItem("a.jpg")],
      uploadQueueItems: [
        queueItem({
          fileName: "MyFolder/a.jpg",
          destinationVirtualPath: CURRENT_PATH,
        }),
      ],
    });

    expect(result.uploadPlaceholderItem).toBeNull();
    expect(result.shouldShowUploadPlaceholder).toBe(false);
    expect(result.uploadSkeletonCount).toBe(0);
  });

  it("collapses duplicate queue entries for one file into a single row", () => {
    const result = renderSelection({
      uploadQueueItems: [
        queueItem({ fileName: "a.jpg", status: "queued", id: "1" }),
        queueItem({ fileName: "a.jpg", status: "uploading", id: "2" }),
      ],
    });

    expect(result.uploadPlaceholderItem?.id).toBe("2");
    expect(result.shouldShowUploadPlaceholder).toBe(true);
    expect(result.uploadSkeletonCount).toBe(0);
  });

  it("still draws a skeleton when the active placeholder path points elsewhere", () => {
    const result = renderSelection({
      uploadActivePlaceholderPath: "tg://saved/Other",
      uploadQueueItems: [queueItem({ fileName: "a.jpg" })],
    });

    expect(result.shouldShowUploadPlaceholder).toBe(false);
    expect(result.uploadSkeletonCount).toBe(1);
  });

  it("draws one named placeholder plus one skeleton for two distinct files", () => {
    const result = renderSelection({
      uploadQueueItems: [
        queueItem({ fileName: "a.jpg", id: "1" }),
        queueItem({ fileName: "b.jpg", id: "2" }),
      ],
    });

    expect(result.uploadPlaceholderItem?.fileName).toBe("a.jpg");
    expect(result.shouldShowUploadPlaceholder).toBe(true);
    expect(result.uploadSkeletonCount).toBe(1);
  });
});
