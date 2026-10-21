import {
  ArrowLeft,
  Bell,
  CircleHelp,
  Download,
  HardDrive,
  Palette,
  User,
  Users,
} from "lucide-react";
import type { ElementType } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  getSettingsPageLabel,
  useReactPageLogger,
} from "@/lib/reactPageLogger";
import { useMe } from "@/lib/auth";
import { type SettingsRouteState } from "@/pages/explorer/explorerSessionStore";

type NavItem = {
  id: string;
  label: string;
  icon: ElementType;
  to: string;
  /** Only shown when the signed-in account has the admin role. */
  adminOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  {
    id: "explorer",
    label: "Explorer",
    icon: HardDrive,
    to: "/settings/explorer",
  },
  {
    id: "downloads",
    label: "Downloads",
    icon: Download,
    to: "/settings/downloads",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    to: "/settings/notifications",
  },
  { id: "storage", label: "Storage", icon: HardDrive, to: "/settings/storage" },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    to: "/settings/appearance",
  },
  {
    id: "account",
    label: "Account",
    icon: User,
    to: "/settings/account",
  },
  {
    id: "admin",
    label: "Users",
    icon: Users,
    to: "/settings/admin",
    adminOnly: true,
  },
  {
    id: "about",
    label: "About",
    icon: CircleHelp,
    to: "/settings/about",
  },
];

export default function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const routeState = (location.state || null) as SettingsRouteState | null;
  const me = useMe();
  const isAdmin = me.data?.role === "admin";

  useReactPageLogger(getSettingsPageLabel(location.pathname));

  const exitSettings = () => {
    if (routeState?.fromExplorer) {
      navigate(-1);
      return;
    }

    navigate(routeState?.returnTo || "/explorer", { replace: true });
  };

  return (
    <div className="relative h-full flex overflow-hidden">
      <div className="w-64 h-full glass-sidebar flex flex-col relative overflow-hidden">
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            type="button"
            onClick={exitSettings}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full text-left text-foreground hover:bg-sidebar-accent/50"
          >
            <ArrowLeft className="w-5 h-5" />
            <span className="text-body font-medium">Back to files</span>
          </button>

          <div className="px-2 py-1.5">
            <span className="text-small text-muted-foreground uppercase tracking-wider">
              Sections
            </span>
          </div>

          {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map(
            (item) => {
              const Icon = item.icon;
              const active =
                location.pathname === item.to ||
                location.pathname.startsWith(`${item.to}/`);

              return (
                <NavLink
                  key={item.id}
                  to={item.to}
                  replace
                  state={routeState}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 w-full text-left ${
                    active
                      ? "bg-sidebar-accent text-primary font-medium"
                      : "text-foreground hover:bg-sidebar-accent/50"
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  <span className="text-body font-medium">{item.label}</span>
                </NavLink>
              );
            },
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 bg-glass-dark">
        <Outlet />
      </div>
    </div>
  );
}
