import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { ArrowRightLeft, HardDrive, Loader2, Trash2 } from "lucide-react";
import { apiJson } from "@/lib/auth";
import { toast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SettingsSectionLayout from "./SettingsSectionLayout";

type StorageStatsBucket = {
  media_type: string;
  count: number;
  total_bytes: number;
};

type StorageStatsResponse = {
  buckets: StorageStatsBucket[];
  total_files: number;
  total_bytes: number;
};

type StorageChatResponse = {
  default_chat_id: number;
  user_storage_chat_id: number | null;
  effective_chat_id: number;
  can_change_default: boolean;
};

type DriveEntry = {
  chat_id: number;
  label: string;
};

type StorageDrivesResponse = {
  drives: DriveEntry[];
};

const MEDIA_TYPE_LABELS: Record<string, string> = {
  photo: "Photos",
  video: "Videos",
  audio: "Audio",
  voice: "Voice",
  document: "Documents",
  animation: "Animations",
  sticker: "Stickers",
};

const MEDIA_TYPE_COLORS: Record<string, string> = {
  document: "#58c96e",
  video: "#54a9f4",
  photo: "#4ecfc4",
  audio: "#9170e6",
  voice: "#f5c24a",
  animation: "#ee7aae",
  sticker: "#f55b6b",
};

const FALLBACK_COLOR = "#94a3b8";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function mediaLabel(type: string): string {
  return MEDIA_TYPE_LABELS[type] ?? type;
}

function mediaColor(type: string): string {
  return MEDIA_TYPE_COLORS[type] ?? FALLBACK_COLOR;
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

export default function StorageSettingsPage() {
  const [stats, setStats] = useState<StorageStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [chat, setChat] = useState<StorageChatResponse | null>(null);
  const [chatLoading, setChatLoading] = useState(true);
  const [chatError, setChatError] = useState<string | null>(null);
  const [personalInput, setPersonalInput] = useState("");
  const [defaultInput, setDefaultInput] = useState("");
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [clearingPersonal, setClearingPersonal] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);

  const [drives, setDrives] = useState<DriveEntry[] | null>(null);
  const [drivesLoading, setDrivesLoading] = useState(true);
  const [drivesError, setDrivesError] = useState<string | null>(null);
  const [addChatId, setAddChatId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addingDrive, setAddingDrive] = useState(false);
  const [removingChatId, setRemovingChatId] = useState<number | null>(null);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const data = await apiJson<StorageStatsResponse>("/api/fs/stats");
      setStats(data);
    } catch (error) {
      logger.warn("StorageSettingsPage: failed to load stats", error);
      setStatsError(errorMessage(error));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadChat = useCallback(async () => {
    setChatLoading(true);
    setChatError(null);
    try {
      const data = await apiJson<StorageChatResponse>("/api/storage/chat");
      setChat(data);
      setPersonalInput(
        data.user_storage_chat_id != null
          ? String(data.user_storage_chat_id)
          : "",
      );
      setDefaultInput(
        data.default_chat_id !== 0 ? String(data.default_chat_id) : "",
      );
    } catch (error) {
      logger.warn("StorageSettingsPage: failed to load storage chat", error);
      setChatError(errorMessage(error));
    } finally {
      setChatLoading(false);
    }
  }, []);

  const loadDrives = useCallback(async () => {
    setDrivesLoading(true);
    setDrivesError(null);
    try {
      const data = await apiJson<StorageDrivesResponse>("/api/storage/drives");
      setDrives(Array.isArray(data?.drives) ? data.drives : []);
    } catch (error) {
      logger.warn("StorageSettingsPage: failed to load drives", error);
      setDrivesError(errorMessage(error));
    } finally {
      setDrivesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats();
    void loadChat();
    void loadDrives();
  }, [loadStats, loadChat, loadDrives]);

  const handleAddDrive = async (event: FormEvent) => {
    event.preventDefault();
    const raw = addChatId.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed) || parsed === 0) {
      toast({
        title: "Invalid chat id",
        description:
          "Enter a real Telegram chat id. 0 is invalid; group/channel ids are negative.",
        variant: "destructive",
      });
      return;
    }
    setAddingDrive(true);
    try {
      const data = await apiJson<StorageDrivesResponse>("/api/storage/drives", {
        method: "POST",
        body: JSON.stringify({
          chat_id: parsed,
          label: addLabel.trim(),
        }),
      });
      setDrives(Array.isArray(data?.drives) ? data.drives : []);
      setAddChatId("");
      setAddLabel("");
      toast({ title: "Drive added" });
    } catch (error) {
      toast({
        title: "Failed to add drive",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setAddingDrive(false);
    }
  };

  const handleRemoveDrive = async (chatId: number) => {
    setRemovingChatId(chatId);
    try {
      const data = await apiJson<StorageDrivesResponse>(
        `/api/storage/drives/${chatId}`,
        { method: "DELETE" },
      );
      setDrives(Array.isArray(data?.drives) ? data.drives : []);
      toast({ title: "Drive removed" });
    } catch (error) {
      toast({
        title: "Failed to remove drive",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setRemovingChatId(null);
    }
  };

  const handleSavePersonal = async (event: FormEvent) => {
    event.preventDefault();
    const raw = personalInput.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed) || parsed === 0) {
      toast({
        title: "Invalid chat id",
        description:
          "Enter a real Telegram chat id. 0 is invalid; group/channel ids are negative.",
        variant: "destructive",
      });
      return;
    }
    setSavingPersonal(true);
    try {
      const data = await apiJson<StorageChatResponse>("/api/storage/chat", {
        method: "PUT",
        body: JSON.stringify({ storage_chat_id: parsed }),
      });
      setChat(data);
      toast({ title: "Storage chat updated" });
    } catch (error) {
      toast({
        title: "Failed to update storage chat",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setSavingPersonal(false);
    }
  };

  const handleClearPersonal = async () => {
    setClearingPersonal(true);
    try {
      const data = await apiJson<StorageChatResponse>("/api/storage/chat", {
        method: "PUT",
        body: JSON.stringify({ storage_chat_id: null }),
      });
      setChat(data);
      setPersonalInput("");
      toast({ title: "Personal override cleared" });
    } catch (error) {
      toast({
        title: "Failed to clear override",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setClearingPersonal(false);
    }
  };

  const handleSaveDefault = async (event: FormEvent) => {
    event.preventDefault();
    const raw = defaultInput.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed) || parsed === 0) {
      toast({
        title: "Invalid chat id",
        description:
          "Enter a real Telegram chat id. 0 is invalid; group/channel ids are negative.",
        variant: "destructive",
      });
      return;
    }
    setSavingDefault(true);
    try {
      const data = await apiJson<StorageChatResponse>("/api/storage/chat", {
        method: "PUT",
        body: JSON.stringify({ default_chat_id: parsed }),
      });
      setChat(data);
      toast({ title: "Default storage chat updated" });
    } catch (error) {
      toast({
        title: "Failed to update default chat",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setSavingDefault(false);
    }
  };

  const chartData = (stats?.buckets ?? [])
    .filter((bucket) => bucket.total_bytes > 0)
    .map((bucket) => ({
      name: mediaLabel(bucket.media_type),
      value: bucket.total_bytes,
      count: bucket.count,
      type: bucket.media_type,
    }));

  const hasPersonalOverride = chat?.user_storage_chat_id != null;

  return (
    <SettingsSectionLayout title="Storage">
      <div className="rounded-xl border border-border bg-glass overflow-hidden">
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-body font-semibold text-foreground">
                Telegram storage
              </p>
              <p className="text-small text-muted-foreground">
                How your files are stored, by media type.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadStats()}
              disabled={statsLoading}
            >
              {statsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Refresh"
              )}
            </Button>
          </div>
        </div>

        <div className="px-4 py-4 space-y-4">
          {statsLoading && !stats ? (
            <div className="flex items-center gap-2 text-small text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading usage…
            </div>
          ) : statsError ? (
            <p className="text-small text-destructive">{statsError}</p>
          ) : !chartData.length ? (
            <p className="text-small text-muted-foreground">
              No files indexed yet — upload something to see usage here.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
                <div className="relative mx-auto h-56 w-56 shrink-0 lg:mx-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={chartData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={48}
                        outerRadius={88}
                        paddingAngle={2}
                        stroke="none"
                      >
                        {chartData.map((entry) => (
                          <Cell key={entry.type} fill={mediaColor(entry.type)} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: number, _name, item) => [
                          `${formatBytes(value)} · ${item?.payload?.count ?? 0} files`,
                          item?.payload?.name ?? "",
                        ]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Totals live in the hole: no second line (and no
                      full-width row) just to repeat them. */}
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-body font-semibold text-foreground tabular-nums">
                      {formatBytes(stats?.total_bytes ?? 0)}
                    </span>
                    <span className="text-small text-muted-foreground">
                      {stats?.total_files ?? 0} file
                      {(stats?.total_files ?? 0) === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                {/* One bordered tile per media type: tiles grow to fill the
                    row, so the space beside the donut never reads as void. */}
                <ul className="flex min-w-0 flex-1 flex-wrap gap-3">
                  {chartData.map((entry) => (
                    <li
                      key={entry.type}
                      className="flex min-w-[14rem] flex-1 items-center gap-3 rounded-lg border border-border px-3.5 py-3"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: mediaColor(entry.type) }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-small font-medium text-foreground">
                          {entry.name}
                        </span>
                        <span className="block text-small text-muted-foreground">
                          {entry.count} file{entry.count === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums text-small font-medium text-foreground">
                        {formatBytes(entry.value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-glass overflow-hidden">
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <p className="text-body font-semibold text-foreground">
              Storage chat
            </p>
          </div>
          <p className="text-small text-muted-foreground mt-1">
            Uploads land in this Telegram chat. Set a personal chat, or (as an
            admin) change the global default.
          </p>
        </div>

        <div className="px-4 py-4 space-y-5">
          {chatLoading && !chat ? (
            <div className="flex items-center gap-2 text-small text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : chatError ? (
            <p className="text-small text-destructive">{chatError}</p>
          ) : chat ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-small">
                <span className="text-muted-foreground">Effective chat:</span>
                <Badge variant="secondary" className="tabular-nums">
                  {String(chat.effective_chat_id)}
                </Badge>
                {hasPersonalOverride ? (
                  <span className="text-muted-foreground">
                    (personal override)
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    (default — no personal chat set)
                  </span>
                )}
              </div>

              <form
                onSubmit={handleSavePersonal}
                className="flex flex-wrap items-end gap-3"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <label
                    htmlFor="personal-storage-chat"
                    className="text-small font-medium text-foreground"
                  >
                    My storage chat
                  </label>
                  <Input
                    id="personal-storage-chat"
                    inputMode="numeric"
                    placeholder="e.g. -1001234567890"
                    value={personalInput}
                    onChange={(event) => setPersonalInput(event.target.value)}
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={savingPersonal || !personalInput.trim()}
                >
                  {savingPersonal ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Save"
                  )}
                </Button>
                {hasPersonalOverride && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleClearPersonal()}
                    disabled={clearingPersonal}
                  >
                    {clearingPersonal ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <ArrowRightLeft className="h-4 w-4" />
                        Use default
                      </>
                    )}
                  </Button>
                )}
              </form>

              {chat.can_change_default && (
              <form
                onSubmit={handleSaveDefault}
                className="flex flex-wrap items-end gap-3 border-t border-border pt-4"
              >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <label
                      htmlFor="default-storage-chat"
                      className="text-small font-medium text-foreground"
                    >
                      Default chat (all accounts)
                    </label>
                    <Input
                      id="default-storage-chat"
                      inputMode="numeric"
                      placeholder={
                        chat.default_chat_id !== 0
                          ? String(chat.default_chat_id)
                          : "e.g. -1001234567890"
                      }
                      value={defaultInput}
                      onChange={(event) => setDefaultInput(event.target.value)}
                    />
                    <p className="text-small text-muted-foreground">
                      Used when an account has no personal storage chat.
                    </p>
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    variant="secondary"
                    disabled={savingDefault || !defaultInput.trim()}
                  >
                    {savingDefault ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Update default"
                    )}
                  </Button>
                </form>
              )}
            </>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-glass overflow-hidden">
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <p className="text-body font-semibold text-foreground">
              Extra drives
            </p>
          </div>
          <p className="text-small text-muted-foreground mt-1">
            Add other Telegram chats to browse them in the explorer. Files you
            upload while a drive is open are sent to that chat.
          </p>
        </div>

        <div className="flex flex-col gap-5 px-4 py-4 lg:flex-row lg:items-start">
          {drivesLoading && !drives ? (
            <div className="flex items-center gap-2 text-small text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading drives…
            </div>
          ) : drivesError ? (
            <p className="text-small text-destructive">{drivesError}</p>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                {!drives?.length ? (
                  <p className="text-small text-muted-foreground">
                    No extra drives yet — the chats you add appear in the
                    explorer sidebar under “Drives”.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {drives.map((drive) => (
                      <li
                        key={drive.chat_id}
                        className="flex items-center justify-between gap-3 text-small"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="truncate text-foreground">
                            {drive.label?.trim() || `Chat ${drive.chat_id}`}
                          </span>
                          <Badge
                            variant="secondary"
                            className="tabular-nums shrink-0"
                          >
                            {String(drive.chat_id)}
                          </Badge>
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleRemoveDrive(drive.chat_id)}
                          disabled={removingChatId === drive.chat_id}
                          aria-label={`Remove drive ${drive.chat_id}`}
                        >
                          {removingChatId === drive.chat_id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Trash2 className="h-4 w-4" />
                              Remove
                            </>
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <form
                onSubmit={handleAddDrive}
                className="flex min-w-0 flex-1 flex-col gap-2 border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pl-5 lg:pt-0"
              >
                {/* Same-height field blocks, bottoms aligned: labels and
                    inputs stay on one line instead of ragged heights. */}
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[14rem] flex-1 space-y-1.5">
                    <label
                      htmlFor="add-drive-chat-id"
                      className="text-small font-medium text-foreground"
                    >
                      Chat id
                    </label>
                    <Input
                      id="add-drive-chat-id"
                      inputMode="numeric"
                      placeholder="e.g. -1001234567890"
                      value={addChatId}
                      onChange={(event) => setAddChatId(event.target.value)}
                    />
                  </div>
                  <div className="min-w-[12rem] flex-1 space-y-1.5">
                    <label
                      htmlFor="add-drive-label"
                      className="text-small font-medium text-foreground"
                    >
                      Label{" "}
                      <span className="text-muted-foreground">(optional)</span>
                    </label>
                    <Input
                      id="add-drive-label"
                      placeholder="e.g. Family photos"
                      value={addLabel}
                      onChange={(event) => setAddLabel(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={addingDrive || !addChatId.trim()}
                  >
                    {addingDrive ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Add drive"
                    )}
                  </Button>
                </div>
                <p className="text-small text-muted-foreground">
                  The bot must be able to read the chat for it to open.
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </SettingsSectionLayout>
  );
}
