//! Telegram client trait and Grammers implementation

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bytes::Bytes;
use grammers_client::sender::SenderPool;
use grammers_client::{
    Client,
    client::ClientConfiguration,
    media::{Media, PhotoSize, Uploaded},
    message::{InputMessage, Message},
    tl,
};
use grammers_session::storages::SqliteSession;
use grammers_session::updates::UpdatesLike;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tracing::info;

use crate::error::{Result, TelegramError};
use crate::types::{
    CancellationToken, DownloadRange, DownloadSink, MediaType, SentMedia, ThumbnailQuality,
    TransferConfig, TransferProgress,
};

/// Application-facing Telegram client trait
///
/// This trait defines the interface for Telegram operations without exposing
/// any Grammers-specific types in its signatures. This allows the application
/// to depend on the abstraction rather than the implementation.
#[async_trait]
pub trait TelegramClient: Send + Sync {
    /// Connect to Telegram and authenticate
    async fn connect(&mut self) -> Result<()>;

    /// Disconnect from Telegram
    async fn disconnect(&mut self) -> Result<()>;

    /// Check if connected and authenticated
    fn is_connected(&self) -> bool;

    /// Send a document/file to a chat
    ///
    /// Matches Pyrogram's `send_document` with per-type dispatch logic.
    /// The media_type determines which Telegram API method is used.
    async fn send_document(
        &self,
        chat_id: i64,
        file_path: &Path,
        caption: Option<&str>,
        media_type: MediaType,
    ) -> Result<SentMedia>;

    /// Send a photo
    async fn send_photo(
        &self,
        chat_id: i64,
        file_path: &Path,
        caption: Option<&str>,
    ) -> Result<SentMedia>;

    /// Send a video
    async fn send_video(
        &self,
        chat_id: i64,
        file_path: &Path,
        caption: Option<&str>,
    ) -> Result<SentMedia>;

    /// Send an audio file
    async fn send_audio(
        &self,
        chat_id: i64,
        file_path: &Path,
        caption: Option<&str>,
    ) -> Result<SentMedia>;

    /// Get message metadata by ID (equivalent to Pyrogram's get_messages)
    async fn get_media(&self, chat_id: i64, message_id: i32) -> Result<Option<SentMedia>>;

    /// Download a file range to a sink (chunked/ranged download)
    ///
    /// This mirrors the Python byte_streamer logic:
    /// - 512 KiB chunks (grammers MAX_CHUNK_SIZE)
    /// - Offset aligned down to chunk boundary
    /// - First/last chunk partial cuts
    /// - Cooperative cancellation between chunks
    async fn download_range(
        &self,
        chat_id: i64,
        message_id: i32,
        range: DownloadRange,
        sink: &mut dyn DownloadSink,
        cancel_token: &CancellationToken,
        progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
    ) -> Result<()>;

    /// Download entire file to a sink (convenience method)
    async fn download_full(
        &self,
        chat_id: i64,
        message_id: i32,
        sink: &mut dyn DownloadSink,
        cancel_token: &CancellationToken,
        progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
    ) -> Result<()>;

    /// Download thumbnail/media to memory
    async fn download_media_to_memory(&self, file_id: &str) -> Result<Vec<u8>>;

    /// Save session to disk
    async fn save_session(&self) -> Result<()>;

    /// Get the session file path
    fn session_path(&self) -> &Path;

    /// List a page of message history from a chat, newest first.
    ///
    /// Only messages that carry media (photo/document) are returned, each
    /// paired with its caption text (if any). `offset_id` is an EXCLUSIVE
    /// upper bound: pass the latest message id + 1 to get the newest page,
    /// then subtract the page size each iteration to walk older messages.
    /// Implemented via `messages.getMessagesByIDs` because bots cannot call
    /// `messages.getHistory` (BOT_METHOD_INVALID).
    async fn list_history(
        &self,
        chat_id: i64,
        offset_id: i32,
        limit: u32,
    ) -> Result<Vec<(SentMedia, Option<String>)>>;

    /// Download a user's current profile photo (largest available size).
    ///
    /// Returns `Ok(None)` when the account has no profile photo or the
    /// photo cannot be fetched — callers should degrade gracefully rather
    /// than treat this as an error.
    async fn get_profile_photo(&self, user_id: i64) -> Result<Option<Vec<u8>>>;
}

