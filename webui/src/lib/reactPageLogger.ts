import { useEffect, useRef } from "react";
import { logger } from "@/lib/logger";
import { virtualToSavedPath } from "@/pages/explorer/shared";

const normalizePageKey = (value: string): string =>
  value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/")
    .toLowerCase();

export const getLoginPageLabel = (
  loginMode: "qr" | "phone",
  step: "phone" | "otp" | "password" | "qr",
): string => {
  if (step === "password") {
    return "login: password";
  }

  if (step === "otp") {
    return "login: phone code";
  }

  if (loginMode === "phone") {
    return "login: phone";
  }

  return "login: qr";
};

export const getExplorerPageLabel = (currentPath: string): string => {
  if (currentPath.startsWith("tg://saved")) {
    const savedPath = normalizePageKey(virtualToSavedPath(currentPath));
    return `explorer: ${savedPath || "home"}`;
  }

  const normalizedPath = normalizePageKey(
    currentPath.replace(/^tg:\/\//, "").replace(/^\/+/, ""),
  );

  return `explorer: ${normalizedPath || "home"}`;
};

export const getSettingsPageLabel = (pathname: string): string | null => {
  const normalizedPath = normalizePageKey(pathname);
  const [, section] = normalizedPath.split("/");

  if (!section) {
    return null;
  }

  const sectionLabel = section.replace(/-/g, " ");

  return `settings: ${sectionLabel}`;
};

export const useReactPageLogger = (pageLabel: string | null) => {
  const lastLoggedPageRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pageLabel) {
      lastLoggedPageRef.current = null;
      return;
    }

    if (lastLoggedPageRef.current === pageLabel) {
      return;
    }

    lastLoggedPageRef.current = pageLabel;
    logger.info(`[React] current page: ${pageLabel}`);
  }, [pageLabel]);
};
