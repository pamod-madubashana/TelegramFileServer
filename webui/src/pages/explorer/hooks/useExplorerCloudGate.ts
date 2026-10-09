import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getBlockingRuntimeError } from "@/lib/telegramRuntime";

type Args = {
  hasAttemptedSessionRestoreRef: MutableRefObject<boolean>;
  initialIsOffline: boolean;
  isOfflineRef: MutableRefObject<boolean>;
  sessionDataRef: MutableRefObject<string | null>;
};

export function useExplorerCloudGate({
  hasAttemptedSessionRestoreRef,
  initialIsOffline,
  isOfflineRef,
  sessionDataRef,
}: Args) {
  const [isOffline, setIsOffline] = useState(initialIsOffline);
  const cloudSyncTimerRef = useRef<number | null>(null);
  const cloudSyncQueuedTimerRef = useRef<number | null>(null);
  const cloudSyncInFlightRef = useRef(false);
  const cloudSyncEnabledRef = useRef(true);
  const cloudSyncDirtyRef = useRef(false);

  useEffect(() => {
    isOfflineRef.current = isOffline;
  }, [isOffline, isOfflineRef]);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const runCloudSyncOnce = useCallback(async (): Promise<boolean> => {
    if (
      !cloudSyncEnabledRef.current ||
      isOfflineRef.current ||
      cloudSyncInFlightRef.current
    ) {
      return false;
    }
    cloudSyncInFlightRef.current = true;
    try {
      await invoke("tg_cloud_sync_skybox_json_to_saved_messages", {
        force: false,
      });
      return true;
    } catch (error) {
      if (getBlockingRuntimeError(error)) {
        cloudSyncEnabledRef.current = false;
      }
      return false;
    } finally {
      cloudSyncInFlightRef.current = false;
    }
  }, [isOfflineRef]);

  const queueCloudSync = useCallback(() => {
    if (!cloudSyncEnabledRef.current) return;
    cloudSyncDirtyRef.current = true;
    if (isOfflineRef.current) return;
    if (cloudSyncQueuedTimerRef.current !== null) {
      window.clearTimeout(cloudSyncQueuedTimerRef.current);
      cloudSyncQueuedTimerRef.current = null;
    }
    cloudSyncQueuedTimerRef.current = window.setTimeout(() => {
      cloudSyncQueuedTimerRef.current = null;
      void runCloudSyncOnce().then((ok) => {
        if (ok) {
          cloudSyncDirtyRef.current = false;
        }
      });
    }, 750);
  }, [isOfflineRef, runCloudSyncOnce]);

  useEffect(() => {
    if (!isOffline && cloudSyncDirtyRef.current) {
      queueCloudSync();
    }
  }, [isOffline, queueCloudSync]);

  useEffect(() => {
    let cancelled = false;

    invoke<string | null>("db_get_setting", { key: "cloud_sync_enabled" })
      .then((value) => {
        if (!cancelled) {
          cloudSyncEnabledRef.current = value !== "0";
        }
      })
      .catch(() => {
        cloudSyncEnabledRef.current = true;
      });

    const tick = async () => {
      try {
        const enabled = await invoke<string | null>("db_get_setting", {
          key: "cloud_sync_enabled",
        });
        cloudSyncEnabledRef.current = enabled !== "0";
      } catch {
        // ignore
      }
      const ok = await runCloudSyncOnce();
      if (ok) {
        cloudSyncDirtyRef.current = false;
      }
    };

    void tick();
    cloudSyncTimerRef.current = window.setInterval(
      () => {
        void tick();
      },
      5 * 60 * 1000,
    );

    return () => {
      cancelled = true;
      if (cloudSyncTimerRef.current !== null) {
        window.clearInterval(cloudSyncTimerRef.current);
        cloudSyncTimerRef.current = null;
      }
      if (cloudSyncQueuedTimerRef.current !== null) {
        window.clearTimeout(cloudSyncQueuedTimerRef.current);
        cloudSyncQueuedTimerRef.current = null;
      }
    };
  }, [runCloudSyncOnce]);

  useEffect(() => {
    if (isOffline) {
      return;
    }
    void invoke("tg_start_real_time_sync").catch((error) => {
      if (getBlockingRuntimeError(error)) {
        cloudSyncEnabledRef.current = false;
      }
    });
    if (hasAttemptedSessionRestoreRef.current) {
      return;
    }
    const sessionData = sessionDataRef.current;
    if (!sessionData) {
      return;
    }
    hasAttemptedSessionRestoreRef.current = true;
    void invoke("tg_restore_session", { sessionData }).catch((error) => {
      if (getBlockingRuntimeError(error)) {
        cloudSyncEnabledRef.current = false;
      }
    });
  }, [hasAttemptedSessionRestoreRef, isOffline, sessionDataRef]);

  const requestStructureBackup = useCallback(() => {
    // Cloud sync runs on an interval; this is kept as a callsite hook.
  }, []);

  return {
    isOffline,
    queueCloudSync,
    requestStructureBackup,
    setIsOffline,
  };
}
