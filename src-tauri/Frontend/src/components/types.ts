export interface FileItem {
  id?: string;
  file_unique_id?: string;
  name: string;
  type: "file" | "folder";
  icon: string;
  extension?: string;
  size?: number;
  fileType?: 'document' | 'video' | 'photo' | 'voice' | 'audio' | 'folder';
  thumbnail?: string | null;
  file_path?: string;  // Path where file is located (folder name)
}

export interface ApiFile {
  id: string;
  chat_id: number;
  message_id: number;
  file_type: 'document' | 'video' | 'photo' | 'voice' | 'audio' | 'folder';
  thumbnail: string | null;
  file_unique_id: string;
  file_size: number;
  file_name: string | null;
  file_caption: string | null;
  file_path: string;  // Path where file is located
}

// Utility function to get icon based on file type
export const getFileIcon = (fileType: string, fileName?: string): string => {
  const extension = fileName?.split('.').pop()?.toLowerCase();

  switch (fileType) {
    case 'folder':
      return '📁';
    case 'photo':
      return '🖼️';
    case 'video':
      return '🎬';
    case 'audio':
    case 'voice':
      return '🎵';
    case 'document':
      if (extension === 'pdf') return '📄';
      if (['doc', 'docx'].includes(extension || '')) return '📝';
      if (['xls', 'xlsx'].includes(extension || '')) return '📊';
      if (['zip', 'rar', '7z'].includes(extension || '')) return '📦';
      return '📄';
    default:
      return '📄';
  }
};

// Convert API file to FileItem
export const apiFileToFileItem = (apiFile: ApiFile): FileItem => {
  const fileName = apiFile.file_name || `${apiFile.file_type}_${apiFile.message_id}`;
  const extension = fileName.split('.').pop();

  return {
    id: apiFile.id,
    file_unique_id: apiFile.file_unique_id,
    name: fileName,
    type: apiFile.file_type === 'folder' ? 'folder' : 'file',
    icon: getFileIcon(apiFile.file_type, fileName),
    extension: extension !== fileName ? extension : undefined,
    size: apiFile.file_size,
    fileType: apiFile.file_type,
    thumbnail: apiFile.thumbnail,
    file_path: apiFile.file_path,
  };
};