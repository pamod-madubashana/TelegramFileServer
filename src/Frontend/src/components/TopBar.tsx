import { ChevronLeft, ChevronRight, ChevronDown, Search, Grid3x3, List, MoreHorizontal } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { SettingsWidget } from "./SettingsWidget";

interface TopBarProps {
  currentPath: string[];
  searchQuery: string;
  viewMode: "grid" | "list";
  onSearchChange: (query: string) => void;
  onViewModeChange: (mode: "grid" | "list") => void;
  onBack: () => void;
  onBreadcrumbClick: (index: number) => void;
  onPaste?: () => void;
}

export const TopBar = ({
  currentPath,
  searchQuery,
  viewMode,
  onSearchChange,
  onViewModeChange,
  onBack,
  onBreadcrumbClick,
  onPaste,
}: TopBarProps) => {
  return (
    <div className="bg-background border-b border-border">
      <div className="flex items-center gap-2 px-4 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            disabled={currentPath.length <= 1}
            className="h-8 w-8"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" disabled className="h-8 w-8">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1 flex-1 bg-muted rounded px-3 py-1.5 text-sm">
          {currentPath.map((folder, index) => (
            <div key={index} className="flex items-center gap-1">
              <button
                onClick={() => onBreadcrumbClick(index)}
                className="hover:text-primary transition-colors"
              >
                {folder}
              </button>
              {index < currentPath.length - 1 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
          ))}
        </div>

        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={`Search ${currentPath[currentPath.length - 1]}`}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10 h-9 bg-muted border-0"
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-border">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8 text-xs">
            <span>New</span>
            <ChevronDown className="ml-1 h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs">
            <span>Sort</span>
            <ChevronDown className="ml-1 h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs">
            <span>View</span>
            <ChevronDown className="ml-1 h-3 w-3" />
          </Button>
          {onPaste && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-8 text-xs"
              onClick={onPaste}
            >
              Paste
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <SettingsWidget />
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => onViewModeChange("grid")}
            className="h-8 w-8"
          >
            <Grid3x3 className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => onViewModeChange("list")}
            className="h-8 w-8"
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};