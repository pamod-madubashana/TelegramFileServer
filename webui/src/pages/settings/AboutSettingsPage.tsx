import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  Cpu,
  MessageCircle,
  Monitor,
  Package,
  Tag,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import appBackground from "@/assets/images/bg.png";
import appIcon from "@/assets/images/icon.png";
import { TelegramButton } from "@/components/skybox/TelegramButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import SettingsSectionLayout from "./SettingsSectionLayout";

type AboutFact = {
  id: string;
  label: string;
  value: string;
  icon: LucideIcon;
};

type FeedbackErrorKind =
  | "destination_not_found"
  | "destination_unavailable"
  | "permission_denied"
  | "slow_mode_or_rate_limit"
  | "network_error"
  | "telegram_error"
  | "validation_error";

type FeedbackDestinationStatus = {
  available: boolean;
  reason?: string | null;
  errorKind?: FeedbackErrorKind | null;
  channelChatId?: number | null;
  supergroupId?: number | null;
  directMessagesChatId?: number | null;
  channelTitle?: string | null;
  channelUsername?: string | null;
  resolvedAtMs?: number | null;
};

type FeedbackSendRequest = {
  message: string;
  category?: string | null;
};

type FeedbackSendResult = {
  ok: boolean;
  reason?: string | null;
  errorKind?: FeedbackErrorKind | null;
  sentMessageId?: number | null;
  channelTitle?: string | null;
  directMessagesChatId?: number | null;
};

type FeedbackStatus =
  | "idle"
  | "resolving"
  | "ready"
  | "unavailable"
  | "sending"
  | "sent"
  | "failed";

type FeedbackState = {
  status: FeedbackStatus;
  destination: FeedbackDestinationStatus | null;
  notice: string | null;
  errorKind: FeedbackErrorKind | null;
};

type FeedbackAction =
  | { type: "reset" }
  | { type: "resolving" }
  | { type: "ready"; destination: FeedbackDestinationStatus }
  | { type: "unavailable"; destination: FeedbackDestinationStatus }
  | { type: "sending" }
  | { type: "sent"; result: FeedbackSendResult }
  | { type: "failed"; reason: string; errorKind: FeedbackErrorKind | null }
  | { type: "edited" };

const APP_NAME = "TelegramFileServer";
const APP_DESCRIPTION =
  "A React and Rust file server with Telegram integration";
const APP_VERSION_FALLBACK = "1.0.36";
const GRAMMERS_VERSION_FALLBACK = "MTProto";
const FRONTEND_RUNTIME = "v18";
const BACKEND_RUNTIME = "2024";
const FEEDBACK_MAX_LENGTH = 2000;
const FEEDBACK_DIALOG_TRANSITION_MS = 180;

const FEEDBACK_CATEGORIES = [
  { value: "general", label: "General" },
  { value: "bug", label: "Bug Report" },
  { value: "feature", label: "Feature Request" },
  { value: "other", label: "Other" },
] as const;

const INITIAL_FEEDBACK_STATE: FeedbackState = {
  status: "idle",
  destination: null,
  notice: null,
  errorKind: null,
};

function feedbackReducer(
  state: FeedbackState,
  action: FeedbackAction,
): FeedbackState {
  switch (action.type) {
    case "reset":
      return INITIAL_FEEDBACK_STATE;
    case "resolving":
      return {
        status: "resolving",
        destination: state.destination,
        notice: "Resolving the feedback inbox...",
        errorKind: null,
      };
    case "ready":
      return {
        status: "ready",
        destination: action.destination,
        notice: null,
        errorKind: null,
      };
    case "unavailable":
      return {
        status: "unavailable",
        destination: action.destination,
        notice:
          action.destination.reason ??
          "Feedback is unavailable for this Telegram account.",
        errorKind: action.destination.errorKind ?? null,
      };
    case "sending":
      return {
        status: "sending",
        destination: state.destination,
        notice: "Sending feedback through Telegram...",
        errorKind: null,
      };
    case "sent":
      return {
        status: "sent",
        destination: state.destination,
        notice: action.result.reason ?? "Feedback sent successfully.",
        errorKind: null,
      };
    case "failed":
      return {
        status: "failed",
        destination: state.destination,
        notice: action.reason,
        errorKind: action.errorKind,
      };
    case "edited":
      if (state.destination?.available) {
        return {
          status: "ready",
          destination: state.destination,
          notice: null,
          errorKind: null,
        };
      }

      return state;
    default:
      return state;
  }
}

