import { useState } from "react";
import { FileItem } from "@/components/types";

interface ClipboardItem {
  item: FileItem;
  operation: "copy" | "cut";
  sourcePath: string;
}

export const useFileOperations = () => {
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);

  const copyItem = (item: FileItem, sourcePath: string) => {
    setClipboard({ item, operation: "copy", sourcePath });
  };

  const cutItem = (item: FileItem, sourcePath: string) => {
    setClipboard({ item, operation: "cut", sourcePath });
  };

  const clearClipboard = () => {
    setClipboard(null);
  };

  const hasClipboard = () => clipboard !== null;

  return {
    clipboard,
    copyItem,
    cutItem,
    clearClipboard,
    hasClipboard,
  };
};
