import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import {
  ApiHttpError,
  changePassword,
  changeUsername,
  checkUsernameAvailable,
  setAuthToken,
  useMe,
  type UsernameAvailableResponse,
} from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeUsername } from "@/lib/utils";
import SettingsSectionLayout from "./SettingsSectionLayout";

const USERNAME_REGEX = /^[A-Za-z0-9_.-]{3,32}$/;

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiHttpError || error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const RowShell = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-xl border border-border bg-glass overflow-hidden">
    {children}
  </div>
);

export default function AccountSettingsPage() {
  const me = useMe();
  const queryClient = useQueryClient();

  const currentUsername = me.data?.username;

  const [newUsername, setNewUsername] = useState("");
  const [availability, setAvailability] =
    useState<UsernameAvailableResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [usernameError, setUsernameError] = useState("");
  const [renaming, setRenaming] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const trimmed = newUsername.trim();
  const isOwnName =
    currentUsername !== undefined &&
    trimmed.toLowerCase() === currentUsername.toLowerCase();

  // Check on a quiet keystroke interval rather than per keystroke — the
  // server is the final authority either way, this only pre-empts a 409.
  useEffect(() => {
    setAvailability(null);
    if (!currentUsername || isOwnName) return;
    if (!USERNAME_REGEX.test(trimmed)) return;

    const timer = window.setTimeout(() => {
      setChecking(true);
      checkUsernameAvailable(trimmed)
        .then(setAvailability)
        .catch((error) => {
          logger.warn("AccountSettingsPage: availability check failed", error);
          setAvailability(null);
        })
        .finally(() => setChecking(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [trimmed, currentUsername, isOwnName]);

  const handleRename = async (event: FormEvent) => {
    event.preventDefault();
    setUsernameError("");

    if (!USERNAME_REGEX.test(trimmed)) {
      setUsernameError(
        "Username must be 3-32 characters (letters, numbers, _, ., -)",
      );
      return;
    }
    if (isOwnName) {
      setAvailability({ username: trimmed, available: true, reason: null });
      return;
    }

    setRenaming(true);
    try {
      const renamed = await changeUsername(trimmed);
      // The session is keyed by username, so the old token died with the old
      // name — swap in the replacement before anything refetches.
      setAuthToken(renamed.token);
      setNewUsername("");
      setAvailability(null);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      toast({
        title: "Username changed",
        description: `You are now ${renamed.username}.`,
      });
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 409) {
        setAvailability({
          username: trimmed,
          available: false,
          reason: error.message,
        });
      }
      setUsernameError(errorMessage(error));
    } finally {
      setRenaming(false);
    }
  };

  const handlePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordError("");

    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("The new passwords do not match.");
      return;
    }

    setChangingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({
        title: "Password changed",
        description: "Use the new password the next time you sign in.",
      });
    } catch (error) {
      setPasswordError(errorMessage(error));
    } finally {
      setChangingPassword(false);
    }
  };

  if (me.isPending) {
    return (
      <SettingsSectionLayout title="Account">
        <p className="text-small text-muted-foreground">Loading…</p>
      </SettingsSectionLayout>
    );
  }

  if (me.isError) {
    return (
      <SettingsSectionLayout title="Account">
        <RowShell>
          <div className="px-4 py-4 space-y-3">
            <p className="text-body font-semibold text-foreground">
              Couldn&apos;t load your profile
            </p>
            <p className="text-small text-muted-foreground">
              {errorMessage(me.error)}
            </p>
            <Button variant="outline" size="sm" onClick={() => void me.refetch()}>
              Retry
            </Button>
          </div>
        </RowShell>
      </SettingsSectionLayout>
    );
  }

  if (!me.data) {
    return (
      <SettingsSectionLayout title="Account">
        <RowShell>
          <div className="px-4 py-4">
            <p className="text-small text-muted-foreground">
              Sign in to change your account settings.
            </p>
          </div>
        </RowShell>
      </SettingsSectionLayout>
    );
  }

  return (
    <SettingsSectionLayout title="Account">
      <RowShell>
        <div className="px-4 py-4 border-b border-border">
          <p className="text-body font-semibold text-foreground">Username</p>
          <p className="text-small text-muted-foreground">
            Your account is{" "}
            <span className="font-medium text-foreground">
              {me.data.username}
            </span>
            {me.data.telegram_username &&
              ` · linked to @${me.data.telegram_username}`}
            . Renaming updates it everywhere immediately — an administrator
            unlocks a username first, but you choose this one yourself.
          </p>
        </div>

        <form onSubmit={handleRename} className="px-4 py-4 space-y-3">
          <div className="flex items-start gap-3">
            <Input
              value={newUsername}
              onChange={(event) => {
                // A handle pasted out of Telegram carries a leading `@` —
                // strip it so the rename targets the bare name.
                setNewUsername(normalizeUsername(event.target.value));
                if (usernameError) setUsernameError("");
              }}
              placeholder="New username (3-32 chars: letters, numbers, _, ., -)"
              disabled={renaming}
              className="max-w-md"
            />
            <Button
              type="submit"
              disabled={renaming || !trimmed || isOwnName}
            >
              {renaming ? "Changing…" : "Change username"}
            </Button>
          </div>

          {checking && !usernameError && (
            <p className="text-small text-muted-foreground">Checking…</p>
          )}
          {!checking && !usernameError && availability && (
            <p
              className={`text-small ${availability.available ? "text-primary" : "text-destructive"}`}
              role="status"
            >
              {availability.available
                ? `${availability.username} is available.`
                : (availability.reason ?? "That username is unavailable.")}
            </p>
          )}
          {usernameError && (
            <p className="text-small text-destructive" role="alert">
              {usernameError}
            </p>
          )}
        </form>
      </RowShell>

      <RowShell>
        <div className="px-4 py-4 border-b border-border">
          <p className="text-body font-semibold text-foreground">Password</p>
          <p className="text-small text-muted-foreground">
            Re-password your own account. The current password is required so
            an unattended session can&apos;t lock you out.
          </p>
        </div>

        <form onSubmit={handlePassword} className="px-4 py-4 space-y-3">
          <div className="space-y-3 max-w-md">
            <Input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                if (passwordError) setPasswordError("");
              }}
              placeholder="Current password"
              disabled={changingPassword}
            />
            <Input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
                if (passwordError) setPasswordError("");
              }}
              placeholder="New password (at least 8 characters)"
              disabled={changingPassword}
            />
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                if (passwordError) setPasswordError("");
              }}
              placeholder="Repeat the new password"
              disabled={changingPassword}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={changingPassword || !currentPassword || !newPassword}
            >
              {changingPassword ? "Changing…" : "Change password"}
            </Button>
            {passwordError && (
              <p className="text-small text-destructive" role="alert">
                {passwordError}
              </p>
            )}
          </div>
        </form>
      </RowShell>
    </SettingsSectionLayout>
  );
}
