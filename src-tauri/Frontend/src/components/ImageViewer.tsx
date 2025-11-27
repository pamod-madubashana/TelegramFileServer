import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";

interface ImageViewerProps {
  imageUrl: string;
  fileName: string;
  onClose: () => void;
}

export const ImageViewer = ({ imageUrl, fileName, onClose }: ImageViewerProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (viewerRef.current && e.target === viewerRef.current) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  const handleImageLoad = () => {
    setIsLoading(false);
  };

  const handleImageError = () => {
    setIsLoading(false);
    setError(true);
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <div 
      ref={viewerRef}
      className="fixed inset-0 bg-black bg-opacity-90 z-50 flex items-center justify-center p-4"
    >
      <button
        onClick={handleClose}
        className="absolute top-4 right-4 text-white hover:text-gray-300 transition-colors z-10"
        aria-label="Close viewer"
      >
        <X size={32} />
      </button>
      
      <div className="text-white absolute top-4 left-4 text-lg font-semibold z-10">
        {fileName}
      </div>
      
      <div className="relative flex items-center justify-center w-full h-full">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
          </div>
        )}
        
        {error ? (
          <div className="text-white text-center z-10">
            <p className="text-xl mb-2">Failed to load image</p>
            <p className="text-gray-300">The image could not be loaded.</p>
            <button
              onClick={onClose}
              className="mt-4 px-4 py-2 bg-white text-black rounded hover:bg-gray-200 transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <img
            src={imageUrl}
            alt={fileName}
            className="max-w-full max-h-full object-contain"
            onLoad={handleImageLoad}
            onError={handleImageError}
            style={{ display: isLoading ? "none" : "block" }}
          />
        )}
      </div>
    </div>
  );
};