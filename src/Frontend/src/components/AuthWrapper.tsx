import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { getApiBaseUrl } from "@/lib/api";

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
    console.log("AuthWrapper mounted, checking authentication...");
    
    // Skip auth check on login page
    if (location.pathname === "/login") {
      setIsLoading(false);
      setIsAuthenticated(false);
      return;
    }
    
    const checkAuth = async () => {
      try {
        const baseUrl = getApiBaseUrl();
        const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
        
        console.log("Checking authentication at:", `${apiUrl}/auth/check`);
        
        const response = await fetch(`${apiUrl}/auth/check`, {
          credentials: 'include',
          // Add cache-busting to ensure we get fresh data
          cache: 'no-cache',
          headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          }
        });

        console.log("Auth check response status:", response.status);
        console.log("Auth check response headers:", [...response.headers.entries()]);
        
        if (response.ok) {
          const data = await response.json();
          console.log("Auth check response data:", data);
          setIsAuthenticated(data.authenticated);
          setBackendError(false);
          
          // If not authenticated, redirect to login
          if (!data.authenticated) {
            console.log("Not authenticated, redirecting to login");
            navigate("/login");
            return;
          } else {
            console.log("User is authenticated, showing content");
          }
        } else {
          console.log("Auth check failed with status:", response.status);
          // Redirect to login but indicate there might be a backend issue
          setIsAuthenticated(false);
          setBackendError(response.status !== 401 && response.status !== 403);
          navigate("/login");
          return;
        }
      } catch (error) {
        console.error("Auth check failed with error:", error);
        // Redirect to login and indicate there's a backend connectivity issue
        setIsAuthenticated(false);
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
    console.log("Showing loading state");
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-gray-900 dark:border-gray-100"></div>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Checking authentication...</p>
        </div>
      </div>
    );
  }

  console.log("Rendering children, isAuthenticated:", isAuthenticated);
  // If authenticated, render children; otherwise, redirect handled by useEffect
  return isAuthenticated ? <>{children}</> : null;
};