import { Toaster } from "@/components/ui/toaster";
import { useEffect } from "react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import Index from "./pages/Index";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import { resetApiBaseUrl } from "./lib/api";

const queryClient = new QueryClient();

// Debug component to log current route
const RouteDebugger = () => {
  const location = useLocation();
  console.log("Current route:", location.pathname);
  return null;
};

const AppRoutes = () => {
  return (
    <>
      <RouteDebugger />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Index />} />
        {/* Handle dynamic paths for file explorer */}
        <Route path="/:path/*" element={<Index />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
};

const App = () => {
  useEffect(() => {
    // Check system preference
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };

    // Initial check
    handleChange(mediaQuery);

    // Listen for changes
    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    // Add keyboard shortcut to reset API URL
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Alt+R to reset API URL
      if (e.ctrlKey && e.altKey && e.key === 'r') {
        e.preventDefault();
        resetApiBaseUrl();
        alert('API URL has been reset to default. The page will now reload.');
        window.location.reload();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  console.log("App component rendered");

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;