function mapCommandError(error: unknown): string {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return "TelegramFileServer could not talk to the server.";
}

function statusTone(status: FeedbackState): string {
  if (status.status === "sent") {
    return "border-emerald-400/20 bg-emerald-500/10 text-emerald-100";
  }

  if (status.status === "unavailable" || status.status === "failed") {
    return "border-rose-400/20 bg-rose-500/10 text-rose-100";
  }

  return "border-white/10 bg-white/6 text-white/78";
}

function feedbackStatusTitle(status: FeedbackState): string {
  switch (status.status) {
    case "resolving":
      return "Resolving destination";
    case "sending":
      return "Sending feedback";
    case "sent":
      return "Feedback sent";
    case "unavailable":
      return "Feedback unavailable";
    case "failed":
      return "Failed to send feedback";
    case "ready":
      return "Feedback";
    default:
      return "Feedback";
  }
}

export default function AboutSettingsPage() {
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  const [isFeedbackDialogMounted, setIsFeedbackDialogMounted] = useState(false);
  const [isFeedbackDialogVisible, setIsFeedbackDialogVisible] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackCategory, setFeedbackCategory] = useState<string>("general");
  const [feedbackState, dispatchFeedback] = useReducer(
    feedbackReducer,
    INITIAL_FEEDBACK_STATE,
  );
  const feedbackDialogTimerRef = useRef<number | null>(null);
  const feedbackDialogFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version || APP_VERSION_FALLBACK);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion(APP_VERSION_FALLBACK);
        }
      });

    dispatchFeedback({ type: "resolving" });

    void invoke<FeedbackDestinationStatus>("tg_feedback_resolve_destination")
      .then((destination) => {
        if (cancelled) {
          return;
        }

        if (destination.available) {
          dispatchFeedback({ type: "ready", destination });
          return;
        }

        dispatchFeedback({ type: "unavailable", destination });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        dispatchFeedback({
          type: "failed",
          reason: mapCommandError(error),
          errorKind: "telegram_error",
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackDialogFrameRef.current !== null) {
        window.cancelAnimationFrame(feedbackDialogFrameRef.current);
      }
      if (feedbackDialogTimerRef.current !== null) {
        window.clearTimeout(feedbackDialogTimerRef.current);
      }
    };
  }, []);

  const aboutFacts: AboutFact[] = [
    {
      id: "grammers",
      label: "Grammers",
      value: GRAMMERS_VERSION_FALLBACK,
      icon: Package,
    },
    {
      id: "version",
      label: "TelegramFileServer",
      value: appVersion,
      icon: Tag,
    },
    {
      id: "react",
      label: "React",
      value: FRONTEND_RUNTIME,
      icon: Monitor,
    },
    {
      id: "rust",
      label: "Rust",
      value: BACKEND_RUNTIME,
      icon: Cpu,
    },
  ];

  const feedbackMessage = feedbackText.trim();
  const feedbackLength = feedbackText.trim().length;
  const isResolving = feedbackState.status === "resolving";
  const isSending = feedbackState.status === "sending";
  const isUnavailable = feedbackState.status === "unavailable";
  const canSend =
    feedbackState.status === "ready" ||
    feedbackState.status === "sent" ||
    feedbackState.status === "failed";

  async function handleSendFeedback() {
    if (!canSend || !feedbackMessage) {
      return;
    }

    dispatchFeedback({ type: "sending" });

    try {
      const result = await invoke<FeedbackSendResult>("tg_feedback_send", {
        request: {
          message: feedbackMessage,
          category: feedbackCategory || null,
        } satisfies FeedbackSendRequest,
      });

      if (result.ok) {
        setFeedbackText("");
        dispatchFeedback({ type: "sent", result });
        return;
      }

      dispatchFeedback({
        type: "failed",
        reason: result.reason ?? "Feedback could not be sent.",
        errorKind: result.errorKind ?? null,
      });
    } catch (error) {
      dispatchFeedback({
        type: "failed",
        reason: mapCommandError(error),
        errorKind: "telegram_error",
      });
    }
  }

  function openFeedbackDialog() {
    if (feedbackDialogFrameRef.current !== null) {
      window.cancelAnimationFrame(feedbackDialogFrameRef.current);
      feedbackDialogFrameRef.current = null;
    }

    if (feedbackDialogTimerRef.current !== null) {
      window.clearTimeout(feedbackDialogTimerRef.current);
      feedbackDialogTimerRef.current = null;
    }

    setIsFeedbackDialogMounted(true);
    feedbackDialogFrameRef.current = window.requestAnimationFrame(() => {
      setIsFeedbackDialogVisible(true);
      feedbackDialogFrameRef.current = null;
    });
  }

  function closeFeedbackDialog() {
    if (isSending) {
      return;
    }

    if (feedbackDialogFrameRef.current !== null) {
      window.cancelAnimationFrame(feedbackDialogFrameRef.current);
      feedbackDialogFrameRef.current = null;
    }

    if (feedbackDialogTimerRef.current !== null) {
      window.clearTimeout(feedbackDialogTimerRef.current);
      feedbackDialogTimerRef.current = null;
    }

    setIsFeedbackDialogVisible(false);
    feedbackDialogTimerRef.current = window.setTimeout(() => {
      setIsFeedbackDialogMounted(false);
      setFeedbackText("");
      setFeedbackCategory("general");
      dispatchFeedback({ type: "edited" });
      feedbackDialogTimerRef.current = null;
    }, FEEDBACK_DIALOG_TRANSITION_MS);
  }

  return (
    <SettingsSectionLayout
      title="About"
      scrollable={false}
      containerClassName="p-0"
      contentClassName="h-full max-w-none space-y-0"
    >
      <section className="relative isolate h-full w-full overflow-hidden bg-[#040814] shadow-[0_28px_70px_rgba(0,0,0,0.42)]">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `linear-gradient(180deg, rgba(2, 6, 14, 0.2) 0%, rgba(2, 6, 14, 0.62) 58%, rgba(2, 6, 14, 0.94) 100%), url(${appBackground})`,
          }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(142,196,255,0.28),transparent_18%),linear-gradient(180deg,rgba(8,12,22,0.08)_0%,rgba(8,12,22,0.42)_42%,rgba(8,12,22,0.88)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-[linear-gradient(180deg,rgba(4,8,20,0)_0%,rgba(4,8,20,0.88)_100%)]" />

        <div className="relative flex h-full min-h-0 flex-col px-6 py-5 sm:px-8 sm:py-6 lg:px-10 lg:py-7">
          <div className="flex items-start justify-end">
            <button
              type="button"
              onClick={openFeedbackDialog}
              className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/22 px-3 py-1.5 text-sm font-medium text-white/84 backdrop-blur-md transition hover:border-white/20 hover:bg-white/8 hover:text-white"
            >
              <MessageCircle className="h-4 w-4" />
              Feedback
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 pb-1 pt-3 text-center sm:gap-5 sm:pt-4 lg:pt-6">
            <div className="relative -translate-y-36">
              <div className="absolute inset-6 rounded-full bg-[#95cfff]/25 blur-[48px]" />
              <img
                src={appIcon}
                alt="TelegramFileServer"
                className="relative mx-auto h-28 w-28 drop-shadow-[0_18px_36px_rgba(112,186,255,0.18)] sm:h-32 sm:w-32 lg:h-40 lg:w-40"
              />
            </div>

            <div className="space-y-2.5">
              <h3 className="text-3xl font-semibold tracking-[-0.05em] text-white sm:text-4xl lg:text-[3rem]">
                {APP_NAME}
              </h3>
              <p className="mx-auto max-w-2xl text-sm text-white/68 sm:text-base lg:text-lg">
                {APP_DESCRIPTION}
              </p>
            </div>

            <div className="grid w-full max-w-4xl gap-3 text-left sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">
              {aboutFacts.map((fact) => {
                const Icon = fact.icon;

                return (
                  <div
                    key={fact.id}
                    className="rounded-[20px] border border-white/12 bg-black/28 px-4 py-3.5 shadow-[0_18px_42px_rgba(0,0,0,0.22)] backdrop-blur-md"
                  >
                    <div className="flex items-center gap-3.5">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/8 bg-white/6 text-white/84 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-white/90 sm:text-sm">
                          {fact.label}
                        </p>
                        <p className="truncate text-base text-white/72 sm:text-[1.05rem]">
                          {fact.value}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {isFeedbackDialogMounted ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center px-4 py-6">
            <button
              type="button"
              aria-label="Close feedback dialog"
              className={`absolute inset-0 bg-[#02060e]/72 backdrop-blur-sm transition-opacity duration-200 ${
                isFeedbackDialogVisible ? "opacity-100" : "opacity-0"
              }`}
              onClick={closeFeedbackDialog}
            />

            <div
              className={`relative w-full max-w-xl overflow-hidden rounded-[24px] border border-white/12 bg-[#09101d]/94 shadow-[0_24px_60px_rgba(0,0,0,0.4)] backdrop-blur-xl transition-[opacity,transform] duration-200 ${
                isFeedbackDialogVisible
                  ? "translate-y-0 scale-100 opacity-100"
                  : "translate-y-3 scale-[0.985] opacity-0"
              }`}
            >
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">
                    Send Feedback
                  </h3>
                  <p className="mt-1 text-sm text-white/62">
                    Send a message to the TelegramFileServer feedback inbox through your
                    current Telegram session.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeFeedbackDialog}
                  className="rounded-full p-2 text-white/58 transition hover:bg-white/8 hover:text-white"
                  aria-label="Close feedback dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex flex-col gap-4 px-5 py-4">
                {feedbackState.status !== "ready" ? (
                  <div
                    className={`rounded-[18px] border px-4 py-3 text-sm ${statusTone(feedbackState)}`}
                  >
                    <p className="font-medium">
                      {feedbackStatusTitle(feedbackState)}
                    </p>
                    <p className="mt-1 text-[0.92rem] opacity-90">
                      {feedbackState.notice ??
                        "Only the channel owner and admins can read this feedback."}
                    </p>
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
                  <label className="space-y-2 text-left">
                    <span className="text-sm font-medium text-white/84">
                      Message
                    </span>
                    <textarea
                      value={feedbackText}
                      onChange={(event) => {
                        setFeedbackText(event.target.value);
                        dispatchFeedback({ type: "edited" });
                      }}
                      placeholder="Tell us what happened, what you expected, or what you want to improve..."
                      rows={7}
                      maxLength={FEEDBACK_MAX_LENGTH}
                      disabled={isResolving || isSending}
                      className="min-h-[176px] w-full resize-none rounded-[18px] border border-white/10 bg-white/[0.035] px-4 py-3 text-sm text-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-md outline-none transition placeholder:text-white/28 caret-white focus:border-white/20 focus:bg-white/[0.055] disabled:cursor-not-allowed disabled:opacity-70"
                    />
                    <div className="flex items-center justify-between text-xs text-white/45">
                      <span>
                        Only plain text feedback is sent. Logs and secrets are
                        never attached automatically.
                      </span>
                      <span>
                        {feedbackLength}/{FEEDBACK_MAX_LENGTH}
                      </span>
                    </div>
                  </label>

                  <label className="space-y-2 text-left">
                    <span className="text-sm font-medium text-white/84">
                      Category
                    </span>
                    <Select
                      value={feedbackCategory}
                      onValueChange={(value) => {
                        setFeedbackCategory(value);
                      }}
                      disabled={isResolving || isSending}
                    >
                      <SelectTrigger className="h-11 rounded-[14px] border-white/10 bg-white/[0.035] text-white/88 backdrop-blur-md">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {FEEDBACK_CATEGORIES.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="rounded-[16px] border border-white/10 bg-black/18 px-3 py-3 text-xs leading-5 text-white/55">
                      <span className="block">TelegramFileServer sends:</span>
                      <span className="mt-1 block">`#TFSFeedback`</span>
                      <span className="block">app version</span>
                      <span className="block">platform</span>
                      <span className="block">selected category</span>
                      <span className="block">your message body</span>
                    </div>
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-white/10 px-5 py-4">
                <TelegramButton
                  variant="secondary"
                  onClick={closeFeedbackDialog}
                  className="outline-none focus-visible:outline-none focus-visible:ring-0"
                >
                  Cancel
                </TelegramButton>
                <TelegramButton
                  variant="primary"
                  onClick={() => {
                    void handleSendFeedback();
                  }}
                  loading={isSending}
                  disabled={
                    isResolving ||
                    isUnavailable ||
                    !feedbackMessage ||
                    feedbackLength > FEEDBACK_MAX_LENGTH
                  }
                  className="outline-none focus-visible:outline-none focus-visible:ring-0"
                >
                  {feedbackState.status === "sent" ? "Sent" : "Send"}
                </TelegramButton>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </SettingsSectionLayout>
  );
}
