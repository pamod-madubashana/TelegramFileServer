import { useState, useEffect, useRef } from "react";

interface DeleteConfirmDialogProps {
  open: boolean;
  itemName: string;
  itemType: "file" | "folder";
  onConfirm: () => void;
  onCancel: () => void;
}

export const DeleteConfirmDialog = ({
  open,
  itemName,
  itemType,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && dialogRef.current) {
      // Focus the cancel button when dialog opens
      const cancelButton = dialogRef.current.querySelector('[data-cancel-button]') as HTMLButtonElement;
      if (cancelButton) {
        cancelButton.focus();
      }
    }
  }, [open]);

  const handleConfirm = async () => {
    setIsDeleting(true);
    try {
      onConfirm();
    } finally {
      setIsDeleting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
    }
  };

  if (!open) return null;

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onKeyDown={handleKeyDown}
    >
      <div 
        ref={dialogRef}
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md"
      >
        <div className="p-6">
          <h2 className="text-xl font-semibold text-foreground mb-2">Delete {itemType}?</h2>
          
          <p className="text-foreground mb-4">
            Are you sure you want to delete <span className="font-medium">"{itemName}"</span>?
            {itemType === "folder" && (
              <span className="block mt-2">This will permanently delete the folder and all its contents.</span>
            )}
            <span className="block mt-2">This action cannot be undone.</span>
          </p>
          
          <div className="flex justify-end gap-3">
            <button
              data-cancel-button
              type="button"
              onClick={onCancel}
              disabled={isDeleting}
              className="px-4 py-2 text-foreground bg-secondary hover:bg-secondary/80 rounded-md transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isDeleting}
              className="px-4 py-2 text-white bg-destructive hover:bg-destructive/90 rounded-md transition-colors disabled:opacity-50"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};