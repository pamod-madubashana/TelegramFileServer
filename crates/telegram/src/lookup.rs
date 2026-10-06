//! On-demand peer lookups for account ↔ Telegram username sync.
//!
//! Used by the API layer to (a) resolve the configured owner's public
//! username from `owner_id` and (b) link admin-created accounts to their
//! Telegram user id by username. No update handling — lookups only.

use grammers_client::Client;
use grammers_session::types::{PeerId, PeerKind};

use crate::error::{Result, TelegramError};

/// Resolve a Telegram user id to its public `@username` (without `@`).
///
/// Uses ambient authority (`access_hash = 0`), which Telegram validates
/// against the bot's known peers — a working setup has the owner in the
/// bot's dialog list.
///
/// Returns `Ok(None)` when the account exists but has no public username
/// (the API layer treats that as a configuration error for the owner).
pub async fn username_by_id(client: &Client, user_id: i64) -> Result<Option<String>> {
    let peer_id = PeerId::user(user_id)
        .ok_or_else(|| TelegramError::Config(format!("invalid Telegram user id: {user_id}")))?;
    let peer = client.resolve_peer(peer_id.to_ambient_ref()).await?;
    Ok(peer.username().map(str::to_string))
}

/// Resolve `username` (with or without `@`) to a Telegram user id.
///
/// Returns `Ok(None)` when the name is empty, free, unresolvable, or
/// resolves to a non-user peer (channel/group) — callers treat that as
/// "not linked yet" (best-effort sync; retry via the admin resync action).
///
/// Note: `contacts.ResolveUsername` is expensive and flood-wait prone —
/// call sparingly (admin actions only).
pub async fn id_by_username(client: &Client, username: &str) -> Result<Option<i64>> {
    let name = username.trim_start_matches('@');
    if name.is_empty() {
        return Ok(None);
    }
    match client.resolve_username(name).await? {
        Some(peer) if peer.id().kind() == PeerKind::User => Ok(peer.id().bot_api_dialog_id()),
        _ => Ok(None),
    }
}
