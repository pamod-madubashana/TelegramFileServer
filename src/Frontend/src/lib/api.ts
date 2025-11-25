// API base URL - will use proxy in development
const getDefaultApiUrl = () => {
  const savedUrl = localStorage.getItem("serverUrl");
  if (savedUrl) {
    return savedUrl;
  }
  return import.meta.env.VITE_API_URL || '/api';
};

const API_BASE_URL = getDefaultApiUrl();

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

const SERVER_URL_KEY = "serverUrl";

// Function to get the API base URL
export const getApiBaseUrl = (): string => {
  // Check if there's a custom server URL in localStorage
  const customUrl = localStorage.getItem(SERVER_URL_KEY);
  if (customUrl) {
    return customUrl;
  }
  
  // Return default URL (port 8000)
  if (typeof window !== 'undefined') {
    // Assume backend is on port 8000
    const url = new URL(window.location.origin);
    url.port = "8000";
    return url.origin;
  }
  
  return import.meta.env.VITE_API_URL || '';
};

// Function to update the API base URL
export const updateApiBaseUrl = (url: string) => {
  if (url) {
    localStorage.setItem(SERVER_URL_KEY, url);
  } else {
    localStorage.removeItem(SERVER_URL_KEY);
  }
};

// Function to reset API base URL to default
export const resetApiBaseUrl = () => {
  localStorage.removeItem(SERVER_URL_KEY);
};

// Function to construct full API URLs
export const getFullApiUrl = (endpoint: string): string => {
  const baseUrl = getApiBaseUrl();
  
  // If we have a custom base URL, append the endpoint
  if (baseUrl) {
    // Ensure the endpoint starts with a slash
    const formattedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${baseUrl}${formattedEndpoint}`;
  }
  
  // For same-origin requests, prepend /api to the endpoint
  const apiEndpoint = endpoint.startsWith('/api') ? endpoint : `/api${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  return apiEndpoint;
};

export const api = {
    async fetchFiles(path: string = '/'): Promise<FilesResponse> {
        const baseUrl = getApiBaseUrl();
        // For the default case, we need to append /api to the base URL
        const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
        const response = await fetch(`${apiUrl}/files?path=${encodeURIComponent(path)}`, {
            credentials: 'include', // Include cookies for session-based auth
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch files: ${response.statusText}`);
        }

        return response.json();
    },

    async checkAuth() {
        const baseUrl = getApiBaseUrl();
        // For the default case, we need to append /api to the base URL
        const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
        const response = await fetch(`${apiUrl}/auth/check`, {
            credentials: 'include',
        });

        if (!response.ok) {
            throw new Error(`Failed to check auth: ${response.statusText}`);
        }

        return response.json();
    },
};