import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getApiBaseUrl } from "@/lib/api";
import { FcGoogle } from "react-icons/fc";
import { BackendUrlUpdater } from "@/components/BackendUrlUpdater";

// Declare google.accounts for TypeScript
declare global {
  interface Window {
    google: any;
  }
}

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [showBackendConfig, setShowBackendConfig] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    console.log("Login page mounted");
    
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
    console.log("Google credential response received");
    setIsGoogleLoading(true);
    setError("");

    try {
      const baseUrl = getApiBaseUrl();
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const res = await fetch(`${apiUrl}/auth/google`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ token: response.credential }),
      });

      if (res.ok) {
        // Force a small delay to ensure session is properly set
        await new Promise(resolve => setTimeout(resolve, 100));
        navigate("/");
      } else {
        const errorData = await res.json();
        setError(errorData.detail || "Google authentication failed");
      }
    } catch (err) {
      console.error("Google login error:", err);
      setError("Unable to connect to the backend server. Please check your backend URL configuration.");
      setShowBackendConfig(true);
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const initializeGoogleSignIn = () => {
    if (window.google && window.google.accounts) {
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
    }
  };

  useEffect(() => {
    if (window.google && window.google.accounts) {
      initializeGoogleSignIn();
    } else {
      // Retry initialization after a delay if google script hasn't loaded yet
      const timer = setTimeout(() => {
        if (window.google && window.google.accounts) {
          initializeGoogleSignIn();
        }
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const baseUrl = getApiBaseUrl();
      const apiUrl = baseUrl ? `${baseUrl}/api` : '/api';
      
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        // Force a small delay to ensure session is properly set
        await new Promise(resolve => setTimeout(resolve, 100));
        navigate("/");
      } else {
        const errorData = await response.json();
        setError(errorData.detail || "Login failed");
      }
    } catch (err) {
      console.error("Login error:", err);
      setError("Unable to connect to the backend server. Please check your backend URL configuration.");
      setShowBackendConfig(true);
    } finally {
      setIsLoading(false);
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
                disabled={isGoogleLoading}
              >
                <FcGoogle className="w-6 h-6" />
                <span className="font-medium">
                  {isGoogleLoading ? "Signing in..." : "Continue with Google"}
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

            <form onSubmit={handleLogin} className="space-y-4">
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
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                  className="py-5 px-4 rounded-xl border-gray-300 focus:border-blue-500 focus:ring-blue-500"
                />
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