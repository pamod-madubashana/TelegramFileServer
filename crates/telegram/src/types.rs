//! Core data types for the Telegram transfer engine

use async_trait::async_trait;
use bytes::Bytes;
use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

/// Media type classification matching Pyrogram's dispatch logic
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType {
    /// Photo (image files)
    Photo,
    /// Video files
    Video,
    /// Audio files
    Audio,
    /// Voice messages
    Voice,
    /// Document (generic files)
    Document,
    /// Animation (GIF)
    Animation,
    /// Sticker
    Sticker,
}

impl MediaType {
    /// Determine media type from file extension (matching Pyrogram logic in files_routes.py)
    pub fn from_extension(ext: &str) -> Self {
        let ext = ext.to_lowercase();
        match ext.as_str() {
            ".gif" => MediaType::Animation,
            ".jpg" | ".jpeg" | ".png" | ".bmp" | ".webp" => MediaType::Photo,
            ".mp4" | ".avi" | ".mov" | ".wmv" | ".flv" | ".webm" => MediaType::Video,
            ".mp3" | ".wav" | ".ogg" | ".flac" | ".m4a" => MediaType::Audio,
            _ => MediaType::Document,
        }
    }
}

/// Which of a message's Telegram thumbnails to fetch.
///
/// Telegram attaches several sizes to a photo or to a video document. The
/// explorer paints a whole listing at once, so it asks for [`Low`] the moment
/// a row appears and upgrades to [`High`] in the background once the larger
/// bytes have come back and been cached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThumbnailQuality {
    /// The cheapest preview Telegram will give up, usually one it already
    /// attached to the message object (so it costs no extra download).
    Low,
    /// The largest preview Telegram is willing to serve without handing over
    /// the full file.
    High,
}

impl ThumbnailQuality {
    /// Stable name used in cache file names and query strings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::High => "high",
        }
    }
}

impl std::str::FromStr for ThumbnailQuality {
    type Err = ();

    fn from_str(raw: &str) -> std::result::Result<Self, Self::Err> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "low" | "small" | "preview" => Ok(Self::Low),
            "high" | "large" | "full" => Ok(Self::High),
            _ => Err(()),
        }
    }
}

/// Metadata returned after sending a file to Telegram
#[derive(Debug, Clone)]
pub struct SentMedia {
    /// Chat ID where the message was sent
    pub chat_id: i64,
    /// Message ID of the sent media
    pub message_id: i32,
    /// Unique file identifier (stable across sessions)
    pub file_unique_id: String,
    /// File size in bytes
    pub file_size: u64,
    /// MIME type of the file
    pub mime_type: String,
    /// Original file name
    pub file_name: String,
    /// Media type classification
    pub media_type: MediaType,
    /// File ID (for download operations)
    pub file_id: String,
    /// Thumbnail file ID if available
    pub thumbnail_id: Option<String>,
    /// DC ID where the file is stored
    pub dc_id: i32,
}

/// Range specification for chunked downloads
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadRange {
    /// Starting byte offset (inclusive)
    pub offset: u64,
    /// Number of bytes to download
    pub length: u64,
}

impl DownloadRange {
    /// Create a new download range
    pub fn new(offset: u64, length: u64) -> Self {
        Self { offset, length }
    }

    /// Create a range for the entire file
    pub fn full(file_size: u64) -> Self {
        Self {
            offset: 0,
            length: file_size,
        }
    }

    /// End offset (exclusive)
    pub fn end(&self) -> u64 {
        self.offset + self.length
    }

    /// Check if range is valid for given file size
    pub fn is_valid(&self, file_size: u64) -> bool {
        self.offset < file_size && self.end() <= file_size
    }
}

/// Configuration for the transfer engine
#[derive(Debug, Clone)]
pub struct TransferConfig {
    /// Chunk size for uploads/downloads (default: 1 MiB)
    pub chunk_size: usize,
    /// Maximum concurrent chunks (default: 4)
    pub max_concurrent_chunks: usize,
    /// Maximum retry attempts for transient errors (default: 5)
    pub max_retries: u32,
    /// Base delay for exponential backoff (default: 1 second)
    pub base_retry_delay_ms: u64,
    /// Maximum delay for exponential backoff (default: 60 seconds)
    pub max_retry_delay_ms: u64,
    /// Timeout for individual chunk operations (default: 30 seconds)
    pub chunk_timeout_ms: u64,
}

