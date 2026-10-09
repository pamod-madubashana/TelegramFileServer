/** Setup wizard API — mirrors /api/setup/*. No session, no Bearer token. */

export interface SetupConnection {
  mongo_uri: string;
  password: string;
}

/**
 * GET /api/setup/resume — untagged union matching the backend contract:
 * not saved / configured / saved-but-not-configured / stale (password
 * mismatch or unreachable MongoDB).
 */
export type SetupResume =
  | { saved: false }
  | {
      saved: true;
      configured: true;
      api_id: number;
      owner_id: number;
      bot_count: number;
    }
  | {
      saved: true;
      configured: false;
      stale?: boolean;
      reason?: string;
      connection?: SetupConnection;
    };

export interface SetupCheckResponse {
  configured: boolean;
  api_id: number | null;
  owner_id: number | null;
  bot_count: number | null;
  error: string | null;
}

export interface SetupSaveRequest {
  mongo_uri: string;
  password: string;
  api_id: number;
  api_hash: string;
  bot_token_1: string;
  bot_token_2: string | null;
  bot_token_3: string | null;
  owner_id: number;
  default_chat_id: number;
}

export interface SetupSaveResponse {
  ok: boolean;
  error: string | null;
}

/** Body of a failed setup call: {error}, optional {detail}, optional {errors}. */
export interface SetupFailure {
  status: number;
  error?: string;
  detail?: string;
  errors?: Record<string, string | string[]>;
}

export type SetupResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: SetupFailure };

async function setupPost<T>(
  path: string,
  body: unknown,
): Promise<SetupResult<T>> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & SetupFailure;
  if (res.ok) return { ok: true, data };
  return {
    ok: false,
    failure: { status: res.status, error: data.error, detail: data.detail, errors: data.errors },
  };
}

/** GET /api/setup/resume as the wizard sees it: {ok, status, data}. */
export async function setupResume(): Promise<{
  ok: boolean;
  status: number;
  data: SetupResume;
}> {
  const res = await fetch("/api/setup/resume", { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as SetupResume;
  return { ok: res.ok, status: res.status, data };
}

/** POST /api/setup/check — validate the Mongo URI + wizard password. */
export const setupCheck = (
  mongo_uri: string,
  password: string,
): Promise<SetupResult<SetupCheckResponse>> =>
  setupPost<SetupCheckResponse>("/api/setup/check", { mongo_uri, password });

/** POST /api/setup/save — persist the full configuration. */
export const setupSave = (
  payload: SetupSaveRequest,
): Promise<SetupResult<SetupSaveResponse>> =>
  setupPost<SetupSaveResponse>("/api/setup/save", payload);
