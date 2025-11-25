import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Settings } from "lucide-react";
import { getApiBaseUrl, resetApiBaseUrl } from "@/lib/api";

export const SettingsWidget = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [tempServerUrl, setTempServerUrl] = useState("");
  const [error, setError] = useState("");

  // Load server URL from localStorage on component mount
  useEffect(() => {
    const currentUrl = getApiBaseUrl();
    // If the current URL is the default "/api", construct the full URL assuming backend is on port 8000
    let displayUrl = currentUrl;
    if (currentUrl === "/api") {
      // Construct full URL based on current origin but with port 8000
      const url = new URL(window.location.origin);
      url.port = "8000";
      displayUrl = url.origin; // Changed from `${url.origin}/api` to just `url.origin`
    }
    setServerUrl(displayUrl);
    setTempServerUrl(displayUrl);
  }, []);

  const validateUrl = (url: string): boolean => {
    if (!url) return false;
    try {
      // Allow "/" as a special case for same-origin requests
      if (url === "/") return true;
      
      // For full URLs, validate the format
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  const handleSave = () => {
    // Validate the URL before saving
    if (!validateUrl(tempServerUrl)) {
      setError("Please enter a valid URL (e.g., http://localhost:8000)");
      return;
    }

    // Clear any previous error
    setError("");

    // Save to localStorage
    // If the user entered the full URL that matches the default backend URL, save as "/"
    const defaultBackendUrl = (() => {
      const url = new URL(window.location.origin);
      url.port = "8000";
      return url.origin; // Changed from `${url.origin}/api` to just `url.origin`
    })();
    
    if (tempServerUrl === defaultBackendUrl) {
      resetApiBaseUrl(); // This removes the saved URL, reverting to default
    } else if (tempServerUrl !== "/") {
      localStorage.setItem("serverUrl", tempServerUrl);
    } else {
      resetApiBaseUrl(); // This removes the saved URL, reverting to default
    }
    
    setServerUrl(tempServerUrl);
    setIsOpen(false);
    
    // Show a success message or trigger a refresh if needed
    window.location.reload();
  };

  const handleReset = () => {
    // Reset to the default full URL (port 8000)
    const url = new URL(window.location.origin);
    url.port = "8000";
    const defaultUrl = url.origin; // Changed from `${url.origin}/api` to just `url.origin`
    setTempServerUrl(defaultUrl);
    setError(""); // Clear any error when resetting
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Card className="rounded-lg border bg-card text-card-foreground shadow-sm">
          <CardHeader>
            <CardTitle>Server Configuration</CardTitle>
            <CardDescription>
              Configure the backend server URL for API connections
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="server-url">Backend Server URL</Label>
              <Input
                id="server-url"
                value={tempServerUrl}
                onChange={(e) => {
                  setTempServerUrl(e.target.value);
                  if (error) setError(""); // Clear error when user types
                }}
                placeholder="https://your-server.com"
              />
              {error && <p className="text-sm text-red-500">{error}</p>}
              <p className="text-sm text-muted-foreground">
                Enter the full URL to your backend server. Current default is {((): string => {
                  const url = new URL(window.location.origin);
                  url.port = "8000";
                  return url.origin; // Changed from `${url.origin}/api` to just `url.origin`
                })()}
              </p>
              <p className="text-sm text-muted-foreground">
                Tip: Press Ctrl+Alt+R anywhere to reset to default settings
              </p>
            </div>
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button variant="outline" onClick={handleReset}>
              Reset to Default
            </Button>
            <Button onClick={handleSave}>Save Changes</Button>
          </CardFooter>
        </Card>
      </DialogContent>
    </Dialog>
  );
};