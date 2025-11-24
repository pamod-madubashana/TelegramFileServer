import { useState, useEffect } from "react";
import { FileItem } from "./types";
import { FileText, Image as ImageIcon, FileVideo, FileAudio, FileArchive } from "lucide-react";

interface ThumbnailProps {
  item: FileItem;
}

export const Thumbnail = ({ item }: ThumbnailProps) => {
  const [thumbnailError, setThumbnailError] = useState(false);
  const [thumbnailLoading, setThumbnailLoading] = useState(true);

  // Reset error state when item changes
  useEffect(() => {
    setThumbnailError(false);
    setThumbnailLoading(true);
  }, [item.thumbnail]);

  // If it's a folder, show folder icon
  if (item.type === "folder") {
    return (
      <div className="w-20 h-20 flex items-center justify-center">
        <div className="w-20 h-20 text-primary flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
          </svg>
        </div>
      </div>
    );
  }

  // If no thumbnail or thumbnail already failed, show default icon
  if (!item.thumbnail || thumbnailError) {
    return (
      <div className="w-20 h-20 flex items-center justify-center">
        {getDefaultFileIcon(item)}
      </div>
    );
  }

  return (
    <div className="relative w-20 h-20 flex items-center justify-center">
      {thumbnailLoading && (
        <div className="absolute inset-0 flex items-center justify-center">
          {getDefaultFileIcon(item)}
        </div>
      )}
      <img
        src={`/api/file/${item.thumbnail}/thumbnail`}
        alt={item.name}
        className={`max-w-full max-h-full object-contain rounded ${thumbnailLoading ? 'opacity-0' : 'opacity-100'} transition-opacity duration-300`}
        onLoad={() => {
          setThumbnailLoading(false);
        }}
        onError={() => {
          setThumbnailError(true);
          setThumbnailLoading(false);
        }}
      />
    </div>
  );
};

const getDefaultFileIcon = (item: FileItem) => {
  switch (item.fileType) {
    case 'photo':
      return <ImageIcon className="w-10 h-10 text-blue-500" />;
    case 'video':
      return <FileVideo className="w-10 h-10 text-purple-500" />;
    case 'audio':
    case 'voice':
      return <FileAudio className="w-10 h-10 text-green-500" />;
    case 'document':
      if (item.extension === 'pdf') {
        return <FileText className="w-10 h-10 text-red-500" />;
      } else if (['doc', 'docx'].includes(item.extension || '')) {
        return <FileText className="w-10 h-10 text-blue-700" />;
      } else if (['xls', 'xlsx'].includes(item.extension || '')) {
        return <FileText className="w-10 h-10 text-green-600" />;
      } else if (['zip', 'rar', '7z'].includes(item.extension || '')) {
        return <FileArchive className="w-10 h-10 text-yellow-500" />;
      }
      return <FileText className="w-10 h-10 text-muted-foreground" />;
    default:
      return <FileText className="w-10 h-10 text-muted-foreground" />;
  }
};