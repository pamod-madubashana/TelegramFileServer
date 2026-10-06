import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import appStartIcon from "@/assets/images/icon.png";
import { logger } from "../lib/logger";
import { type MeResponse } from "@/lib/auth";

export default function LoadingPage() {
  const navigate = useNavigate();
  const [appVersion, setAppVersion] = useState<string>("...");
  const [blockingRuntimeError, setBlockingRuntimeError] = useState<null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadAppVersion = async () => {
      try {
        const version = await getVersion();
        if (!cancelled) {
          setAppVersion(version);
        }
      } catch (error) {
        logger.warn(
          `LoadingPage: Failed to read app version: ${JSON.stringify(error)}`,
        );
        if (!cancelled) {
          setAppVersion("unknown");
        }
      }
    };

    const checkLoginStatus = async () => {
      if (cancelled) return;

      // TFS: not configured → setup wizard
      try {
        const r = await fetch("/api/setup/resume");
        if (r.ok) {
          const d = await r.json();
          if (d.saved === false || d.configured === false) {
            window.location.href = "/";
            return;
          }
        }
      } catch {
        /* keep going — server may still be booting */
      }

      const token = localStorage.getItem("tfs_token");

      if (token) {
        try {
          const response = await fetch("/api/auth/me", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          if (response.ok) {
            const data: MeResponse = await response.json();
            logger.info("LoadingPage: Token valid, navigating to explorer", {
              username: data.username,
              role: data.role,
            });
            if (!cancelled) {
              navigate("/explorer", { replace: true });
            }
            return;
          }

          // require_session maps a missing/expired token to 400 (and a
          // deleted account to 403) — clear the stale token in all of them.
          if (
            response.status === 400 ||
            response.status === 401 ||
            response.status === 403
          ) {
            logger.info("LoadingPage: Token invalid/expired, clearing and redirecting to login");
            localStorage.removeItem("tfs_token");
          } else {
            logger.warn(`LoadingPage: /api/auth/me returned ${response.status}`);
          }
        } catch (error) {
          logger.warn("LoadingPage: Network error checking token, redirecting to login", error);
        }
      }

      // No token or token invalid → login page
      if (!cancelled) {
        navigate("/login", { replace: true });
      }
    };

    void loadAppVersion();
    void checkLoginStatus();

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="h-full bg-background flex flex-col">
      <div
        className="h-[var(--titlebar-height)] shrink-0"
        onMouseDown={(event) => {
          if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
          if (event.button !== 0) return;
          if (event.detail !== 1) return;
          // Tauri window dragging would be handled by the TitleBar component
        }}
        role="presentation"
      >
        <div className="h-full w-full" />
      </div>

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="flex flex-col items-center max-w-md w-full text-center">
          <div className="w-32 h-32 mb-8 flex items-center justify-center animate-pulse">
            <img
              src={appStartIcon}
              alt="TelegramFileServer"
              className="w-full h-full object-contain"
            />
          </div>

          <h1 className="text-2xl font-bold text-foreground mb-2">
            TelegramFileServer
          </h1>

          <p className="text-body text-muted-foreground text-center">
            Loading...
          </p>
        </div>
      </div>

      <div className="p-4 text-center">
        <p className="text-small text-muted-foreground">TelegramFileServer {appVersion}</p>
      </div>
    </div>
  );
}