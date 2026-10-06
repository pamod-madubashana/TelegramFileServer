import { useQuery } from "@tanstack/react-query";

export interface Permissions {
  read: boolean;
  write: boolean;
}

/** GET /api/auth/me payload — role + permissions for the signed-in account. */
export interface MeResponse {
  username: string;
  role: string;
  permissions: Permissions;
  telegram_username: string | null;
  telegram_user_id: number | null;
}

/** GET /api/auth/status payload — registration mode for the login screen. */
export interface AuthStatusResponse {
  needs_registration: boolean;
  registration: "owner" | "invite";
}

/** Admin-facing user view (mirrors the backend `UserSummary`). */
export interface UserSummary {
  username: string;
  role: string;
  permissions: Permissions;
  telegram_username: string | null;
  telegram_user_id: number | null;
  claimed: boolean;
  is_owner: boolean;
  created_at: string;
  created_by: string | null;
}

/** API error carrying the HTTP status and the server's user-facing message. */
export class ApiHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

export const getAuthToken = (): string | null =>
  localStorage.getItem("tfs_token");

export const setAuthToken = (token: string): void =>
  localStorage.setItem("tfs_token", token);

export const clearAuthToken = (): void =>
  localStorage.removeItem("tfs_token");

const authHeader = (): Record<string, string> => {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

async function toApiError(response: Response): Promise<ApiHttpError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body && typeof body.error === "string" && body.error) {
      message = body.error;
    }
  } catch {
    /* non-JSON body — keep the HTTP fallback */
  }
  return new ApiHttpError(response.status, message);
}

/**
 * Fetch wrapper: attaches the Bearer token, parses `{error}` bodies into
 * `ApiHttpError` (status + user-facing message from the backend).
 * `apiJson` additionally parses JSON — except 204 responses.
 */
export async function apiSend(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...authHeader() };
  if (typeof init.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  const merged: Record<string, string> = {
    ...headers,
    ...(init.headers as Record<string, string> | undefined),
  };
  const response = await fetch(path, { ...init, headers: merged });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response;
}

export async function apiJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await apiSend(path, init);
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** GET /api/auth/status — registration mode for the login screen. */
export const fetchAuthStatus = (): Promise<AuthStatusResponse> =>
  apiJson<AuthStatusResponse>("/api/auth/status");

/** GET /api/auth/me — current session profile (role + permissions). */
export const fetchMe = (): Promise<MeResponse> =>
  apiJson<MeResponse>("/api/auth/me");

/**
 * True when an error from `/api/auth/me` means "no usable session"
 * (missing/expired token or a deleted account) rather than a transient
 * server failure. Note: `require_session` maps invalid tokens to 400.
 */
export const isDeadSessionError = (error: unknown): boolean =>
  error instanceof ApiHttpError &&
  (error.status === 400 || error.status === 401 || error.status === 403);

/**
 * Profile for the signed-in account; `null` when signed out.
 * Session-shaped failures clear the stored token and resolve to `null`;
 * transient errors are thrown for the UI to surface.
 */
export function useMe() {
  return useQuery<MeResponse | null>({
    queryKey: ["me"],
    queryFn: async () => {
      if (!getAuthToken()) return null;
      try {
        return await fetchMe();
      } catch (error) {
        if (isDeadSessionError(error)) {
          clearAuthToken();
          return null;
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 30_000,
  });
}
