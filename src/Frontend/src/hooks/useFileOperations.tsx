import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileItem } from "@/components/types";
import { getApiBaseUrl, fetchWithTimeout } from "@/lib/api";

// Define the request interface
interface CopyMoveRequest {
  file_id: string;
  target_path: string;
}

interface ClipboardItem {
  item: FileItem;
  operation: "copy" | "cut";
  sourcePath: string;
}

export const useFileOperations = () => {
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);
  const queryClient = useQueryClient();

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

  const pasteItem = async (targetPath: string) => {
    if (!clipboard) return;

    try {
      const baseUrl = getApiBaseUrl();
      // For the default case, we need to append /api to the base URL
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      const request: CopyMoveRequest = {
        file_id: clipboard.item.id || "",
        target_path: targetPath
      };

      if (clipboard.operation === "copy") {
        const response = await fetchWithTimeout(`${apiUrl}/files/copy`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify(request),
        }, 3000); // 3 second timeout

        if (!response.ok) {
          throw new Error("Failed to copy file");
        }
        
        // For copy operations, we only need to refresh the target path
        queryClient.invalidateQueries({ queryKey: ['files', targetPath] });
      } else {
        // Move operation
        const response = await fetchWithTimeout(`${apiUrl}/files/move`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify(request),
        }, 3000); // 3 second timeout

        if (!response.ok) {
          throw new Error("Failed to move file");
        }
        
        // For move operations, refresh both source and target paths
        queryClient.invalidateQueries({ queryKey: ['files', clipboard.sourcePath] });
        queryClient.invalidateQueries({ queryKey: ['files', targetPath] });
        
        // Force a refetch of the source path data to immediately update the UI
        queryClient.refetchQueries({ queryKey: ['files', clipboard.sourcePath] });
      }

      // Clear clipboard after successful operation
      clearClipboard();
      return true;
    } catch (error) {
      console.error("Error during paste operation:", error);
      throw error;
    }
  };

  return {
    clipboard,
    copyItem,
    cutItem,
    clearClipboard,
    hasClipboard,
    pasteItem,
  };
};