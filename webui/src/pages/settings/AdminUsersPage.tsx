import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import {
  ApiHttpError,
  apiJson,
  apiSend,
  useMe,
  type UserSummary,
} from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

export default function AdminUsersPage() {
  const me = useMe();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isAdmin = me.data?.role === "admin";
  const currentUsername = me.data?.username;

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const data = await apiJson<{ users: UserSummary[] }>("/api/admin/users");
      setUsers(data.users);
    } catch (error) {
      logger.warn("AdminUsersPage: failed to load users", error);
      setListError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void loadUsers();
  }, [isAdmin, loadUsers]);

  const patchUser = async (
    username: string,
    patch: Record<string, unknown>,
  ): Promise<UserSummary> => {
    const updated = await apiJson<UserSummary>(
      `/api/admin/users/${encodeURIComponent(username)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    setUsers((list) =>
      list.map((u) => (u.username === updated.username ? updated : u)),
    );
    return updated;
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const name = newUsername.trim();
    setCreateError("");
    if (!USERNAME_REGEX.test(name)) {
      setCreateError(
        "Username must be 3-32 characters (letters, numbers, _, ., -)",
      );
      return;
    }
    setCreating(true);
    try {
      const created = await apiJson<UserSummary>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username: name }),
      });
      setNewUsername("");
      toast({
        title: "Invite created",
        description: `${created.username} can now claim their account.`,
      });
      await loadUsers();
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const updatePermissions = async (
    user: UserSummary,
    key: "read" | "write",
    value: boolean,
  ) => {
    setBusyUser(user.username);
    try {
      await patchUser(user.username, { permissions: { [key]: value } });
    } catch (error) {
      toast({
        title: "Permission update failed",
        description: errorMessage(error),
        variant: "destructive",
      });
      // Roll back to the server's view of the row.
      await loadUsers();
    } finally {
      setBusyUser(null);
    }
  };

  const updateRole = async (
    user: UserSummary,
    role: "admin" | "user",
  ) => {
    setBusyUser(user.username);
    try {
      await patchUser(user.username, { role });
      toast({
        title: "Role updated",
        description: `${user.username} is now ${role === "admin" ? "an administrator" : "a user"}.`,
      });
    } catch (error) {
      toast({
        title: "Role update failed",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setBusyUser(null);
    }
  };

  const resyncUser = async (user: UserSummary) => {
    setBusyUser(user.username);
    try {
      await apiJson<UserSummary>(
        `/api/admin/users/${encodeURIComponent(user.username)}/resync`,
        { method: "POST" },
      );
      await loadUsers();
      toast({
        title: "Telegram sync finished",
        description: `Re-checked the Telegram link for ${user.username}.`,
      });
    } catch (error) {
      toast({
        title: "Telegram sync failed",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setBusyUser(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiSend(
        `/api/admin/users/${encodeURIComponent(deleteTarget.username)}`,
        { method: "DELETE" },
      );
      const removed = deleteTarget.username;
      setUsers((list) => list.filter((u) => u.username !== removed));
      setDeleteTarget(null);
      toast({
        title: "Account removed",
        description: `${removed} was deleted.`,
      });
    } catch (error) {
      toast({
        title: "Delete failed",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  if (me.isPending) {
    return (
      <SettingsSectionLayout title="Users">
        <p className="text-small text-muted-foreground">Loading…</p>
      </SettingsSectionLayout>
    );
  }

  if (me.isError) {
    return (
      <SettingsSectionLayout title="Users">
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
      <SettingsSectionLayout title="Users">
        <RowShell>
          <div className="px-4 py-4">
            <p className="text-small text-muted-foreground">
              Sign in to manage user accounts.
            </p>
          </div>
        </RowShell>
      </SettingsSectionLayout>
    );
  }

  if (!isAdmin) {
    return (
      <SettingsSectionLayout title="Users">
        <RowShell>
          <div className="px-4 py-4">
            <p className="text-small text-muted-foreground">
              Administrator access required.
            </p>
          </div>
        </RowShell>
      </SettingsSectionLayout>
    );
  }

  return (
    <SettingsSectionLayout title="Users">
      <RowShell>
        <div className="px-4 py-4 border-b border-border">
          <p className="text-body font-semibold text-foreground">
            Create invite
          </p>
          <p className="text-small text-muted-foreground">
            Add a username — the invited owner claims it by setting a password
            on the sign-in screen. Telegram is linked automatically when the
            username resolves (resync anytime below).
          </p>
        </div>
        <form onSubmit={handleCreate} className="px-4 py-4 space-y-3">
          <div className="flex items-start gap-3">
            <Input
              value={newUsername}
              onChange={(e) => {
                setNewUsername(e.target.value);
                if (createError) setCreateError("");
              }}
              placeholder="Username (3-32 chars: letters, numbers, _, ., -)"
              disabled={creating}
              className="max-w-md"
            />
            <Button type="submit" disabled={creating || !newUsername.trim()}>
              {creating ? "Creating…" : "Create invite"}
            </Button>
          </div>
          {createError && (
            <p className="text-small text-destructive" role="alert">
              {createError}
            </p>
          )}
        </form>
      </RowShell>

      <RowShell>
        <div className="px-4 py-4 border-b border-border flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-body font-semibold text-foreground">Accounts</p>
            <p className="text-small text-muted-foreground">
              Roles, Telegram links and read/write permissions.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadUsers()}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>

        <div className="px-4 py-4">
          {listError ? (
            <div className="space-y-3">
              <p className="text-small text-destructive">{listError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadUsers()}
              >
                Retry
              </Button>
            </div>
          ) : loading && users.length === 0 ? (
            <p className="text-small text-muted-foreground">Loading users…</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Telegram</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">Read</TableHead>
                    <TableHead className="text-center">Write</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => {
                    const isSelf = user.username === currentUsername;
                    const busy = busyUser === user.username;
                    const canChangeRole = !user.is_owner && !isSelf;
                    return (
                      <TableRow key={user.username}>
                        <TableCell>
                          <span className="text-small font-medium text-foreground">
                            {user.username}
                          </span>
                          {isSelf && (
                            <Badge variant="outline" className="ml-2">
                              you
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={user.is_owner ? "default" : "secondary"}
                          >
                            {user.is_owner ? "owner" : user.role}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {user.telegram_username ? (
                            <span className="text-small text-muted-foreground">
                              @{user.telegram_username}
                              {user.telegram_user_id != null &&
                                ` · ${user.telegram_user_id}`}
                            </span>
                          ) : (
                            <span className="text-small text-muted-foreground italic">
                              not linked
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {user.claimed ? (
                            <Badge variant="outline">active</Badge>
                          ) : (
                            <Badge variant="destructive">invite pending</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          <Switch
                            checked={user.permissions.read}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              void updatePermissions(user, "read", checked)
                            }
                            aria-label={`Read permission for ${user.username}`}
                          />
                        </TableCell>
                        <TableCell className="text-center">
                          <Switch
                            checked={user.permissions.write}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              void updatePermissions(user, "write", checked)
                            }
                            aria-label={`Write permission for ${user.username}`}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {canChangeRole && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  void updateRole(
                                    user,
                                    user.role === "admin" ? "user" : "admin",
                                  )
                                }
                              >
                                {user.role === "admin"
                                  ? "Make user"
                                  : "Make admin"}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy}
                              onClick={() => void resyncUser(user)}
                              title="Re-check the Telegram link for this username"
                            >
                              <RefreshCw />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isSelf || user.is_owner || busy}
                              onClick={() => setDeleteTarget(user)}
                              title={
                                isSelf
                                  ? "You cannot delete your own account"
                                  : user.is_owner
                                    ? "The owner account cannot be deleted"
                                    : "Delete this account"
                              }
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {users.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={7}>
                        <p className="text-small text-muted-foreground">
                          No accounts yet — create the first invite above.
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </RowShell>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget &&
                `${deleteTarget.username} will lose access immediately. This cannot be undone — an admin can create a new invite with the same username later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSectionLayout>
  );
}
