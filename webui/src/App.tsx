import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserRouter,
  createHashRouter,
  RouterProvider,
  Navigate,
  useLocation,
  useNavigate,
  Outlet,
} from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { TitleBar } from "@/components/shell/TitleBar";
import LoadingPage from "./pages/LoadingPage";
import ExplorerPage from "./pages/ExplorerPage";
import { logger } from "./lib/logger.ts";
import { getExplorerSessionState } from "@/pages/explorer/explorerSessionStore";
import {
  getTrackedAuthEventTarget,
  isTrackedAuthEventRelevant,
  rememberTrackedAuthSnapshot,
  resetTrackedAuthEventTarget,
} from "@/lib/authEventTarget";

const LoginPage = lazy(() => import("./pages/LoginPage"));
const NotFound = lazy(() => import("./pages/NotFound"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const WindowTraySettingsPage = lazy(
  () => import("./pages/settings/WindowTraySettingsPage"),
);
const ExplorerSettingsPage = lazy(
  () => import("./pages/settings/ExplorerSettingsPage"),
);
const DownloadsSettingsPage = lazy(
  () => import("./pages/settings/DownloadsSettingsPage"),
);
const NotificationsSettingsPage = lazy(
  () => import("./pages/settings/NotificationsSettingsPage"),
);
const StorageSettingsPage = lazy(
  () => import("./pages/settings/StorageSettingsPage"),
);
const AppearanceSettingsPage = lazy(
  () => import("./pages/settings/AppearanceSettingsPage"),
);
const AdminUsersPage = lazy(
  () => import("./pages/settings/AdminUsersPage"),
);
const AccountSettingsPage = lazy(
  () => import("./pages/settings/AccountSettingsPage"),
);
const AboutSettingsPage = lazy(
  () => import("./pages/settings/AboutSettingsPage"),
);

logger.info("Starting TelegramFileServer");
const queryClient = new QueryClient();
const EXPLICIT_LOGOUT_IN_PROGRESS_KEY = "skybox_explicit_logout_in_progress";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const RouteFallback = () => {
  return (
    <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
      Loading...
    </div>
  );
};

const RouteSuspense = ({ children }: { children: ReactNode }) => {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
};

const SettingsIndexRedirect = () => {
  const location = useLocation();

  return <Navigate to="window" replace state={location.state} />;
};

type AuthStageDto =
  | "Uninitialized"
  | "WaitingTdlibParameters"
  | "WaitingPhoneNumber"
  | "WaitingQrConfirmation"
  | "WaitingCode"
  | "WaitingPassword"
  | "Ready"
  | "LoggingOut"
  | "Closing"
  | "Closed"
  | { Failed: { message: string } };

type AuthSnapshotDto = {
  account_id: string;
  stage: AuthStageDto;
  state?: string;
  runtime_id?: string;
  login_method?: string;
  qr_link?: string;
  qr_observed_at_unix?: number;
  qr_expires_at_unix?: number;
  requires_password?: boolean;
  authorized?: boolean;
  error?: string;
};

const StartupRouteGate = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const didRunRef = useRef(false);

  useLayoutEffect(() => {
    if (didRunRef.current) return;
    didRunRef.current = true;

    // Always show LoadingPage first on startup.
    if (location.pathname !== "/") {
      navigate("/", { replace: true });
    }
  }, [location.pathname, navigate]);

  return null;
};

const AuthStateListener = () => {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let lastRedirectAt = 0;

    const handleLoggedOut = async (reason: string) => {
      if (typeof window !== "undefined") {
        const logoutInProgress = window.sessionStorage.getItem(
          EXPLICIT_LOGOUT_IN_PROGRESS_KEY,
        );
        if (logoutInProgress === "1") {
          logger.info(
            `[React] AuthStateListener: ignoring logged out redirect during explicit logout (${reason})`,
          );
          return;
        }
      }

      const now = Date.now();
      if (now - lastRedirectAt < 1500) {
        return;
      }
      lastRedirectAt = now;

      // Let LoadingPage decide where to go during startup.
      if (location.pathname === "/") {
        return;
      }

      if (location.pathname.startsWith("/login")) {
        return;
      }

      logger.info(
        `[React] AuthStateListener: logged out detected (${reason}); clearing session`,
      );
      try {
        await invoke("db_clear_session");
      } catch (error) {
        logger.warn(
          `[React] AuthStateListener: failed to clear session: ${JSON.stringify(error)}`,
        );
      }

      resetTrackedAuthEventTarget();

      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          "skybox_login_notice",
          JSON.stringify({ type: "logged_out" }),
        );
      }
      navigate("/login");
    };

    listen<AuthSnapshotDto>("auth_state_changed", (event) => {
      const snapshot = event.payload;
      if (!snapshot) {
        return;
      }

      if (!isTrackedAuthEventRelevant(snapshot)) {
        const trackedTarget = getTrackedAuthEventTarget();
        logger.info(
          `[React] AuthStateListener: ignoring auth update for account=${snapshot.account_id} runtime=${snapshot.runtime_id ?? "unknown"} while tracking account=${trackedTarget?.accountId ?? "none"} runtime=${trackedTarget?.runtimeId ?? "unknown"}`,
        );
        return;
      }

      rememberTrackedAuthSnapshot(snapshot);

      const stage = snapshot.stage;
      if (stage === "WaitingPhoneNumber" || stage === "Closed") {
        void handleLoggedOut(String(stage));
        return;
      }
      if (
        typeof stage === "object" &&
        stage &&
        "Failed" in stage &&
        stage.Failed &&
        typeof stage.Failed.message === "string"
      ) {
        void handleLoggedOut(`Failed: ${stage.Failed.message}`);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        logger.warn(
          `[React] AuthStateListener: failed to listen auth_state_changed: ${JSON.stringify(error)}`,
        );
      });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [location.pathname, navigate]);

  return null;
};

