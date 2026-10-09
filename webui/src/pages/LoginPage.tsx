import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { TelegramButton } from "@/components/skybox/TelegramButton";
import { TelegramInput } from "@/components/skybox/TelegramInput";
import { getVersion } from "@tauri-apps/api/app";
import { logger } from "@/lib/logger";
import {
  ApiHttpError,
  apiJson,
  claimAvailable,
  claimConfirm,
  claimStart,
  claimStatus,
  fetchAuthStatus,
  setAuthToken,
  type ClaimStartResponse,
} from "@/lib/auth";
import appStartIcon from "@/assets/images/icon.png";

interface LoginResponse {
  token: string;
  username: string;
}

type LoginMode = "signin" | "register";
type RegistrationMode = "owner" | "invite";
/** Every new account follows the same path: username → Telegram → password. */
type CreateStep = "username" | "verify" | "password";
/** Availability of the typed username; idle until a valid name is typed. */
type Availability = "idle" | "checking" | "available" | "unavailable";

const USERNAME_REGEX = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;
const CLAIM_POLL_MS = 2000;
const AVAILABILITY_DEBOUNCE_MS = 400;

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<LoginMode>("signin");
  // Registration flavour from /api/auth/status: "owner" = first-account
  // bootstrap, "invite" = an administrator created the username. The create
  // flow itself is identical for both — only the copy differs.
  const [registration, setRegistration] =
    useState<RegistrationMode>("invite");
  const [step, setStep] = useState<CreateStep>("username");
  const [claim, setClaim] = useState<ClaimStartResponse | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [availability, setAvailability] = useState<Availability>("idle");
  const [availabilityReason, setAvailabilityReason] = useState("");
  const [appVersion, setAppVersion] = useState<string>("...");
  const [usernameError, setUsernameError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [serverError, setServerError] = useState("");

  const registerFlow = mode === "register";

  useEffect(() => {
    let cancelled = false;

    const loadAppVersion = async () => {
      try {
        const version = await getVersion();
        if (!cancelled) {
          setAppVersion(version);
        }
      } catch (error) {
        logger.warn("LoginPage: Failed to read app version", error);
        if (!cancelled) {
          setAppVersion("unknown");
        }
      }
    };

    const checkAuthStatus = async () => {
      try {
        const data = await fetchAuthStatus();
        if (!cancelled) {
          setRegistration(data.registration);
          setMode(data.needs_registration ? "register" : "signin");
        }
      } catch (error) {
        logger.warn("LoginPage: Failed to check auth status", error);
        if (cancelled) return;
        if (error instanceof ApiHttpError && error.status === 503) {
          // No saved connection — the setup wizard owns this state.
          navigate("/setup", { replace: true });
          return;
        }
        setMode("signin");
      }
    };

    void loadAppVersion();
    void checkAuthStatus();

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // Debounced availability check on the create screen: the Create Account
  // button stays disabled until the server says the name is claimable, so
  // users learn the problem before Telegram ever opens.
  useEffect(() => {
    if (!registerFlow || step !== "username") {
      return;
    }
    if (!USERNAME_REGEX.test(username)) {
      setAvailability("idle");
      setAvailabilityReason("");
      return;
    }

    let cancelled = false;
    setAvailability("checking");
    setAvailabilityReason("");
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await claimAvailable(username);
          if (cancelled) return;
          if (result.available) {
            setAvailability("available");
            setAvailabilityReason("");
          } else {
            setAvailability("unavailable");
            setAvailabilityReason(
              result.reason ?? "This username cannot be claimed.",
            );
          }
        } catch (error) {
          if (cancelled) return;
          logger.warn("LoginPage: availability check failed", error);
          setAvailability("unavailable");
          setAvailabilityReason(
            "Could not reach the server — check your connection and try again.",
          );
        }
      })();
    }, AVAILABILITY_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [registerFlow, step, username]);

  // Poll the claim while waiting for the deep link to be tapped in
  // Telegram. On "verified" the flow advances to the password step by
  // itself — no page refresh, no extra click.
  useEffect(() => {
    if (!registerFlow || step !== "verify" || !claim) {
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await claimStatus(claim.secret);
        if (cancelled) return;
        if (status.status === "verified") {
          setServerError("");
          setStep("password");
        } else if (status.status === "unknown") {
          // Purged or never issued — from here that means it expired.
          setClaim(null);
          setStep("username");
          setServerError(
            "The claim link expired — enter your username to start again.",
          );
        }
        // "pending" — keep polling.
      } catch (error) {
        if (!cancelled) {
          logger.warn("LoginPage: claim status poll failed", error);
        }
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), CLAIM_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [registerFlow, step, claim]);

  const validateUsername = (value: string): string => {
    if (!value) return "Username is required";
    if (!USERNAME_REGEX.test(value)) {
      return "Username must be 3-32 characters (letters, numbers, _, ., -)";
    }
    return "";
  };

  const validatePassword = (value: string): string => {
    if (!value) return "Password is required";
    if (value.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    return "";
  };

  const validateConfirmPassword = (value: string): string => {
    if (mode !== "register") return "";
    if (!value) return "Please confirm your password";
    if (value !== password) return "Passwords do not match";
    return "";
  };

  const clearErrors = () => {
    setUsernameError("");
    setPasswordError("");
    setConfirmPasswordError("");
    setServerError("");
  };

  const resetCreateFlow = () => {
    setStep("username");
    setClaim(null);
    setPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setConfirmPasswordError("");
  };

  const finishSession = (token: string) => {
    setAuthToken(token);
    void queryClient.invalidateQueries({ queryKey: ["me"] });
    navigate("/explorer", { replace: true });
  };

  const handleUsernameChange = (value: string) => {
    setUsername(value);
    setUsernameError(validateUsername(value));
    if (serverError) setServerError("");
  };

  const handlePasswordChange = (value: string) => {
    setPassword(value);
    setPasswordError(validatePassword(value));
    if (mode === "register") {
      setConfirmPasswordError(validateConfirmPassword(confirmPassword));
    }
    if (serverError) setServerError("");
  };

  const handleConfirmPasswordChange = (value: string) => {
    setConfirmPassword(value);
    setConfirmPasswordError(validateConfirmPassword(value));
    if (serverError) setServerError("");
  };

  // ===== Create flow: username → verify → password =====

  const handleUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearErrors();

    const usernameErr = validateUsername(username);
    if (usernameErr) {
      setUsernameError(usernameErr);
      return;
    }
    // Enter submits even when the button is disabled — gate here too.
    if (availability !== "available") {
      setUsernameError(availabilityReason || "Checking availability…");
      return;
    }

    setIsLoading(true);
    try {
      const started = await claimStart(username);
      setClaim(started);
      setStep("verify");
      // Open Telegram right away: the whole point of the button.
      window.open(started.deep_link, "_blank", "noopener,noreferrer");
    } catch (error) {
      if (error instanceof ApiHttpError) {
        if (error.status === 409) {
          setServerError(error.message);
          setMode("signin");
          return;
        }
        setServerError(error.message);
        return;
      }
      logger.error("LoginPage: claim start failed", error);
      setServerError(
        "Network error. Please check your connection and try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearErrors();

    const passwordErr = validatePassword(password);
    const confirmPasswordErr = validateConfirmPassword(confirmPassword);
    if (passwordErr || confirmPasswordErr) {
      if (passwordErr) setPasswordError(passwordErr);
      if (confirmPasswordErr) setConfirmPasswordError(confirmPasswordErr);
      return;
    }
    if (!claim) {
      setServerError("The claim expired — start again from the beginning.");
      setStep("username");
      return;
    }

    setIsLoading(true);
    try {
      const confirmed = await claimConfirm(claim.secret, password);
      finishSession(confirmed.token);
    } catch (error) {
      if (error instanceof ApiHttpError) {
        if (error.status === 409) {
          setServerError(error.message);
          setMode("signin");
          return;
        }
        if (error.status === 403 && error.message.includes("not verified")) {
          setServerError(error.message);
          setStep("verify");
          return;
        }
        if (error.status === 403) {
          // Expired/unknown secret — begin again with the username.
          setServerError(error.message);
          resetCreateFlow();
          return;
        }
        setServerError(error.message);
        return;
      }
      logger.error("LoginPage: claim confirm failed", error);
      setServerError(
        "Network error. Please check your connection and try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenTelegram = () => {
    if (claim) {
      window.open(claim.deep_link, "_blank", "noopener,noreferrer");
    }
  };

  const handleClaimReset = () => {
    clearErrors();
    resetCreateFlow();
  };

  // ===== Sign in =====

  const handleSignInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearErrors();

    const usernameErr = validateUsername(username);
    const passwordErr = validatePassword(password);
    if (usernameErr || passwordErr) {
      if (usernameErr) setUsernameError(usernameErr);
      if (passwordErr) setPasswordError(passwordErr);
      return;
    }

    setIsLoading(true);
    try {
      const login = await apiJson<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      finishSession(login.token);
    } catch (error) {
      if (error instanceof ApiHttpError) {
        setServerError(error.message);
        return;
      }
      logger.error("LoginPage: Sign in failed", error);
      setServerError("Network error. Please check your connection and try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleModeToggle = () => {
    setMode(mode === "signin" ? "register" : "signin");
    clearErrors();
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setAvailability("idle");
    setAvailabilityReason("");
    resetCreateFlow();
  };

  const createSubtitle = () => {
    switch (step) {
      case "username":
        return registration === "owner"
          ? "Set up the owner account — your Telegram username, or admin"
          : "An administrator created your username — enter it to claim it";
      case "verify":
        return "Verify in Telegram to prove you own this account";
      case "password":
        return "Choose a password to finish setting up";
    }
  };

  const createUsernameInput = () => (
    <TelegramInput
      label="Username"
      type="text"
      value={username}
      onChange={(e) => handleUsernameChange(e.target.value)}
      error={
        usernameError ||
        (availability === "unavailable" ? availabilityReason : "")
      }
      placeholder={
        registration === "owner" ? "Telegram username or admin" : "Your username"
      }
      autoComplete="username"
      disabled={isLoading}
    />
  );

  const availabilityHint = () => {
    if (availability === "checking") {
      return (
        <p className="text-xs text-muted-foreground" role="status">
          Checking availability…
        </p>
      );
    }
    if (availability === "available") {
      return (
        <p className="text-xs text-accent" role="status">
          Available — continue to Telegram verification
        </p>
      );
    }
    return null;
  };

  return (
    <div className="h-full bg-background flex flex-col">
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
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
                {registerFlow ? createSubtitle() : "Sign in to your file server"}
              </p>
            </div>

            {serverError && (
              <div
                className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm"
                role="alert"
              >
                {serverError}
              </div>
            )}

            {registerFlow && step === "username" && (
              <form onSubmit={handleUsernameSubmit} className="space-y-4">
                {createUsernameInput()}
                {availabilityHint()}
                <TelegramButton
                  type="submit"
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={isLoading}
                  disabled={isLoading || availability !== "available"}
                >
                  Create Account
                </TelegramButton>
              </form>
            )}

            {registerFlow && step === "verify" && claim && (
              <div className="space-y-4 text-center">
                <p className="text-sm text-muted-foreground">
                  Telegram opened (or open it below). Send{" "}
                  <code className="px-1.5 py-0.5 rounded bg-muted text-foreground">
                    /start
                  </code>{" "}
                  to the bot to verify{" "}
                  <span className="font-medium text-foreground">
                    {claim.username}
                  </span>
                  .
                </p>
                <TelegramButton
                  type="button"
                  variant="primary"
                  size="lg"
                  fullWidth
                  onClick={handleOpenTelegram}
                >
                  Open Telegram
                </TelegramButton>
                <div
                  className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
                  role="status"
                >
                  <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
                  Waiting for verification…
                </div>
                <button
                  type="button"
                  onClick={handleClaimReset}
                  className="text-sm text-muted-foreground hover:text-foreground underline"
                  disabled={isLoading}
                >
                  Start over
                </button>
              </div>
            )}

            {registerFlow && step === "password" && (
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div
                  className="p-3 rounded-lg bg-accent/10 border border-accent/30 text-accent text-sm"
                  role="status"
                >
                  Verified in Telegram — choose a password to finish.
                </div>
                <TelegramInput
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
                  error={passwordError}
                  placeholder="Choose a password"
                  autoComplete="new-password"
                  disabled={isLoading}
                />
                <TelegramInput
                  label="Confirm Password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => handleConfirmPasswordChange(e.target.value)}
                  error={confirmPasswordError}
                  placeholder="Confirm your password"
                  autoComplete="new-password"
                  disabled={isLoading}
                />
                <TelegramButton
                  type="submit"
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={isLoading}
                  disabled={isLoading}
                >
                  Finish setup
                </TelegramButton>
              </form>
            )}

            {!registerFlow && (
              <form onSubmit={handleSignInSubmit} className="space-y-4">
                <TelegramInput
                  label="Username"
                  type="text"
                  value={username}
                  onChange={(e) => handleUsernameChange(e.target.value)}
                  error={usernameError}
                  placeholder="Enter your username"
                  autoComplete="username"
                  disabled={isLoading}
                />

                <TelegramInput
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
                  error={passwordError}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  disabled={isLoading}
                />

                <TelegramButton
                  type="submit"
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={isLoading}
                  disabled={isLoading}
                >
                  Sign In
                </TelegramButton>
              </form>
            )}

            <p className="mt-6 text-center text-sm text-muted-foreground">
              {registerFlow
                ? "Already have an account? "
                : registration === "invite"
                  ? "Invited to join? "
                  : "First time here? "}
              <button
                type="button"
                onClick={handleModeToggle}
                className="text-primary hover:text-accent underline font-medium"
                disabled={isLoading}
              >
                {registerFlow ? "Sign in" : "Create account"}
              </button>
            </p>
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            TelegramFileServer {appVersion}
          </p>
        </div>
      </div>
    </div>
  );
}
