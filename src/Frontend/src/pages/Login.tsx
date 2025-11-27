import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getApiBaseUrl, fetchWithTimeout } from "@/lib/api";
import { FcGoogle } from "react-icons/fc";
import { BackendUrlUpdater } from "@/components/BackendUrlUpdater";

// Declare google.accounts for TypeScript
declare global {
  interface Window {
    google: any;
  }
}

// Function to send logs to backend
const sendLogToBackend = async (message: string, data?: any) => {
  try {
    // Check if we're in Tauri environment
    const isTauri = !!(window as any).__TAURI__;
    if (isTauri) {
      // In Tauri, we could use the event system to send logs to the backend
      // For now, we'll just console.log since that's what we can see
      console.log(`[FRONTEND LOG] ${message}`, data);
    } else {
      console.log(`[FRONTEND LOG] ${message}`, data);
    }
  } catch (error) {
    console.error("Error sending log to backend:", error);
  }
};

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showBackendConfig, setShowBackendConfig] = useState(false);
  const navigate = useNavigate();
  
  sendLogToBackend("Login component initialized");

  useEffect(() => {
    sendLogToBackend("Login page mounted");
    
    // Dynamically load Google Identity Services script
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, []);

  const handleCredentialResponse = async (response: any) => {
    sendLogToBackend("Google credential response received", response);
    setIsLoading(true);
    setError("");

    try {
      const baseUrl = getApiBaseUrl();
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      sendLogToBackend("Attempting Google login with baseUrl", { baseUrl, apiUrl: `${apiUrl}/auth/google` });
      
      const res = await fetchWithTimeout(`${apiUrl}/auth/google`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ token: response.credential }),
      }, 5000);

      sendLogToBackend("Google login response", { status: res.status, headers: [...res.headers.entries()] });
      
      if (res.ok) {
        const responseData = await res.json();
        sendLogToBackend("Google login successful", responseData);
        // Force a small delay to ensure session is properly set
        await new Promise(resolve => setTimeout(resolve, 100));
        navigate("/");
      } else {
        const errorData = await res.json();
        sendLogToBackend("Google login failed", errorData);
        setError(errorData.detail || "Google authentication failed");
      }
    } catch (err) {
      sendLogToBackend("Google login error", err);
      setError("Unable to connect to the backend server. Please check your backend URL configuration.");
      setShowBackendConfig(true);
    } finally {
      setIsLoading(false);
    }
  };

  const initializeGoogleSignIn = () => {
    if (window.google && window.google.accounts) {
      sendLogToBackend("Initializing Google Sign-In");
      window.google.accounts.id.initialize({
        client_id: "YOUR_GOOGLE_CLIENT_ID_HERE", // This should be replaced with actual client ID
        callback: handleCredentialResponse,
      });
      
      window.google.accounts.id.renderButton(
        document.getElementById("googleSignInButton"),
        { 
          theme: "outline", 
          size: "large",
          width: 250,
          text: "signin_with"
        }
      );
    } else {
      sendLogToBackend("Google accounts not available yet");
    }
  };

  useEffect(() => {
    sendLogToBackend("Checking for Google accounts availability");
    if (window.google && window.google.accounts) {
      sendLogToBackend("Google accounts available, initializing");
      initializeGoogleSignIn();
    } else {
      // Retry initialization after a delay if google script hasn't loaded yet
      sendLogToBackend("Google accounts not available, scheduling retry");
      const timer = setTimeout(() => {
        if (window.google && window.google.accounts) {
          sendLogToBackend("Google accounts available on retry, initializing");
          initializeGoogleSignIn();
        } else {
          sendLogToBackend("Google accounts still not available after retry");
        }
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    sendLogToBackend("Login form submitted", { username, password });
    
    setIsLoading(true);
    setError("");

    try {
      const baseUrl = getApiBaseUrl();
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      sendLogToBackend("Attempting login with baseUrl", { baseUrl, apiUrl: `${apiUrl}/auth/login` });
      
      // Check if we're running in Tauri
      const isTauri = !!(window as any).__TAURI__;
      sendLogToBackend("Running in Tauri environment", isTauri);
      
      // Prepare fetch options
      const fetchOptions: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      };
      
      const response = await fetchWithTimeout(`${apiUrl}/auth/login`, fetchOptions, 5000);

      sendLogToBackend("Login response", { status: response.status, headers: [...response.headers.entries()] });
      
      if (response.ok) {
        const responseData = await response.json();
        sendLogToBackend("Login response data", responseData);
        
        // For Tauri, we might need to manually handle cookies
        if (isTauri) {
          sendLogToBackend("In Tauri environment, storing auth state locally");
          localStorage.setItem('tauri_auth_token', JSON.stringify({ 
            authenticated: true, 
            username: responseData.username,
            auth_token: responseData.auth_token,
            timestamp: new Date().toISOString()
          }));
        }
        
        // Force a small delay to ensure session is properly set
        await new Promise(resolve => setTimeout(resolve, 100));
        sendLogToBackend("Navigating to home page after successful login");
        navigate("/");
      } else {
        const errorData = await response.json();
        sendLogToBackend("Login failed with error", errorData);
        setError(errorData.detail || "Login failed");
      }
    } catch (err) {
      sendLogToBackend("Login error", err);
      setError("Unable to connect to the backend server. Please check your backend URL configuration.");
      setShowBackendConfig(true);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    sendLogToBackend("Google login initiated");
    
    if (window.google && window.google.accounts) {
      window.google.accounts.id.prompt();
    }
  };

  const handleBackendConfigSuccess = () => {
    setShowBackendConfig(false);
    setError("");
    // Refresh the page to apply the new backend URL
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-500 to-purple-600 p-4">
      {!showBackendConfig ? (
        <Card className="w-full max-w-md shadow-2xl rounded-3xl border-0 bg-white/90 backdrop-blur-xl">
          <CardHeader className="space-y-1 text-center pt-8 pb-2">
            <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
              <div className="w-10 h-10 bg-white rounded-lg"></div>
            </div>
            <CardTitle className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              File Server
            </CardTitle>
            <CardDescription className="text-gray-600">
              Sign in to access your files
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 px-8 py-6">
            {error && (
              <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm">
                {error}
                {error.includes("Unable to connect") && (
                  <button 
                    onClick={() => setShowBackendConfig(true)}
                    className="ml-2 underline text-red-800 hover:text-red-900"
                  >
                    Configure Backend URL
                  </button>
                )}
              </div>
            )}
            
            <div className="space-y-4">
              <Button 
                id="googleSignInButton"
                variant="ghost" 
                className="w-full py-6 flex items-center justify-center gap-3 hover:bg-transparent hover:shadow-none"
                disabled={isLoading}
              >
                <FcGoogle className="w-6 h-6" />
                <span className="font-medium">
                  {isLoading ? "Signing in..." : "Continue with Google"}
                </span>
              </Button>
              
              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-300"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-white px-3 text-gray-500">
                    or
                  </span>
                </div>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-gray-700">Username</Label>
                <Input
                  id="username"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={isLoading}
                  className="py-5 px-4 rounded-xl border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-gray-700">Password</Label>
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                  className="py-5 px-4 rounded-xl border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                />
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-sm text-gray-600 hover:text-gray-800"
                  >
                    {showPassword ? "Hide" : "Show"} Password
                  </button>
                </div>
              </div>
              <Button 
                type="submit" 
                className="w-full py-5 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-medium shadow-lg hover:shadow-xl transition-all duration-200"
                disabled={isLoading}
              >
                {isLoading ? "Signing in..." : "Sign In"}
              </Button>
            </form>
            
            <div className="text-center">
              <button 
                onClick={() => setShowBackendConfig(true)}
                className="text-sm text-gray-600 hover:text-gray-800 underline"
              >
                Configure Backend URL
              </button>
            </div>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4 pb-8">
            <p className="text-xs text-center text-gray-500">
              Protected file server access
            </p>
          </CardFooter>
        </Card>
      ) : (
        <div className="w-full max-w-md">
          <BackendUrlUpdater 
            onSuccess={handleBackendConfigSuccess}
            onErrorUpdate={(errorMsg) => setError(errorMsg)}
          />
          <div className="mt-4 text-center">
            <button 
              onClick={() => setShowBackendConfig(false)}
              className="text-sm text-gray-600 hover:text-gray-800 underline"
            >
              Back to Login
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Login;