const WorkspaceShell = () => {
  const location = useLocation();
  const isExplorerRoute = location.pathname.startsWith("/explorer");
  const isSettingsRoute = location.pathname.startsWith("/settings");
  const [keepExplorerMounted, setKeepExplorerMounted] = useState(
    () => isExplorerRoute || getExplorerSessionState().hasHydratedExplorer,
  );

  useEffect(() => {
    if (isExplorerRoute) {
      setKeepExplorerMounted(true);
    }
  }, [isExplorerRoute]);

  return (
    <div className="relative h-full">
      {keepExplorerMounted ? (
        <div className={isExplorerRoute ? "h-full" : "hidden h-full"}>
          <RouteSuspense>
            <ExplorerPage />
          </RouteSuspense>
        </div>
      ) : null}

      {isSettingsRoute ? <Outlet /> : null}
    </div>
  );
};



const App = () => {
  const router = useMemo(() => {
    const routes = [
      { path: "/", element: <LoadingPage /> },
      {
        path: "/login",
        element: (
          <RouteSuspense>
            <LoginPage />
          </RouteSuspense>
        ),
      },
      {
        element: <WorkspaceShell />,
        children: [
          { path: "explorer", element: <></> },
          { path: "explorer/*", element: <></> },
          {
            path: "settings",
            element: (
              <RouteSuspense>
                <SettingsPage />
              </RouteSuspense>
            ),
            children: [
              { index: true, element: <SettingsIndexRedirect /> },
              {
                path: "window",
                element: (
                  <RouteSuspense>
                    <WindowTraySettingsPage />
                  </RouteSuspense>
                ),
              },
              {
                path: "explorer",
                element: (
                  <RouteSuspense>
                    <ExplorerSettingsPage />
                  </RouteSuspense>
                ),
              },
              {
                path: "downloads",
                element: (
                  <RouteSuspense>
                    <DownloadsSettingsPage />
                  </RouteSuspense>
                ),
              },
              {
                path: "notifications",
                element: (
                  <RouteSuspense>
                    <NotificationsSettingsPage />
                  </RouteSuspense>
                ),
              },
              {
                path: "storage",
                element: (
                  <RouteSuspense>
                    <StorageSettingsPage />
                  </RouteSuspense>
                ),
              },
          {
            path: "appearance",
            element: (
              <RouteSuspense>
                <AppearanceSettingsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "account",
            element: (
              <RouteSuspense>
                <AccountSettingsPage />
              </RouteSuspense>
            ),
          },
          {
            path: "admin",
            element: (
              <RouteSuspense>
                <AdminUsersPage />
              </RouteSuspense>
            ),
          },
          {
            path: "about",
                element: (
                  <RouteSuspense>
                    <AboutSettingsPage />
                  </RouteSuspense>
                ),
              },
            ],
          },
        ],
      },
      {
        path: "*",
        element: (
          <RouteSuspense>
            <NotFound />
          </RouteSuspense>
        ),
      },
    ];
    // Browser serves the app under /webui/ (history routing); Tauri loads it from
    // the origin root with hash routing, so it must not carry the basename.
    return isTauri ? createHashRouter(routes) : createBrowserRouter(routes, { basename: '/webui' });
  }, []);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
