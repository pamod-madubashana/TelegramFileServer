import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import {
  ensureOsNotificationPermission,
  notificationPermission,
} from "@/lib/os-notifications";
import SettingsSectionLayout from "./SettingsSectionLayout";

export default function NotificationsSettingsPage() {
  const [inAppNotificationsEnabled, setInAppNotificationsEnabled] =
    useState(true);
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] =
    useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");

  const saveSetting = useCallback(async (key: string, value: string) => {
    try {
      await invoke("db_set_setting", { key, value });

      window.dispatchEvent(
        new CustomEvent("skybox-notification-setting-changed", {
          detail: { key, value },
        }),
      );
    } catch (error) {
      toast({
        title: "Failed to save setting",
        description:
          typeof error === "object" && error && "message" in error
            ? String((error as { message?: unknown }).message)
            : "An unknown error occurred",
        variant: "destructive",
      });
    }
  }, []);

  useEffect(() => {
    setPermission(notificationPermission());
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<string | null>("db_get_setting", {
        key: "notifications_in_app_enabled",
      }),
      invoke<string | null>("db_get_setting", {
        key: "notifications_os_enabled",
      }),
    ])
      .then(([inApp, os]) => {
        if (cancelled) return;
        if (inApp === "0") setInAppNotificationsEnabled(false);
        if (inApp === "1") setInAppNotificationsEnabled(true);
        // Browser notifications only fire when permission is granted.
        const granted = notificationPermission() === "granted";
        if (!granted) {
          setBrowserNotificationsEnabled(false);
        } else {
          if (os === null) setBrowserNotificationsEnabled(true);
          if (os === "1") setBrowserNotificationsEnabled(true);
          if (os === "0") setBrowserNotificationsEnabled(false);
        }
      })
      .catch(() => {
        // ignore
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBrowserToggle = (checked: boolean) => {
    if (!checked) {
      setBrowserNotificationsEnabled(false);
      void saveSetting("notifications_os_enabled", "0");
      return;
    }
    void (async () => {
      const granted = await ensureOsNotificationPermission();
      setPermission(notificationPermission());
      if (!granted) {
        setBrowserNotificationsEnabled(false);
        toast({
          title: "Browser notifications blocked",
          description:
            "Allow notifications for this site in your browser settings, then try again.",
          variant: "destructive",
        });
        return;
      }
      setBrowserNotificationsEnabled(true);
      void saveSetting("notifications_os_enabled", "1");
    })();
  };

  const permissionHint =
    permission === "unsupported"
      ? "This browser does not support notifications."
      : permission === "denied"
        ? "Notifications are blocked for this site in your browser settings."
        : permission === "granted"
          ? "Browser notifications are allowed for this site."
          : "Your browser will ask for permission when you turn this on.";

  return (
    <SettingsSectionLayout title="Notifications">
      <div className="rounded-xl border border-border bg-glass overflow-hidden">
        <div className="px-4 py-4 border-b border-border">
          <p className="text-body font-semibold text-foreground">
            Notifications
          </p>
          <p className="text-small text-muted-foreground">
            Control what the app surfaces.
          </p>
        </div>

        <div className="px-4 py-4 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-small font-medium text-foreground">
                In-app notifications
              </p>
              <p className="text-small text-muted-foreground truncate">
                Show notifications inside the app.
              </p>
            </div>
            <Switch
              checked={inAppNotificationsEnabled}
              onCheckedChange={(checked) => {
                setInAppNotificationsEnabled(checked);
                void saveSetting(
                  "notifications_in_app_enabled",
                  checked ? "1" : "0",
                );
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-small font-medium text-foreground">
                Browser notifications
              </p>
              <p className="text-small text-muted-foreground truncate">
                Show notifications from this site even when the tab is in the
                background.
              </p>
              <p className="text-small text-muted-foreground truncate mt-1">
                {permissionHint}
              </p>
            </div>
            <Switch
              checked={browserNotificationsEnabled}
              disabled={permission === "unsupported"}
              onCheckedChange={handleBrowserToggle}
            />
          </div>
        </div>
      </div>
    </SettingsSectionLayout>
  );
}