/// Grammers-based implementation of the TelegramClient trait
pub struct GrammersClient {
    client: Option<Client>,
    config: TransferConfig,
    session_path: std::path::PathBuf,
    api_id: i32,
    api_hash: String,
    bot_token: Option<String>,
    connected: bool,
    /// Task driving the sender-pool I/O loop; quit via [`TelegramClient::disconnect`].
    runner: Option<tokio::task::JoinHandle<()>>,
    /// Thin handle used to gracefully quit the runner on disconnect.
    quit_handle: Option<grammers_client::sender::SenderPoolHandle>,
    /// Updates channel produced by the sender pool; taken by update consumers (claim listener).
    updates: Option<mpsc::UnboundedReceiver<UpdatesLike>>,
    /// Bot username learned at sign-in time (bots only; `None` for user sessions).
    bot_username: Option<String>,
    /// Cache of resolved chat_id → PeerRef carrying the real access_hash.
    /// Private channels reject ambient authority (access_hash = 0), so we
    /// resolve once via `Client::resolve_peer` and reuse the result.
    peer_cache: Mutex<HashMap<i64, grammers_session::types::PeerRef>>,
}

impl GrammersClient {
    /// Create a new GrammersClient with bot token authentication
    pub fn new_bot(
        api_id: i32,
        api_hash: String,
        bot_token: String,
        session_path: impl Into<std::path::PathBuf>,
    ) -> Self {
        Self {
            client: None,
            config: TransferConfig::default(),
            session_path: session_path.into(),
            api_id,
            api_hash,
            bot_token: Some(bot_token),
            connected: false,
            runner: None,
            quit_handle: None,
            updates: None,
            bot_username: None,
            peer_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Create a new GrammersClient with user session (string session)
    pub fn new_user(
        api_id: i32,
        api_hash: String,
        session_path: impl Into<std::path::PathBuf>,
    ) -> Self {
        Self {
            client: None,
            config: TransferConfig::default(),
            session_path: session_path.into(),
            api_id,
            api_hash,
            bot_token: None,
            connected: false,
            runner: None,
            quit_handle: None,
            updates: None,
            bot_username: None,
            peer_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Set transfer configuration
    pub fn with_config(mut self, config: TransferConfig) -> Self {
        self.config = config;
        self
    }

    /// Get the underlying Grammers client (for advanced operations)
    pub fn inner(&self) -> Option<&Client> {
        self.client.as_ref()
    }

    /// Get mutable reference to the underlying client
    pub fn inner_mut(&mut self) -> Option<&mut Client> {
        self.client.as_mut()
    }

    /// Take the updates receiver produced by the sender pool at connect time.
    ///
    /// This is a one-shot accessor: the receiver is moved out so it can be fed
    /// to [`Client::stream_updates`] (grammers requires a single sequential
    /// consumer). Returns `None` if not connected or already taken.
    pub fn take_updates(&mut self) -> Option<mpsc::UnboundedReceiver<UpdatesLike>> {
        self.updates.take()
    }

    /// The bot username learned at sign-in time, if any.
    pub fn bot_username(&self) -> Option<&str> {
        self.bot_username.as_deref()
    }

    async fn ensure_connected(&self) -> Result<&Client> {
        self.client
            .as_ref()
            .ok_or(TelegramError::Session("Client not initialized".into()))
    }

    fn extract_media_from_message(message: &Message) -> Option<Media> {
        message.media()
    }

    /// Extension Telegram's `mime` implies, when we recognise it.
    fn extension_for_mime(mime: &str) -> Option<&'static str> {
        let ext = match mime {
            "video/mp4" => "mp4",
            "video/quicktime" => "mov",
            "video/webm" => "webm",
            "video/x-matroska" => "mkv",
            "video/x-msvideo" => "avi",
            "audio/mpeg" => "mp3",
            "audio/mp4" => "m4a",
            "audio/aac" => "aac",
            "audio/ogg" => "ogg",
            "audio/wav" | "audio/x-wav" => "wav",
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => return None,
        };
        Some(ext)
    }

    /// Telegram hands over voice notes and round videos with **no filename at
    /// all**, and others extensionless (`videoplayback`). The explorer sorts
    /// files by name and classifies them by extension to decide whether to
    /// play them inline, and the OS uses the same extension to pick a player —
    /// so a nameless video ended up as a literal `unknown` row that nothing
    /// could open. Give those a stable `<stem>-<message_id>.<ext>` name; the
    /// message id keeps two nameless videos from collapsing onto one row (the
    /// VFS keys a file by owner+path+name).
    fn document_file_name(raw: &str, mime: &str, media_type: MediaType, message_id: i32) -> String {
        let trimmed = raw.trim();
        let unnamed = trimmed.is_empty() || trimmed.eq_ignore_ascii_case("unknown");
        let extensionless = unnamed || Path::new(trimmed).extension().is_none();
        if !extensionless {
            return trimmed.to_string();
        }

        let ext = Self::extension_for_mime(mime).unwrap_or(match media_type {
            MediaType::Video => "mp4",
            MediaType::Audio | MediaType::Voice => "mp3",
            MediaType::Photo => "jpg",
            _ => "bin",
        });
        let stem = if unnamed {
            match media_type {
                MediaType::Video => "video",
                MediaType::Audio | MediaType::Voice => "audio",
                MediaType::Photo => "photo",
                _ => "document",
            }
        } else {
            trimmed
        };
        format!("{stem}-{message_id}.{ext}")
    }

    /// Fetch the thumbnail attached to one message.
    ///
    /// Telegram ships several sizes with a photo or a video document. `Low`
    /// takes the cheapest one it can find - preferring bytes already embedded
    /// in the message object, which cost no extra download at all - while
    /// `High` takes the largest it will serve without handing over the whole
    /// file. Returns JPEG bytes, or `None` when the message carries no usable
    /// thumbnail.
    pub async fn download_message_thumbnail(
        &self,
        chat_id: i64,
        message_id: i32,
        quality: ThumbnailQuality,
    ) -> Result<Option<Vec<u8>>> {
        let peer = self.resolve_peer(chat_id).await?;
        let client = self.ensure_connected().await?;
        let messages = client.get_messages_by_id(peer, &[message_id]).await?;

        // A deleted or unknown id comes back as a MessageEmpty placeholder
        // rather than as nothing, so reuse the guard the history walk relies
        // on instead of mistaking the placeholder for a real message.
        let Some(Some(message)) = messages.into_iter().next() else {
            return Ok(None);
        };
        if !Self::message_exists(&message) {
            return Ok(None);
        }
        let Some(media) = Self::extract_media_from_message(&message) else {
            return Ok(None);
        };

        let thumbs = match &media {
            Media::Document(doc) => doc.thumbs(),
            Media::Photo(photo) => photo.thumbs(),
            // Stickers, polls and web previews carry art that is not a
            // listing thumbnail.
            _ => return Ok(None),
        };
        let Some(chosen) = Self::pick_thumbnail(&thumbs, quality) else {
            return Ok(None);
        };

        // `iter_download` short-circuits when the size already carries its
        // own bytes (Cached/Stripped), so the cheapest previews never reach
        // the network at all.
        let mut download = client.iter_download(chosen);
        let mut bytes = Vec::new();
        while let Some(chunk) = download.next().await? {
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok(None);
        }
        Ok(Some(bytes))
    }

    /// Choose which of a message's thumbnails to fetch.
    ///
    /// Telegram marks sizes it has dropped as `Empty`, and `Stripped`/`Path`
    /// are pseudo-sizes holding data the client is meant to decode or render
    /// itself rather than a usable grid preview.
    fn pick_thumbnail(thumbs: &[PhotoSize], quality: ThumbnailQuality) -> Option<&PhotoSize> {
        let present = |t: &&PhotoSize| !matches!(t, PhotoSize::Empty(_));

        match quality {
            ThumbnailQuality::Low => thumbs
                .iter()
                .filter(|t| present(&t))
                // Bytes already on the message object cost nothing to serve.
                .find(|t| matches!(t, PhotoSize::Cached(c) if !c.bytes.is_empty()))
                .or_else(|| {
                    thumbs
                        .iter()
                        .filter(|t| present(&t))
                        .find(|t| matches!(t, PhotoSize::Stripped(s) if !s.bytes.is_empty()))
                })
                .or_else(|| {
                    thumbs
                        .iter()
                        .filter(|t| present(&t))
                        .min_by_key(|t| t.size())
                }),
            ThumbnailQuality::High => thumbs
                .iter()
                .filter(|t| {
                    present(&t) && !matches!(t, PhotoSize::Stripped(_) | PhotoSize::Path(_))
                })
                .max_by_key(|t| t.size())
                .or_else(|| thumbs.iter().filter(|t| present(&t)).max_by_key(|t| t.size())),
        }
    }

    fn extract_sent_media(&self, message: &Message) -> Result<SentMedia> {
        let media =
            Self::extract_media_from_message(message).ok_or(TelegramError::FileNotFound {
                chat_id: message.peer_id().bot_api_dialog_id().unwrap_or(0),
                message_id: message.id(),
            })?;

        // Extract file info based on media type
        // Note: grammers 0.10 Media enum has: Photo | Document | Sticker | Contact | Poll | Geo | Dice | Venue | GeoLive | WebPage
        // Videos/audio/voice/animation are all Document variants with appropriate mime types
        let (file_id, file_unique_id, file_size, mime_type, file_name, media_type, thumbnail_id) =
            match &media {
                Media::Document(doc) => {
                    // Determine media type from mime_type and attributes
                    let mime = doc.mime_type().unwrap_or("application/octet-stream");
                    let determined_type = if mime.starts_with("video/") || doc.duration().is_some()
                    {
                        MediaType::Video
                    } else if mime.starts_with("audio/")
                        || doc.audio_title().is_some()
                        || doc.performer().is_some()
                    {
                        MediaType::Audio
                    } else {
                        MediaType::Document
                    };
                    (
                        doc.id().to_string(),
                        doc.id().to_string(), // No file_unique_id in grammers 0.10, use id as fallback
                        doc.size().unwrap_or(0) as u64,
                        mime.to_string(),
                        doc.name().unwrap_or("").to_string(),
                        determined_type,
                        doc.thumbs().first().map(|t| t.photo_type()),
                    )
                }
                Media::Photo(photo) => {
                    let thumbs = photo.thumbs();
                    let largest = thumbs.iter().max_by_key(|t| t.size()).unwrap_or(&thumbs[0]);
                    (
                        photo.id().to_string(),
                        photo.id().to_string(), // No file_unique_id for photos in grammers 0.10
                        photo.size().unwrap_or(0) as u64,
                        "image/jpeg".to_string(),
                        // Telegram photos carry no filename. Every one used
                        // to be stored as "photo.jpg", so a chat with three
                        // photos kept exactly one of them.
                        format!("photo-{}.jpg", message.id()),
                        MediaType::Photo,
                        Some(largest.photo_type()),
                    )
                }
                _ => {
                    // Sticker, Contact, Poll, Geo, Dice, Venue, GeoLive, WebPage
                    // Treat as document with minimal info
                    return Err(TelegramError::UnsupportedMediaType(format!(
                        "Unsupported media type: {:?}",
                        media
                    )));
                }
            };

        // Get DC ID from file ID (decode the packed file ID)
        let dc_id = self.extract_dc_id(&file_id).unwrap_or(0);

        // Normalise the name last: it may need the mime and media type the
        // branches above decided on.
        let file_name =
            Self::document_file_name(&file_name, &mime_type, media_type, message.id());

        Ok(SentMedia {
            chat_id: message.peer_id().bot_api_dialog_id().unwrap_or(0),
            message_id: message.id(),
            file_unique_id,
            file_size,
            mime_type,
            file_name,
            media_type,
            file_id: file_id.to_string(),
            thumbnail_id,
            dc_id,
            date: Some(message.date()),
        })
    }

    fn extract_dc_id(&self, file_id: &str) -> Option<i32> {
        // Grammers file IDs are base64 encoded packed TL objects
        // Try to decode and extract DC ID
        if let Ok(decoded) = BASE64_STANDARD.decode(file_id)
            && decoded.len() >= 4
        {
            // The DC ID is typically in the first few bytes of the packed structure
            // For document/file IDs, it's often at a specific offset
            // This is a simplified extraction - in practice you'd use grammers' PackedType
            return Some(decoded[0] as i32);
        }
        None
    }

    async fn upload_file_with_progress(
        &self,
        client: &Client,
        file_path: &Path,
        _progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
    ) -> Result<Uploaded> {
        let uploaded = client.upload_file(file_path).await?;

        Ok(uploaded)
    }

    /// Whether Telegram should receive this upload as a photo rather than a
    /// document.
    ///
    /// Only files the explorer already classifies as photos qualify, and only
    /// with an extension Telegram itself recognises as an image: a name that
    /// disagrees with the bytes is rejected outright with
    /// `PHOTO_EXT_INVALID`, which is exactly what the fallback in
    /// [`GrammersClient::send_document`] is for.
    fn as_uploaded_photo(file_path: &Path, media_type: MediaType) -> bool {
        if media_type != MediaType::Photo {
            return false;
        }
        file_path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "jpg" | "jpeg" | "png" | "webp" | "bmp"
                )
            })
    }

