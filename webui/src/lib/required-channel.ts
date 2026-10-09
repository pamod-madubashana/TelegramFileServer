export type RequiredChannelConfig = {
  chatTitle: string;
  chatId: number;
  inviteLink: string;
};

// The remote gist lookup was removed: the UI never needs a server-provided
// channel — the notification widget and title bar use this local value.
export const REQUIRED_CHANNEL_FALLBACK: RequiredChannelConfig = {
  chatTitle: "TFS Desktop",
  chatId: -1003712541671,
  inviteLink: "https://t.me/SkyBoxDesktop",
};
