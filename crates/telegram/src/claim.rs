//! Telegram claim-listener: verifies account creators via `/start <secret>` deep links.
//!
//! Every new account (owner bootstrap or an invited user) is created through
//! the same flow: username → open a `https://t.me/<bot>?start=<secret>` deep
//! link → password. This module runs a dedicated bot session that watches for
//! that `/start` message and reports the Telegram user id (and username) of
//! whoever sent it, so the API layer can enforce any identity binding stored
//! on the claim and mark it verified.

use std::path::Path;

use grammers_client::{Client, client::UpdatesConfiguration, update::Update};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::client::{GrammersClient, TelegramClient};
use crate::error::{Result, TelegramError};

/// Event produced when a user sends `/start <secret>` to the claim bot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimStartEvent {
    /// Bare Telegram user id of the sender.
    pub sender_id: i64,
    /// The sender's public @username, when their profile exposes one.
    pub sender_username: Option<String>,
    /// The secret embedded in the deep link.
    pub secret: String,
}

/// Extract the claim secret from a `/start` command body.
///
/// Accepts `/start <secret>` and `/start@BotUsername <secret>`. Returns the
/// secret (everything after the command), or `None` if the text is not a
/// `/start` command or carries no payload.
pub fn parse_start_secret(text: &str) -> Option<&str> {
    let text = text.trim();
    let rest = text.strip_prefix("/start")?;
    let rest = if rest.is_empty() {
        return None;
    } else if rest.starts_with('@') {
        // /start@BotUsername <secret> — skip past the bot-qualified command token.
        let end = rest.find(char::is_whitespace)?;
        &rest[end..]
    } else if rest.starts_with(char::is_whitespace) {
        rest
    } else {
        // e.g. "/starting" — not the /start command.
        return None;
    };
    let secret = rest.trim();
    if secret.is_empty() {
        None
    } else {
        Some(secret)
    }
}

/// A connected claim bot: a single bot session streaming incoming messages.
pub struct ClaimBot {
    client: GrammersClient,
    inner: Client,
    updates: mpsc::UnboundedReceiver<grammers_session::updates::UpdatesLike>,
    bot_username: String,
}

impl ClaimBot {
    /// Connect and sign in the claim bot on a dedicated session file.
    ///
    /// The session must not be shared with the transfer [`crate::pool::BotPool`]:
    /// grammers sessions are not safe to share across pools.
    pub async fn connect(
        api_id: i32,
        api_hash: String,
        bot_token: String,
        session_path: impl Into<std::path::PathBuf>,
    ) -> Result<Self> {
        let mut client = GrammersClient::new_bot(api_id, api_hash, bot_token, session_path);
        client.connect().await?;
        let inner = client
            .inner()
            .cloned()
            .ok_or_else(|| TelegramError::Session("client vanished after connect".into()))?;
        let updates = client.take_updates().ok_or_else(|| {
            TelegramError::Session("updates channel missing after connect".into())
        })?;
        let bot_username = client
            .bot_username()
            .ok_or_else(|| TelegramError::Auth("claim bot has no username".into()))?
            .to_string();
        Ok(Self {
            client,
            inner,
            updates,
            bot_username,
        })
    }

    /// The bot's @username (without the leading `@`).
    pub fn bot_username(&self) -> &str {
        &self.bot_username
    }

    /// Stream incoming messages until the connection drops.
    ///
    /// `on_start` is invoked for every `/start <secret>` message from a user;
    /// its return value is sent back as the reply (best-effort).
    pub async fn run(
        mut self,
        on_start: impl Fn(ClaimStartEvent) -> String + Send + Sync,
    ) -> Result<()> {
        let mut stream = self
            .inner
            .stream_updates(self.updates, UpdatesConfiguration::default())
            .await
            .map_err(|e| TelegramError::Other(format!("update stream failed: {e}")))?;

        loop {
            let update = match stream.next().await {
                Ok(update) => update,
                Err(e) => {
                    warn!(error = %e, "claim bot update stream ended");
                    // Shut the pool runner down so a reconnect does not leak it.
                    let _ = self.client.disconnect().await;
                    return Err(e.into());
                }
            };

            let Update::NewMessage(msg) = update else {
                continue;
            };
            if msg.outgoing() {
                continue;
            }
            let Some(sender) = msg.sender() else {
                continue;
            };
            let grammers_client::peer::Peer::User(user) = sender else {
                continue;
            };
            let Some(sender_id) = user.id().bare_id() else {
                continue;
            };
            let Some(secret) = parse_start_secret(msg.text()) else {
                debug!(sender_id, "ignoring non-claim message");
                continue;
            };

            let event = ClaimStartEvent {
                sender_id,
                sender_username: user.username().map(str::to_owned),
                secret: secret.to_string(),
            };
            debug!(sender_id, secret = %event.secret, "claim /start received");
            let reply = on_start(event);
            if let Err(e) = self
                .inner
                .send_message(msg.peer_id().to_ambient_ref(), reply)
                .await
            {
                warn!(error = %e, "failed to reply to claim /start");
            }
        }
    }
}

/// Path of the dedicated claim-bot session file inside the session directory.
pub fn claim_bot_session_path(session_dir: &Path) -> std::path::PathBuf {
    session_dir.join("claim-bot.session")
}

#[cfg(test)]
mod tests {
    use super::parse_start_secret;

    #[test]
    fn parses_plain_start_secret() {
        assert_eq!(parse_start_secret("/start abc123"), Some("abc123"));
        assert_eq!(parse_start_secret("  /start   spaced  "), Some("spaced"));
    }

    #[test]
    fn parses_bot_qualified_start() {
        assert_eq!(
            parse_start_secret("/start@MyFileBot abc123"),
            Some("abc123")
        );
    }

    #[test]
    fn rejects_non_start_and_bare_start() {
        assert_eq!(parse_start_secret("/help abc"), None);
        assert_eq!(parse_start_secret("start abc"), None);
        assert_eq!(parse_start_secret("/starting abc"), None);
        assert_eq!(parse_start_secret("/start"), None);
        assert_eq!(parse_start_secret("/start@MyFileBot"), None);
        assert_eq!(parse_start_secret(""), None);
    }
}