    /// Resolve a chat_id (Bot API dialog ID) to a PeerRef carrying the real
    /// access_hash.
    ///
    /// Ambient authority (access_hash = 0) is accepted by Telegram for users
    /// and public chats, but **private channels reject it with
    /// `CHANNEL_INVALID`** — they require the real access_hash. So we ask
    /// grammers to resolve the peer once (which fetches the access_hash from
    /// the session/RPC) and cache the result per chat_id. Any configured
    /// storage chat works; nothing is hard-coded.
    async fn resolve_peer(&self, chat_id: i64) -> Result<grammers_session::types::PeerRef> {
        if let Some(peer) = self
            .peer_cache
            .lock()
            .expect("peer cache poisoned")
            .get(&chat_id)
            .copied()
        {
            return Ok(peer);
        }

        let peer_id = grammers_session::types::PeerId::from_bot_api_dialog_id(chat_id)
            .ok_or_else(|| TelegramError::Config(format!("Invalid chat_id: {}", chat_id)))?;

        let client = self.ensure_connected().await?;
        let resolved = client.resolve_peer(peer_id.to_ambient_ref()).await?;

        // `to_ref` yields a PeerRef bound to the real access_hash (from the
        // resolved Peer's auth); fall back to the ambient ref if unavailable.
        let peer = resolved
            .to_ref()
            .await
            .map_err(|e| TelegramError::Other(format!("resolve peer {chat_id}: {e}")))?
            .unwrap_or_else(|| peer_id.to_ambient_ref());

        self.peer_cache
            .lock()
            .expect("peer cache poisoned")
            .insert(chat_id, peer);
        Ok(peer)
    }

