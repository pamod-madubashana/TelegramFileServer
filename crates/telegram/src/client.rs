//! Telegram client trait and Grammers implementation

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bytes::Bytes;
use grammers_client::sender::SenderPool;
use grammers_client::{
    Client,
    client::ClientConfiguration,
    media::{Media, Uploaded},
    message::{InputMessage, Message},
};
use grammers_session::storages::SqliteSession;
use grammers_session::updates::UpdatesLike;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::info;

use crate::error::{Result, TelegramError};
use crate::types::{
    CancellationToken, DownloadRange, DownloadSink, MediaType, SentMedia, TransferConfig,
    TransferProgress,
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
                        doc.name().unwrap_or("unknown").to_string(),
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
                        "photo.jpg".to_string(),
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

    fn build_input_message(
        &self,
        uploaded: Uploaded,
        caption: Option<&str>,
        media_type: MediaType,
    ) -> InputMessage {
        let caption = caption.unwrap_or("");
        match media_type {
            MediaType::Photo => InputMessage::new().photo(uploaded).text(caption),
            // Video, Audio, Voice, Animation, Sticker are all sent as documents in grammers 0.10
            MediaType::Video
            | MediaType::Audio
            | MediaType::Voice
            | MediaType::Animation
            | MediaType::Document
            | MediaType::Sticker => InputMessage::new().document(uploaded).text(caption),
        }
    }

    /// Resolve a chat_id (Bot API dialog ID) to a PeerRef with ambient authority
    fn resolve_peer(&self, chat_id: i64) -> Result<grammers_session::types::PeerRef> {
        let peer_id = grammers_session::types::PeerId::from_bot_api_dialog_id(chat_id)
            .ok_or_else(|| TelegramError::Config(format!("Invalid chat_id: {}", chat_id)))?;
        Ok(peer_id.to_ambient_ref())
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

        let peer = self.resolve_peer(chat_id)?;

        let uploaded = self
            .upload_file_with_progress(client, file_path, None)
            .await?;
        let input_message = self.build_input_message(uploaded, caption, media_type);

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

        let peer = self.resolve_peer(chat_id)?;

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
        let peer = self.resolve_peer(chat_id)?;
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

        let peer = self.resolve_peer(chat_id)?;
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
}
