import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { getApiBaseUrl } from "@/lib/api";

// Function to send logs to backend
const sendLogToBackend = async (message: string, data?: any) => {
  try {
    // Check if we're in Tauri environment
    const isTauri = !!(window as any).__TAURI__;
    if (isTauri) {
      // In Tauri, we could use the event system to send logs to the backend
      // For now, we'll just console.log since that's what we can see
      console.log(`[FRONTEND AUTH LOG] ${message}`, data);
    } else {
      console.log(`[FRONTEND AUTH LOG] ${message}`, data);
    }
  } catch (error) {
    console.error("Error sending log to backend:", error);
  }
};

interface AuthWrapperProps {
  children: React.ReactNode;
}

export const AuthWrapper = ({ children }: AuthWrapperProps) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [backendError, setBackendError] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    sendLogToBackend("AuthWrapper mounted, checking authentication...");
    
    // Skip auth check on login page
    if (location.pathname === "/login") {
      sendLogToBackend("On login page, skipping auth check");
      setIsLoading(false);
      setIsAuthenticated(false);
      return;
    }
    
    const checkAuth = async () => {
      // Check if we're running in Tauri
      const isTauri = !!(window as any).__TAURI__;
      sendLogToBackend("Running in Tauri environment", isTauri);
      
      try {
        
        // In Tauri, first check localStorage for auth token
        if (isTauri) {
          const tauri_auth = localStorage.getItem('tauri_auth_token');
          if (tauri_auth) {
            try {
              const authData = JSON.parse(tauri_auth);
              if (authData.authenticated) {
                sendLogToBackend("Found valid auth token in Tauri localStorage", authData);
                setIsAuthenticated(true);
                setBackendError(false);
                setIsLoading(false);
                return;
              }
            } catch (e) {
              sendLogToBackend("Failed to parse Tauri auth token", e);
            }
          }
        }
        
        const baseUrl = getApiBaseUrl();
        const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
        
        sendLogToBackend("Checking authentication", { url: `${apiUrl}/auth/check`, baseUrl });
        
        // Prepare fetch options
        const fetchOptions: RequestInit = {
          method: 'GET',
          credentials: 'include',
          cache: 'no-cache',
        };
        
        // Add auth token for Tauri environment
        if (isTauri) {
          const tauri_auth = localStorage.getItem('tauri_auth_token');
          if (tauri_auth) {
            try {
              const authData = JSON.parse(tauri_auth);
              if (authData.auth_token) {
                fetchOptions.headers = {
                  ...fetchOptions.headers,
                  'X-Auth-Token': authData.auth_token
                };
                sendLogToBackend("Adding auth token to request headers");
              }
            } catch (e) {
              sendLogToBackend("Failed to extract auth token from localStorage", e);
            }
          }
        }
        
        const response = await fetchWithTimeout(`${apiUrl}/auth/check`, fetchOptions, 3000);

        sendLogToBackend("Auth check response", { status: response.status, headers: [...response.headers.entries()] });
        
        if (response.ok) {
          const data = await response.json();
          sendLogToBackend("Auth check response data", data);
          setIsAuthenticated(data.authenticated);
          setBackendError(false);
          
          // If not authenticated, redirect to login
          if (!data.authenticated) {
            sendLogToBackend("Not authenticated, redirecting to login");
            // Clear Tauri auth token if it exists
            if (isTauri) {
              localStorage.removeItem('tauri_auth_token');
            }
            navigate("/login");
            return;
          } else {
            sendLogToBackend("User is authenticated, showing content");
            // Update Tauri auth token
            if (isTauri) {
              localStorage.setItem('tauri_auth_token', JSON.stringify({ 
                authenticated: true, 
                username: data.username,
                auth_token: data.auth_token || null, // Include auth token if available
                timestamp: new Date().toISOString()
              }));
            }
          }
        } else {
          sendLogToBackend("Auth check failed with status", response.status);
          // Redirect to login but indicate there might be a backend issue
          setIsAuthenticated(false);
          // Clear Tauri auth token on failure
          if (isTauri) {
            localStorage.removeItem('tauri_auth_token');
          }
          setBackendError(response.status !== 401 && response.status !== 403);
          navigate("/login");
          return;
        }
      } catch (error) {
        // Check if we're running in Tauri
        const isTauri = !!(window as any).__TAURI__;
        sendLogToBackend("Auth check failed with error", error);
        // Redirect to login and indicate there's a backend connectivity issue
        setIsAuthenticated(false);
        // Clear Tauri auth token on error
        if (isTauri) {
          localStorage.removeItem('tauri_auth_token');
        }
        setBackendError(true);
        navigate("/login");
        return;
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, [navigate, location.pathname]);

  // Show loading state while checking authentication
  if (isLoading || isAuthenticated === null) {
    sendLogToBackend("Showing loading state");
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-gray-900 dark:border-gray-100"></div>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Checking authentication...</p>
        </div>
      </div>
    );
  }

  sendLogToBackend("Rendering children", { isAuthenticated });
  // If authenticated, render children; otherwise, redirect handled by useEffect
  return isAuthenticated ? <>{children}</> : null;
};