    /// `getMessagesByIDs` answers a *missing* id with a `MessageEmpty`
    /// placeholder instead of omitting it, and grammers still wraps that
    /// placeholder in a `Message`: its `peer_id()` falls back to the peer we
    /// asked for, so it survives grammers' own peer filter. Treating those
    /// placeholders as real made every gallop probe "exist", so the bracket
    /// climbed to `i32::MAX` and the history walk spun over ~21M dead ids
    /// publishing an identical 0% progress snapshot forever.
    fn message_exists(message: &Message) -> bool {
        !matches!(message.raw, tl::enums::Message::Empty(_))
    }

    /// Find the newest message id in a chat by probing `getMessagesByIDs`
    /// (bots cannot call `messages.getHistory`). Returns 0 for an empty or
    /// inaccessible chat.
    ///
    /// Gap-tolerant: it does **not** assume message id 1 exists (deleted
    /// messages and late-joined bots leave gaps, and gating on id 1 used to
    /// silently report a non-empty chat as empty). Instead it gallops upward
    /// by powers of two to bracket the newest id, then scans that bracket
    /// downward in batches to pin the exact maximum.
    pub async fn latest_message_id(&self, chat_id: i64) -> Result<i32> {
        let client = self.ensure_connected().await?;
        let peer = self.resolve_peer(chat_id).await?;

        // Phase 1: gallop powers of two, tracking the highest id that exists.
        let mut best: i32 = 0;
        let mut step: i64 = 1;
        loop {
            let probe_id = step.min(i64::from(i32::MAX)) as i32;
            let probe = client.get_messages_by_id(peer, &[probe_id]).await?;
            if probe
                .first()
                .and_then(|m| m.as_ref())
                .is_some_and(Self::message_exists)
            {
                best = probe_id;
            }
            if step >= i64::from(i32::MAX) {
                break;
            }
            step = (step * 2).min(i64::from(i32::MAX));
        }

        if best == 0 {
            // No power-of-two id exists: the chat is either empty or its first
            // messages are a gap. Scan the low range in one batch to catch a
            // channel whose messages start just above the gap.
            let ids: Vec<i32> = (1..=200).collect();
            let res = client.get_messages_by_id(peer, &ids).await?;
            let max = res
                .iter()
                .enumerate()
                .filter(|(_, m)| m.as_ref().is_some_and(Self::message_exists))
                .map(|(i, _)| i as i32 + 1)
                .max();
            return Ok(max.unwrap_or(0));
        }

        // Phase 2: the newest id lies in `(best, min(2 * best, i32::MAX)]`.
        // Scan that bracket downward in batches (each id checked independently,
        // so gaps don't stop us) to pin the exact maximum.
        const BATCH: i32 = 100;
        let hi = best.saturating_mul(2);
        let mut id = hi;
        while id > best {
            let start = (id - BATCH + 1).max(best + 1);
            let ids: Vec<i32> = (start..=id).rev().collect();
            let res = client.get_messages_by_id(peer, &ids).await?;
            if let Some((idx, _)) = res.iter().enumerate()                .find(|(_, m)| m.as_ref().is_some_and(Self::message_exists)) {
                return Ok(ids[idx]);
            }
            id = start - 1;
        }
        Ok(best)
    }
}

