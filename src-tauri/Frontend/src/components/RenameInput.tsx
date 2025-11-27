import { useState, useEffect, useRef } from "react";
import { Input } from "./ui/input";

interface RenameInputProps {
  initialName: string;
  onSave: (newName: string) => void;
  onCancel: () => void;
}

export const RenameInput = ({ initialName, onSave, onCancel }: RenameInputProps) => {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      // Select filename without extension
      const lastDotIndex = initialName.lastIndexOf(".");
      if (lastDotIndex > 0) {
        inputRef.current.setSelectionRange(0, lastDotIndex);
      } else {
        inputRef.current.select();
      }
    }
  }, [initialName]);

  const handleSubmit = () => {
    if (value.trim() && value !== initialName) {
      onSave(value.trim());
    } else {
      onCancel();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit();
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleSubmit}
      onKeyDown={handleKeyDown}
      className="h-7 text-xs bg-background"
      onClick={(e) => e.stopPropagation()}
    />
  );
};
