import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";

interface NewFolderDialogProps {
  open: boolean;
  currentPath: string;
  onClose: () => void;
  onConfirm: (folderName: string) => void;
}

export const NewFolderDialog = ({ open, currentPath, onClose, onConfirm }: NewFolderDialogProps) => {
  const [folderName, setFolderName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      // Focus the input when dialog opens
      inputRef.current.focus();
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!folderName.trim()) {
      toast.error("Folder name cannot be empty");
      return;
    }
    
    onConfirm(folderName.trim());
    setFolderName("");
  };

  const handleClose = () => {
    setFolderName("");
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div 
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md"
        onKeyDown={handleKeyDown}
      >
        <div className="p-6">
          <h2 className="text-xl font-semibold text-foreground mb-4">Create New Folder</h2>
          
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label htmlFor="folderName" className="block text-sm font-medium text-foreground mb-2">
                Folder Name
              </label>
              <input
                ref={inputRef}
                id="folderName"
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                className="w-full px-3 py-2 border border-input bg-background text-foreground rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="Enter folder name"
              />
            </div>
            
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-foreground bg-secondary hover:bg-secondary/80 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-white bg-primary hover:bg-primary/90 rounded-md transition-colors"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};