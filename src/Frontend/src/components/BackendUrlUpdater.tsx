import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { updateApiBaseUrl, getApiBaseUrl } from "@/lib/api";

interface BackendUrlUpdaterProps {
  onErrorUpdate?: (error: string) => void;
  onSuccess?: () => void;
}

export const BackendUrlUpdater = ({ onErrorUpdate, onSuccess }: BackendUrlUpdaterProps) => {
  const [backendUrl, setBackendUrl] = useState(getApiBaseUrl());
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setBackendUrl(e.target.value);
    setTestResult(null);
  };

  const handleSave = () => {
    try {
      updateApiBaseUrl(backendUrl);
      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      if (onErrorUpdate) {
        onErrorUpdate("Failed to save backend URL");
      }
    }
  };

  const handleTestConnection = async () => {
    if (!backendUrl) {
      setTestResult({ success: false, message: "Please enter a backend URL" });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      // Test connection to the backend
      const testUrl = backendUrl.endsWith('/api') ? `${backendUrl}/health` : `${backendUrl}/api/health`;
      
      // Try to fetch a health endpoint or fallback to a simple OPTIONS request
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      
      const response = await fetch(testUrl, {
        method: 'OPTIONS',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok || response.status === 405) {
        // 405 (Method Not Allowed) is acceptable as it means the endpoint exists
        setTestResult({ success: true, message: "Connection successful!" });
      } else {
        setTestResult({ success: false, message: `Server responded with status ${response.status}` });
      }
    } catch (error) {
    //   clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          setTestResult({ success: false, message: "Connection timed out" });
        } else {
          setTestResult({ success: false, message: `Connection failed: ${error.message}` });
        }
      } else {
        setTestResult({ success: false, message: "Connection failed" });
      }
    } finally {
      setIsTesting(false);
    }
  };

  const handleReset = () => {
    setBackendUrl("");
    updateApiBaseUrl("");
    setTestResult(null);
    if (onSuccess) {
      onSuccess();
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Backend Configuration</CardTitle>
        <CardDescription>
          Configure the backend server URL for authentication
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="backendUrl">Backend URL</Label>
          <Input
            id="backendUrl"
            placeholder="http://localhost:8000"
            value={backendUrl}
            onChange={handleUrlChange}
          />
        </div>
        
        <div className="flex gap-2">
          <Button 
            onClick={handleTestConnection} 
            disabled={isTesting}
            variant="outline"
            size="sm"
          >
            {isTesting ? "Testing..." : "Test Connection"}
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={!backendUrl}
            size="sm"
          >
            Save
          </Button>
          <Button 
            onClick={handleReset} 
            variant="ghost"
            size="sm"
          >
            Reset
          </Button>
        </div>
        
        {testResult && (
          <div className={`p-2 rounded text-sm ${
            testResult.success 
              ? "bg-green-100 text-green-800" 
              : "bg-red-100 text-red-800"
          }`}>
            {testResult.message}
          </div>
        )}
        
        <div className="text-xs text-gray-500 mt-2">
          <p>Enter the full URL to your backend server (e.g., http://localhost:8000)</p>
        </div>
      </CardContent>
    </Card>
  );
};