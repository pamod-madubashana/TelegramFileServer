/**
 * Browser (web) notifications. The desktop Tauri OS-notification bridge is
 * gone; every notification the app surfaces outside the in-app bell is a
 * standard `Notification` on the origin.
 */

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Current browser permission (`"unsupported"` when the API is absent). */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) {
    return "unsupported";
  }
  return Notification.permission;
}

/**
 * Ask the browser for permission (no-op when already granted/denied).
 * Resolves `true` when notifications may be shown.
 */
export async function ensureOsNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) {
    return false;
  }
  if (Notification.permission === "granted") {
    return true;
  }
  if (Notification.permission === "denied") {
    return false;
  }
  try {
    const result = await Notification.requestPermission();
    return result === "granted";
  } catch {
    return false;
  }
}

/** Fire a browser notification. Silently drops when permission is missing. */
export async function showOsNotification(args: {
  title: string;
  body?: string;
}): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== "granted") {
    return;
  }
  try {
    const title = args.title.trim();
    if (!title) {
      return;
    }
    new Notification(title, {
      body: typeof args.body === "string" ? args.body : undefined,
    });
  } catch (error) {
    console.warn(
      "[os-notification] failed:",
      (error as { message?: unknown })?.message || error,
    );
  }
}