#[async_trait]
impl TelegramClient for GrammersClient {
    async fn connect(&mut self) -> Result<()> {
        if self.connected {
            return Ok(());
        }

        // Load or create session using SqliteSession (file-based, persists across restarts)
        let session = if self.session_path.exists() {
            SqliteSession::open(&self.session_path)
                .await
                .map_err(|e| TelegramError::Session(format!("Failed to open session: {}", e)))?
        } else {
            // Create parent directory if needed
            if let Some(parent) = self.session_path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    TelegramError::Session(format!("Failed to create session dir: {}", e))
                })?;
            }
            SqliteSession::open(&self.session_path)
                .await
                .map_err(|e| TelegramError::Session(format!("Failed to create session: {}", e)))?
        };

        // Create SenderPool and Client. The runner must be spawned: it is the
        // single task that drives all network I/O for the pool. Dropping it
        // without spawning closes the request channel and every invoke fails
        // with InvocationError::Dropped.
        let pool = SenderPool::new(Arc::new(session), self.api_id);
        let runner = tokio::spawn(pool.runner.run());
        let client =
            Client::with_configuration(pool.handle.clone(), ClientConfiguration::default());

        // Authenticate
        if let Some(bot_token) = &self.bot_token {
            // Bot authentication
            client.bot_sign_in(bot_token, &self.api_hash).await?;

            // Learn the bot's username so callers can build t.me deep links.
            match client.get_me().await {
                Ok(me) => {
                    if let Some(username) = me.username() {
                        info!(bot_username = %username, "claim bot signed in");
                        self.bot_username = Some(username.to_string());
                    } else {
                        return Err(TelegramError::Auth(
                            "bot account has no @username; set one in @BotFather".into(),
                        ));
                    }
                }
                Err(e) => {
                    return Err(TelegramError::Other(format!(
                        "signed in but could not fetch bot identity: {}",
                        e
                    )));
                }
            }
        } else {
            // User authentication - would need phone/code or string session
            // For PoC, we only support bot token
            return Err(TelegramError::Auth(
                "User authentication not implemented in PoC".into(),
            ));
        }

        self.client = Some(client);
        self.quit_handle = Some(pool.handle.thin);
        self.updates = Some(pool.updates);
        self.runner = Some(runner);
        self.connected = true;

        // Session is auto-saved by SqliteSession
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        if let Some(client) = self.client.take() {
            // Client::disconnect sends Request::Quit through the thin handle,
            // which gracefully stops the runner task.
            client.disconnect();
        }
        if let Some(handle) = self.quit_handle.take() {
            handle.quit();
        }
        if let Some(runner) = self.runner.take() {
            // Give the runner a moment to wind down; it exits on Quit.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), runner).await;
        }
        self.updates = None;
        self.bot_username = None;
        self.connected = false;
        self.peer_cache.lock().expect("peer cache poisoned").clear();
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    async fn send_document(
        &self,
        chat_id: i64,
        file_path: &Path,
        caption: Option<&str>,
        media_type: MediaType,
    ) -> Result<SentMedia> {
        let client = self.ensure_connected().await?;

        let peer = self.resolve_peer(chat_id).await?;

        let uploaded = self
            .upload_file_with_progress(client, file_path, None)
            .await?;
        let caption = caption.unwrap_or("");

        // Images are sent as photos so Telegram attaches a thumbnail the
        // explorer can show without downloading the file. Telegram re-encodes
        // a photo upload, so anything it will not take - a mislabelled
        // extension, an image it will not decode - falls back to a document
        // and keeps its exact bytes, which is how every other type always
        // goes out anyway.
        if Self::as_uploaded_photo(file_path, media_type) {
            match client
                .send_message(peer, InputMessage::new().photo(uploaded.clone()).text(caption))
                .await
            {
                Ok(message) => {
                    let mut sent = self.extract_sent_media(&message)?;
                    // A photo message carries no filename, so
                    // `extract_sent_media` would hand back `photo-<id>.jpg`
                    // and rename the file the moment it was sent. Keep the
                    // name the uploader chose.
                    if let Some(name) = file_path.file_name().and_then(|n| n.to_str()) {
                        sent.file_name = name.to_string();
                    }
                    return Ok(sent);
                }
                Err(error) => {
                    info!(
                        path = %file_path.display(),
                        error = %error,
                        "telegram refused the photo; sending it as a document"
                    );
                }
            }
        }

        let input_message = InputMessage::new().document(uploaded).text(caption);
        let message = client.send_message(peer, input_message).await?;

        self.extract_sent_media(&message)
    }

    async fn send_photo(
        &self,
        chat_id: i64,
        file_path: &Path,
        caption: Option<&str>,
    ) -> Result<SentMedia> {
        self.send_document(chat_id, file_path, caption, MediaType::Photo)
            .await
    }

    async fn send_video(
        &self,
        chat_id: i64,
        file_path: &Path,
        caption: Option<&str>,
    ) -> Result<SentMedia> {
        self.send_document(chat_id, file_path, caption, MediaType::Video)
            .await
    }

    async fn send_audio(
        &self,
        chat_id: i64,
        file_path: &Path,
        caption: Option<&str>,
    ) -> Result<SentMedia> {
        self.send_document(chat_id, file_path, caption, MediaType::Audio)
            .await
    }

    async fn get_media(&self, chat_id: i64, message_id: i32) -> Result<Option<SentMedia>> {
        let client = self.ensure_connected().await?;

        let peer = self.resolve_peer(chat_id).await?;

        let messages = client.get_messages_by_id(peer, &[message_id]).await?;

        if let Some(Some(message)) = messages.first()
            && message.media().is_some()
        {
            return Ok(Some(self.extract_sent_media(message)?));
        }

        Ok(None)
    }

    async fn download_range(
        &self,
        chat_id: i64,
        message_id: i32,
        range: DownloadRange,
        sink: &mut dyn DownloadSink,
        cancel_token: &CancellationToken,
        progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
    ) -> Result<()> {
        let client = self.ensure_connected().await?;

        // Get message to extract file info
        let peer = self.resolve_peer(chat_id).await?;
        let messages = client.get_messages_by_id(peer, &[message_id]).await?;
        let message =
            messages
                .first()
                .and_then(|m| m.as_ref())
                .ok_or(TelegramError::FileNotFound {
                    chat_id,
                    message_id,
                })?;

        let media =
            Self::extract_media_from_message(message).ok_or(TelegramError::FileNotFound {
                chat_id,
                message_id,
            })?;

        let file_size = match &media {
            Media::Document(doc) => doc.size().unwrap_or(0) as u64,
            Media::Photo(photo) => {
                let thumbs = photo.thumbs();
                let largest = thumbs.iter().max_by_key(|t| t.size());
                largest.map(|t| t.size() as u64).unwrap_or(0)
            }
            _ => {
                return Err(TelegramError::UnsupportedMediaType(format!(
                    "Unsupported media type: {:?}",
                    media
                )));
            }
        };

        // Validate range
        if !range.is_valid(file_size) {
            return Err(TelegramError::Transfer(format!(
                "Invalid range: offset={}, length={}, file_size={}",
                range.offset, range.length, file_size
            )));
        }

        // Use grammers' ranged download API
        // MAX_CHUNK_SIZE = 512 KiB (from grammers-client files.rs)
        const CHUNK_SIZE: u64 = 512 * 1024; // 512 KiB

        let from_bytes = range.offset;
        let until_bytes = range.end() - 1; // inclusive

        let offset = from_bytes - (from_bytes % CHUNK_SIZE);
        let first_part_cut = (from_bytes - offset) as usize;
        let last_part_cut = ((until_bytes % CHUNK_SIZE) + 1) as usize;
        let part_count = ((until_bytes as f64 / CHUNK_SIZE as f64).ceil()
            - (offset as f64 / CHUNK_SIZE as f64).floor()) as u64;

        // Create download iterator with chunk size and skip chunks
        let mut download_iter = client
            .iter_download(&media)
            .chunk_size(CHUNK_SIZE as i32)
            .skip_chunks((offset / CHUNK_SIZE) as i32);

        let mut current_part = 1u64;
        let mut total_downloaded = 0u64;

        while current_part <= part_count {
            // Check cancellation
            if cancel_token.is_cancelled() {
                return Err(TelegramError::Cancelled);
            }

            let chunk_opt = download_iter.next().await?;
            let chunk_data = match chunk_opt {
                Some(data) => data,
                None => break, // End of file
            };

            // Apply cuts for first/last chunk
            let data = if part_count == 1 {
                let end = last_part_cut.min(chunk_data.len());
                if first_part_cut < end {
                    &chunk_data[first_part_cut..end]
                } else {
                    &[]
                }
            } else if current_part == 1 {
                if first_part_cut < chunk_data.len() {
                    &chunk_data[first_part_cut..]
                } else {
                    &[]
                }
            } else if current_part == part_count {
                let end = last_part_cut.min(chunk_data.len());
                &chunk_data[..end]
            } else {
                &chunk_data
            };

            if !data.is_empty() {
                sink.write_chunk(Bytes::copy_from_slice(data)).await?;
                total_downloaded += data.len() as u64;
            }

            // Report progress
            if let Some(ref cb) = progress_callback {
                cb(TransferProgress {
                    bytes_transferred: total_downloaded,
                    total_bytes: range.length,
                    current_chunk: current_part as usize,
                    total_chunks: part_count as usize,
                    speed_bps: 0.0,
                });
            }

            current_part += 1;
        }

        sink.flush().await?;
        Ok(())
    }

    async fn download_full(
        &self,
        chat_id: i64,
        message_id: i32,
        sink: &mut dyn DownloadSink,
        cancel_token: &CancellationToken,
        progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
    ) -> Result<()> {
        let client = self.ensure_connected().await?;

        let peer = self.resolve_peer(chat_id).await?;
        let messages = client.get_messages_by_id(peer, &[message_id]).await?;
        let message =
            messages
                .first()
                .and_then(|m| m.as_ref())
                .ok_or(TelegramError::FileNotFound {
                    chat_id,
                    message_id,
                })?;

        let media =
            Self::extract_media_from_message(message).ok_or(TelegramError::FileNotFound {
                chat_id,
                message_id,
            })?;

        let file_size = match &media {
            Media::Document(doc) => doc.size().unwrap_or(0) as u64,
            Media::Photo(photo) => {
                let thumbs = photo.thumbs();
                let largest = thumbs.iter().max_by_key(|t| t.size());
                largest.map(|t| t.size() as u64).unwrap_or(0)
            }
            _ => {
                return Err(TelegramError::UnsupportedMediaType(format!(
                    "Unsupported media type: {:?}",
                    media
                )));
            }
        };

        let range = DownloadRange::full(file_size);

        self.download_range(
            chat_id,
            message_id,
            range,
            sink,
            cancel_token,
            progress_callback,
        )
        .await
    }

    async fn download_media_to_memory(&self, _file_id: &str) -> Result<Vec<u8>> {
        // Grammers doesn't support downloading by file_id alone without message context
        // This is a limitation - we need chat_id and message_id to get the media
        // Return Unsupported error as documented
        Err(TelegramError::UnsupportedMediaType(
            "download_media_to_memory by file_id requires message context (chat_id, message_id). Use download_range with full range instead.".into()
        ))
    }

    async fn save_session(&self) -> Result<()> {
        // SqliteSession auto-persists on every operation
        // No explicit save needed
        Ok(())
    }

    fn session_path(&self) -> &Path {
        &self.session_path
    }

    async fn list_history(
        &self,
        chat_id: i64,
        offset_id: i32,
        limit: u32,
    ) -> Result<Vec<(SentMedia, Option<String>)>> {
        // `offset_id` is an exclusive upper bound: return up to `limit`
        // media messages with id < offset_id, newest first. Callers must
        // first learn the latest id via `latest_message_id` — bots cannot
        // call messages.getHistory (BOT_METHOD_INVALID), so we fetch a
        // fixed id-range with getMessagesByIDs instead.
        if offset_id <= 0 || limit == 0 {
            return Ok(vec![]);
        }
        let client = self.ensure_connected().await?;
        let peer = self.resolve_peer(chat_id).await?;

        let ids: Vec<i32> = (0..limit as i32)
            .map(|i| offset_id - i)
            .filter(|&id| id > 0)
            .collect();
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let messages = client.get_messages_by_id(peer, &ids).await?;

        let mut out = Vec::new();
        for message in messages.into_iter().flatten() {
            if message.media().is_none() {
                continue;
            }
            let caption = {
                let text = message.text();
                if text.is_empty() {
                    None
                } else {
                    Some(text.to_string())
                }
            };
            let sent = self.extract_sent_media(&message)?;
            out.push((sent, caption));
        }
        Ok(out)
    }

    async fn get_profile_photo(&self, user_id: i64) -> Result<Option<Vec<u8>>> {
        let client = self.ensure_connected().await?;

        let Some(peer_id) = grammers_session::types::PeerId::user(user_id) else {
            return Ok(None);
        };
        let peer = peer_id.to_ambient_ref();

        let mut photos = client.iter_profile_photos(peer);
        let Some(photo) = photos.next().await? else {
            return Ok(None);
        };

        let mut bytes = Vec::new();
        let mut download = client.iter_download(&photo);
        while let Some(chunk) = download.next().await? {
            bytes.extend_from_slice(&chunk);
            // Cap at 5 MiB — avatars are never that large; a runaway
            // download would mean something is wrong with the peer.
            if bytes.len() > 5 * 1024 * 1024 {
                break;
            }
        }
        Ok(Some(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nameless_media_gains_an_extension_and_a_message_id() {
        assert_eq!(
            GrammersClient::document_file_name("", "video/mp4", MediaType::Video, 17),
            "video-17.mp4"
        );
        assert_eq!(
            GrammersClient::document_file_name("unknown", "audio/mpeg", MediaType::Audio, 9),
            "audio-9.mp3"
        );
    }

    #[test]
    fn extensionless_names_keep_their_stem() {
        assert_eq!(
            GrammersClient::document_file_name("videoplayback", "video/mp4", MediaType::Video, 4),
            "videoplayback-4.mp4"
        );
    }

    #[test]
    fn names_that_already_have_an_extension_are_untouched() {
        assert_eq!(
            GrammersClient::document_file_name(
                "clip.mkv",
                "video/x-matroska",
                MediaType::Video,
                1
            ),
            "clip.mkv"
        );
    }

    #[test]
    fn only_images_qualified_for_a_photo_upload() {
        let image = |name: &str| {
            GrammersClient::as_uploaded_photo(std::path::Path::new(name), MediaType::Photo)
        };
        assert!(image("icon.PNG"));
        assert!(image("/tmp/photo.jpeg"));
        assert!(image("shot.webp"));
        assert!(!image("archive.zip"));
        assert!(!image("noextension"));
        // Videos and audio never take the photo path, whatever they are called.
        assert!(!GrammersClient::as_uploaded_photo(
            std::path::Path::new("clip.jpg"),
            MediaType::Video
        ));
    }
}