impl Default for TransferConfig {
    fn default() -> Self {
        Self {
            chunk_size: 1024 * 1024, // 1 MiB
            max_concurrent_chunks: 4,
            max_retries: 5,
            base_retry_delay_ms: 1000,
            max_retry_delay_ms: 60_000,
            chunk_timeout_ms: 30_000,
        }
    }
}

/// Progress information for transfers
#[derive(Debug, Clone, Default)]
pub struct TransferProgress {
    /// Bytes transferred so far
    pub bytes_transferred: u64,
    /// Total bytes to transfer
    pub total_bytes: u64,
    /// Current chunk index (0-based)
    pub current_chunk: usize,
    /// Total chunks
    pub total_chunks: usize,
    /// Transfer speed in bytes/second
    pub speed_bps: f64,
}

/// Cancellation token for cooperative cancellation
#[derive(Debug, Clone)]
pub struct CancellationToken {
    inner: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
    receiver: tokio::sync::watch::Receiver<bool>,
}

impl CancellationToken {
    /// Create a new cancellation token (not cancelled)
    pub fn new() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(false);
        Self {
            inner: std::sync::Arc::new(tx),
            receiver: rx,
        }
    }

    /// Create a new cancelled token
    pub fn cancelled_token() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(true);
        Self {
            inner: std::sync::Arc::new(tx),
            receiver: rx,
        }
    }

    /// Check if cancelled
    pub fn is_cancelled(&self) -> bool {
        *self.receiver.borrow()
    }

    /// Cancel the token
    pub fn cancel(&self) {
        let _ = self.inner.send(true);
    }

    /// Get a future that resolves when cancelled
    pub async fn wait_cancelled(&mut self) {
        let _ = self.receiver.changed().await;
    }

    /// Create a child token that is cancelled when parent is cancelled
    pub fn child(&self) -> Self {
        let (tx, rx) = tokio::sync::watch::channel(*self.receiver.borrow());
        let parent_rx = self.receiver.clone();
        let tx_clone = tx.clone();
        tokio::spawn(async move {
            let mut parent_rx = parent_rx;
            let _ = parent_rx.changed().await;
            let _ = tx_clone.send(true);
        });
        Self {
            inner: std::sync::Arc::new(tx),
            receiver: rx,
        }
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

/// Sink trait for receiving downloaded data
#[async_trait]
pub trait DownloadSink: Send + Sync {
    /// Write a chunk of data (async)
    async fn write_chunk(&mut self, chunk: Bytes) -> Result<(), crate::error::TelegramError>;

    /// Flush any buffered data (async)
    async fn flush(&mut self) -> Result<(), crate::error::TelegramError>;

    /// Get total bytes written
    fn bytes_written(&self) -> u64;
}

/// In-memory download sink
#[derive(Debug, Default)]
pub struct MemorySink {
    data: Vec<u8>,
}

impl MemorySink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.data
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.data
    }
}

#[async_trait]
impl DownloadSink for MemorySink {
    async fn write_chunk(&mut self, chunk: Bytes) -> Result<(), crate::error::TelegramError> {
        self.data.extend_from_slice(&chunk);
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), crate::error::TelegramError> {
        Ok(())
    }

    fn bytes_written(&self) -> u64 {
        self.data.len() as u64
    }
}

/// File download sink (async)
pub struct FileSink {
    file: File,
    bytes_written: u64,
}

impl FileSink {
    pub async fn create(path: impl Into<PathBuf>) -> Result<Self, crate::error::TelegramError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let file = File::create(&path).await?;
        Ok(Self {
            file,
            bytes_written: 0,
        })
    }
}

#[async_trait]
impl DownloadSink for FileSink {
    async fn write_chunk(&mut self, chunk: Bytes) -> Result<(), crate::error::TelegramError> {
        self.file.write_all(&chunk).await?;
        self.bytes_written += chunk.len() as u64;
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), crate::error::TelegramError> {
        self.file.flush().await?;
        Ok(())
    }

    fn bytes_written(&self) -> u64 {
        self.bytes_written
    }
}
