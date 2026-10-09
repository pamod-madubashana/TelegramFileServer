import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TelegramButton } from "@/components/skybox/TelegramButton";
import { TelegramInput } from "@/components/skybox/TelegramInput";
import { logger } from "@/lib/logger";
import {
  setupCheck,
  setupResume,
  setupSave,
  type SetupFailure,
  type SetupResume,
} from "@/lib/setup";
import appStartIcon from "@/assets/images/icon.png";

type Step = 1 | 2;
type NoticeType = "info" | "warning" | "error";

interface Notice {
  type: NoticeType;
  message: string;
  detail?: string;
}

const MONGO_URI_RE = /^mongodb(\+srv)?:\/\//i;
const MIN_PASSWORD_LENGTH = 8;

/** Field map for the 400 {errors} payload of /api/setup/save. */
const SAVE_ERROR_FIELDS: Record<string, string> = {
  mongo_uri: "mongoUri",
  api_id: "apiId",
  api_hash: "apiHash",
  bot_token_1: "botToken1",
  bot_token_2: "botToken2",
  bot_token_3: "botToken3",
  owner_id: "ownerId",
  default_chat_id: "defaultChatId",
};

export default function SetupPage() {
  const navigate = useNavigate();
  const [resuming, setResuming] = useState(true);
  const [step, setStep] = useState<Step>(1);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [fieldDetails, setFieldDetails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"check" | "save" | null>(null);

  // Step 1 — MongoDB connection
  const [mongoUri, setMongoUri] = useState("");
  const [password, setPassword] = useState("");

  // Step 2 — Telegram API
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [botToken1, setBotToken1] = useState("");
  const [botToken2, setBotToken2] = useState("");
  const [botToken3, setBotToken3] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [defaultChatId, setDefaultChatId] = useState("");

  const step1Valid =
    MONGO_URI_RE.test(mongoUri.trim()) && password.length >= MIN_PASSWORD_LENGTH;

  const apiIdNum = parseInt(apiId, 10);
  const ownerIdNum = parseInt(ownerId, 10);
  const chatIdNum = parseInt(defaultChatId, 10);
  const step2Valid =
    Number.isInteger(apiIdNum) &&
    apiIdNum >= 1 &&
    apiHash.trim() !== "" &&
    botToken1.trim() !== "" &&
    Number.isInteger(ownerIdNum) &&
    ownerIdNum >= 1 &&
    Number.isInteger(chatIdNum) &&
    // Chat IDs may be negative (groups/channels); only 0 is invalid.
    chatIdNum !== 0;

  const clearFeedback = () => {
    setNotice(null);
    setFieldErrors({});
    setFieldDetails({});
  };

  const showStep1 = () => {
    setStep(1);
  };

  const showStep2 = () => {
    setStep(2);
  };

  // Load saved state on mount — same resume logic the old wizard had.
  useEffect(() => {
    let cancelled = false;

    const loadResume = async () => {
      try {
        const { ok, status, data } = await setupResume();
        if (cancelled) return;
        if (!ok) {
          showStep1();
          if (status !== 404) {
            setNotice({
              type: "error",
              message: "Failed to load setup state",
              detail: `HTTP ${status}`,
            });
          }
          return;
        }
        handleResume(data);
      } catch (err) {
        if (cancelled) return;
        showStep1();
        setNotice({
          type: "error",
          message: "Failed to load setup state",
          detail: err instanceof Error ? err.message : "server unreachable",
        });
      } finally {
        if (!cancelled) setResuming(false);
      }
    };

    void loadResume();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResume = (data: SetupResume) => {
    if (data.saved === false) {
      showStep1();
      return;
    }
    if (!("configured" in data)) {
      showStep1();
      return;
    }
    if (data.configured === true) {
      // Already set up — go straight to the app.
      navigate("/", { replace: true });
      return;
    }
    if (data.stale === true) {
      if (data.reason === "password-mismatch") {
        showStep1();
        setNotice({
          type: "warning",
          message: "Saved connection is no longer valid",
        });
      } else if (data.reason === "connection-failed" && data.connection) {
        setMongoUri(data.connection.mongo_uri);
        setPassword(data.connection.password);
        showStep1();
        setNotice({
          type: "error",
          message: "Could not reach MongoDB — check the URI",
        });
      } else {
        showStep1();
      }
      return;
    }
    if (data.connection) {
      setMongoUri(data.connection.mongo_uri);
      setPassword(data.connection.password);
      showStep2();
      return;
    }
    showStep1();
  };

  const applyFailure = (failure: SetupFailure, fallback: string) => {
    if (failure.status === 401) {
      setFieldErrors({ password: failure.error || "Invalid password" });
      return;
    }
    if (failure.status === 502) {
      setFieldErrors({ mongoUri: failure.error || "Could not reach MongoDB — check the URI" });
      if (failure.detail) setFieldDetails({ mongoUri: failure.detail });
      return;
    }
    if (failure.status === 400 && failure.errors) {
      const mapped: Record<string, string> = {};
      Object.entries(failure.errors).forEach(([field, messages]) => {
        const input = SAVE_ERROR_FIELDS[field];
        if (input) {
          mapped[input] = Array.isArray(messages) ? messages.join(", ") : messages;
        }
      });
      if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        return;
      }
    }
    setNotice({
      type: "error",
      message: failure.error || fallback,
      detail: failure.detail,
    });
  };

  const handleCheckSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!step1Valid || busy) return;
    clearFeedback();
    setBusy("check");
    try {
      const result = await setupCheck(mongoUri.trim(), password);
      if (result.ok) {
        if (result.data.configured === true) {
          navigate("/", { replace: true });
        } else {
          showStep2();
        }
      } else {
        applyFailure(result.failure, "Connection check failed");
      }
    } catch (err) {
      logger.error("SetupPage: check failed", err);
      setNotice({
        type: "error",
        message: "Connection check failed",
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleSaveSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!step2Valid || busy) return;
    clearFeedback();
    setBusy("save");
    try {
      const result = await setupSave({
        mongo_uri: mongoUri.trim(),
        password,
        api_id: apiIdNum,
        api_hash: apiHash.trim(),
        bot_token_1: botToken1.trim(),
        bot_token_2: botToken2.trim() || null,
        bot_token_3: botToken3.trim() || null,
        owner_id: ownerIdNum,
        default_chat_id: chatIdNum,
      });
      if (result.ok) {
        if (result.data.ok === true) {
          // Config saved → the server is ready; LoadingPage re-checks resume
          // and routes into the app.
          navigate("/", { replace: true });
        } else {
          setNotice({
            type: "error",
            message: result.data.error || "Save failed",
          });
        }
      } else {
        applyFailure(result.failure, "Save failed");
      }
    } catch (err) {
      logger.error("SetupPage: save failed", err);
      setNotice({
        type: "error",
        message: "Save failed",
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const dotClass = (n: number) =>
    n === step
      ? "bg-primary text-primary-foreground border-primary shadow-[0_0_0_5px_rgba(34,211,238,0.08)]"
      : n < step
        ? "border-emerald-400/45 text-foreground"
        : "border-border text-foreground";

  const lineClass = (n: 1 | 2) =>
    n < step ? "bg-emerald-400/45" : "bg-border";

  return (
    <div className="h-full bg-background flex flex-col">
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-xl">
          <div className="glass-card rounded-2xl p-8 sm:p-10">
            <div className="flex flex-col items-center text-center mb-8">
              <img
                src={appStartIcon}
                alt="TelegramFileServer"
                className="w-24 h-24 sm:w-28 sm:h-28 rounded-xl object-contain mb-6"
              />
              <h1 className="text-2xl font-bold text-foreground mb-2">
                TelegramFileServer
              </h1>
              <p className="text-muted-foreground">
                Set up your self-hosted Telegram storage server in a few quick
                steps.
              </p>
            </div>

            {/* Step indicator */}
            <div className="flex items-center justify-center gap-2 mb-8" aria-label="Setup progress">
              <div
                className={`h-7 w-7 grid place-items-center rounded-full border text-xs font-bold ${dotClass(1)}`}
                aria-label="Step 1: MongoDB"
              >
                1
              </div>
              <div className={`h-px flex-1 max-w-24 ${lineClass(1)}`} />
              <div
                className={`h-7 w-7 grid place-items-center rounded-full border text-xs font-bold ${dotClass(2)}`}
                aria-label="Step 2: Telegram"
              >
                2
              </div>
              <div className={`h-px flex-1 max-w-24 ${lineClass(2)}`} />
              <div
                className={`h-7 w-7 grid place-items-center rounded-full border text-xs font-bold ${dotClass(3)}`}
                aria-label="Step 3: Done"
              >
                3
              </div>
            </div>

            {resuming ? (
              <div
                className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground"
                role="status"
              >
                <span className="inline-block h-6 w-6 rounded-full border-2 border-border border-t-primary animate-spin" />
                Loading setup state…
              </div>
            ) : (
              <>
                {notice && (
                  <div
                    className={`mb-6 p-4 rounded-lg border text-sm ${
                      notice.type === "error"
                        ? "bg-destructive/10 border-destructive/30 text-destructive"
                        : notice.type === "warning"
                          ? "bg-amber-400/10 border-amber-400/30 text-amber-300"
                          : "bg-primary/10 border-primary/30 text-primary"
                    }`}
                    role="alert"
                  >
                    <p>{notice.message}</p>
                    {notice.detail && (
                      <details className="mt-2 text-xs opacity-90">
                        <summary className="cursor-pointer select-none">
                          Technical details
                        </summary>
                        <code className="break-all">{notice.detail}</code>
                      </details>
                    )}
                  </div>
                )}

                {step === 1 && (
                  <form onSubmit={handleCheckSubmit} className="space-y-4">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-primary mb-1">
                        Step 01 · Database
                      </p>
                      <h2 className="text-xl font-bold text-foreground">
                        MongoDB Connection
                      </h2>
                    </div>
                    <TelegramInput
                      label="MongoDB URI"
                      type="text"
                      value={mongoUri}
                      onChange={(e) => {
                        setMongoUri(e.target.value);
                        setFieldErrors((f) => ({ ...f, mongoUri: "" }));
                      }}
                      error={fieldErrors.mongoUri}
                      hint="Paste the URI from your MongoDB cluster (Atlas or any hosted MongoDB). It is stored encrypted next to the binary in config.tfs."
                      placeholder="mongodb+srv://<cluster>.mongodb.net/<database>"
                      autoComplete="off"
                      disabled={busy !== null}
                      required
                    />
                    {fieldDetails.mongoUri && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">
                          Technical details
                        </summary>
                        <code className="break-all">
                          {fieldDetails.mongoUri}
                        </code>
                      </details>
                    )}
                    <TelegramInput
                      label="Password"
                      type="password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setFieldErrors((f) => ({ ...f, password: "" }));
                      }}
                      error={fieldErrors.password}
                      hint={`Must be at least ${MIN_PASSWORD_LENGTH} characters`}
                      placeholder="Min 8 characters"
                      autoComplete="new-password"
                      disabled={busy !== null}
                      required
                    />
                    <TelegramButton
                      type="submit"
                      variant="primary"
                      size="lg"
                      fullWidth
                      loading={busy === "check"}
                      disabled={!step1Valid || busy !== null}
                    >
                      Connect &amp; check
                    </TelegramButton>
                  </form>
                )}

                {step === 2 && (
                  <form onSubmit={handleSaveSubmit} className="space-y-4">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-primary mb-1">
                        Step 02 · Telegram
                      </p>
                      <h2 className="text-xl font-bold text-foreground">
                        Telegram API
                      </h2>
                    </div>
                    <TelegramInput
                      label="API ID"
                      type="number"
                      value={apiId}
                      onChange={(e) => {
                        setApiId(e.target.value);
                        setFieldErrors((f) => ({ ...f, apiId: "" }));
                      }}
                      error={fieldErrors.apiId}
                      placeholder="123456"
                      autoComplete="off"
                      disabled={busy !== null}
                      required
                    />
                    <TelegramInput
                      label="API Hash"
                      type="text"
                      value={apiHash}
                      onChange={(e) => {
                        setApiHash(e.target.value);
                        setFieldErrors((f) => ({ ...f, apiHash: "" }));
                      }}
                      error={fieldErrors.apiHash}
                      placeholder="abcdef1234567890abcdef1234567890"
                      autoComplete="off"
                      disabled={busy !== null}
                      required
                    />
                    <TelegramInput
                      label="Bot Token 1"
                      type="text"
                      value={botToken1}
                      onChange={(e) => {
                        setBotToken1(e.target.value);
                        setFieldErrors((f) => ({ ...f, botToken1: "" }));
                      }}
                      error={fieldErrors.botToken1}
                      placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                      autoComplete="off"
                      disabled={busy !== null}
                      required
                    />
                    <TelegramInput
                      label="Bot Token 2 (optional)"
                      type="text"
                      value={botToken2}
                      onChange={(e) => {
                        setBotToken2(e.target.value);
                        setFieldErrors((f) => ({ ...f, botToken2: "" }));
                      }}
                      error={fieldErrors.botToken2}
                      placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew12"
                      autoComplete="off"
                      disabled={busy !== null}
                    />
                    <TelegramInput
                      label="Bot Token 3 (optional)"
                      type="text"
                      value={botToken3}
                      onChange={(e) => {
                        setBotToken3(e.target.value);
                        setFieldErrors((f) => ({ ...f, botToken3: "" }));
                      }}
                      error={fieldErrors.botToken3}
                      placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew13"
                      autoComplete="off"
                      disabled={busy !== null}
                    />
                    <TelegramInput
                      label="Owner ID"
                      type="number"
                      value={ownerId}
                      onChange={(e) => {
                        setOwnerId(e.target.value);
                        setFieldErrors((f) => ({ ...f, ownerId: "" }));
                      }}
                      error={fieldErrors.ownerId}
                      placeholder="987654321"
                      autoComplete="off"
                      disabled={busy !== null}
                      required
                    />
                    <TelegramInput
                      label="Default Chat ID"
                      type="number"
                      value={defaultChatId}
                      onChange={(e) => {
                        setDefaultChatId(e.target.value);
                        setFieldErrors((f) => ({ ...f, defaultChatId: "" }));
                      }}
                      error={fieldErrors.defaultChatId}
                      hint="Where files are stored when no chat is configured — groups and channels have negative IDs"
                      placeholder="-1001234567890"
                      autoComplete="off"
                      disabled={busy !== null}
                      required
                    />
                    <TelegramButton
                      type="submit"
                      variant="primary"
                      size="lg"
                      fullWidth
                      loading={busy === "save"}
                      disabled={!step2Valid || busy !== null}
                    >
                      Save &amp; finish
                    </TelegramButton>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
