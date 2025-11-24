// API base URL - will use proxy in development
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

export interface ApiFile {
    id: string;
    chat_id: number;
    message_id: number;
    file_type: 'document' | 'video' | 'photo' | 'voice' | 'audio';
    thumbnail: string | null;
    file_unique_id: string;
    file_size: number;
    file_name: string | null;
    file_caption: string | null;
    file_path: string;  // Path where file is located
}

export interface FilesResponse {
    files: ApiFile[];
}

export const api = {
    async fetchFiles(path: string = '/'): Promise<FilesResponse> {
        const response = await fetch(`${API_BASE_URL}/files?path=${encodeURIComponent(path)}`, {
            credentials: 'include', // Include cookies for session-based auth
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch files: ${response.statusText}`);
        }

        return response.json();
    },

    async checkAuth() {
        const response = await fetch(`${API_BASE_URL}/auth/check`, {
            credentials: 'include',
        });

        if (!response.ok) {
            throw new Error(`Failed to check auth: ${response.statusText}`);
        }

        return response.json();
    },
};