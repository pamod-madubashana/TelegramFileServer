import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { TelegramButton } from "@/components/skybox/TelegramButton";
import { TelegramInput } from "@/components/skybox/TelegramInput";
import { toast } from "@/hooks/use-toast";
import { getVersion } from "@tauri-apps/api/app";
import { logger } from "@/lib/logger";
import {
  ApiHttpError,
  apiJson,
  fetchAuthStatus,
  setAuthToken,
} from "@/lib/auth";
import appStartIcon from "@/assets/images/icon.png";

interface LoginResponse {
  token: string;
  username: string;
}

interface RegisterResponse {
  ok: boolean;
  username: string;
}

type LoginMode = "signin" | "register";
type RegistrationMode = "owner" | "invite";

const USERNAME_REGEX = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<LoginMode>("signin");
  // Registration flow reported by /api/auth/status: "owner" = first-account
  // bootstrap (username must match the Telegram owner), "invite" = claim a
  // username an administrator created.
  const [registration, setRegistration] =
    useState<RegistrationMode>("invite");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("...");
  const [usernameError, setUsernameError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [serverError, setServerError] = useState("");

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
        if (!cancelled) {
          setMode("signin");
        }
      }
    };

    void loadAppVersion();
    void checkAuthStatus();

    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearErrors();

    const usernameErr = validateUsername(username);
    const passwordErr = validatePassword(password);
    const confirmPasswordErr = validateConfirmPassword(confirmPassword);

    if (usernameErr || passwordErr || confirmPasswordErr) {
      if (usernameErr) setUsernameError(usernameErr);
      if (passwordErr) setPasswordError(passwordErr);
      if (confirmPasswordErr) setConfirmPasswordError(confirmPasswordErr);
      return;
    }

    setIsLoading(true);

    try {
      const body = JSON.stringify({ username, password });
      const request = (path: string) =>
        apiJson<LoginResponse | RegisterResponse>(path, {
          method: "POST",
          body,
        });

      if (mode === "register") {
        // Register claims the account (owner bootstrap or invite) but issues
        // no session — sign in with the same credentials so the user lands in
        // the app directly.
        await request("/api/auth/register");
      }

      const login = (await request("/api/auth/login")) as LoginResponse;
      setAuthToken(login.token);
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate("/explorer", { replace: true });
    } catch (error) {
      if (error instanceof ApiHttpError) {
        if (mode === "register" && error.status === 409) {
          // Already claimed — show the reason and move to sign-in.
          setServerError(error.message);
          setMode("signin");
          setConfirmPassword("");
          return;
        }
        setServerError(error.message);
        return;
      }
      logger.error("LoginPage: Submit failed", error);
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
                {mode === "register"
                  ? registration === "owner"
                    ? "Set up the owner account with your Telegram username"
                    : "An administrator created your username — set a password to claim it"
                  : "Sign in to your file server"}
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

            <form onSubmit={handleSubmit} className="space-y-4">
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
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                disabled={isLoading}
              />

              {mode === "register" && (
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
              )}

              <TelegramButton
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={isLoading}
                disabled={isLoading}
              >
                {mode === "register"
                  ? registration === "invite"
                    ? "Claim Account"
                    : "Create Owner Account"
                  : "Sign In"}
              </TelegramButton>
            </form>

            <p className="mt-6 text-center text-sm text-muted-foreground">
              {mode === "register"
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
                {mode === "register"
                  ? "Sign in"
                  : registration === "invite"
                    ? "Claim account"
                    : "Create account"}
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