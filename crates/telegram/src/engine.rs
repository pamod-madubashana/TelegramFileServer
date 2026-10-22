//! Transfer engine for chunked uploads/downloads with retry and cancellation

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{info, warn};

use crate::client::TelegramClient;
use crate::error::{Result, TelegramError};
use crate::types::{
    CancellationToken, DownloadRange, DownloadSink, MediaType, SentMedia, TransferConfig,
    TransferProgress,
};

/// High-level transfer engine providing upload/download with retry, progress, and cancellation
pub struct TransferEngine<C: TelegramClient> {
    client: Arc<C>,
    config: TransferConfig,
}

impl<C: TelegramClient> TransferEngine<C> {
    /// Create a new transfer engine
    pub fn new(client: Arc<C>, config: TransferConfig) -> Self {
        Self { client, config }
    }

    /// Create with default config
    pub fn with_default_config(client: Arc<C>) -> Self {
        Self::new(client, TransferConfig::default())
    }

    /// Upload a file with progress tracking and cancellation support
    pub async fn upload_file(
        &self,
        chat_id: i64,
        file_path: impl AsRef<Path>,
        caption: Option<&str>,
        media_type: MediaType,
        cancel_token: &CancellationToken,
        _progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
    ) -> Result<SentMedia> {
        let file_path = file_path.as_ref();
        let file_size = tokio::fs::metadata(file_path).await?.len();

        info!(
            "Starting upload: {} ({} bytes)",
            file_path.display(),
            file_size
        );

        // Wrap the upload with retry logic
        let result = self
            .retry_with_backoff(|| async {
                // Check cancellation
                if cancel_token.is_cancelled() {
                    return Err(TelegramError::Cancelled);
                }

                self.client
                    .send_document(chat_id, file_path, caption, media_type)
                    .await
            })
            .await;

        match result {
            Ok(media) => {
                info!(
                    "Upload completed: message_id={}, file_unique_id={}",
                    media.message_id, media.file_unique_id
                );
                Ok(media)
            }
            Err(e) => {
                // Cleanup on failure if needed
                Err(e)
            }
        }
    }

    /// Download a file range with progress and cancellation
    pub async fn download_range(
        &self,
        chat_id: i64,
        message_id: i32,
        range: DownloadRange,
        sink: &mut dyn DownloadSink,
        cancel_token: &CancellationToken,
        progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
    ) -> Result<()> {
        info!(
            "Starting ranged download: chat_id={}, message_id={}, offset={}, len={}",
            chat_id, message_id, range.offset, range.length
        );

        self.client
            .download_range(
                chat_id,
                message_id,
                range,
                sink,
                cancel_token,
                progress_callback,
            )
            .await
    }

    /// Download entire file
    pub async fn download_full(
        &self,
        chat_id: i64,
        message_id: i32,
        sink: &mut dyn DownloadSink,
        cancel_token: &CancellationToken,
        progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
    ) -> Result<()> {
        info!(
            "Starting full download: chat_id={}, message_id={}",
            chat_id, message_id
        );

        self.client
            .download_full(chat_id, message_id, sink, cancel_token, progress_callback)
            .await
    }

    /// Get file metadata
    pub async fn get_media(&self, chat_id: i64, message_id: i32) -> Result<Option<SentMedia>> {
        self.client.get_media(chat_id, message_id).await
    }

    /// Download thumbnail to memory
    pub async fn download_thumbnail(&self, file_id: &str) -> Result<Vec<u8>> {
        self.client.download_media_to_memory(file_id).await
    }

    /// Retry an operation with exponential backoff and FloodWait handling
    async fn retry_with_backoff<F, Fut, T>(&self, mut operation: F) -> Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let mut attempt = 0;
        let mut delay = Duration::from_millis(self.config.base_retry_delay_ms);
        let max_delay = Duration::from_millis(self.config.max_retry_delay_ms);

        loop {
            match operation().await {
                Ok(result) => return Ok(result),
                Err(e) if e.is_retryable() && attempt < self.config.max_retries => {
                    attempt += 1;

                    // Handle FloodWait specifically
                    if let Some(seconds) = e.flood_wait_seconds() {
                        warn!(
                            "FloodWait encountered (attempt {}/{}): waiting {} seconds",
                            attempt, self.config.max_retries, seconds
                        );
                        sleep(Duration::from_secs(seconds as u64)).await;
                        delay = Duration::from_millis(self.config.base_retry_delay_ms); // Reset delay after FloodWait
                        continue;
                    }

                    warn!(
                        "Retryable error (attempt {}/{}): {}. Waiting {:?}",
                        attempt, self.config.max_retries, e, delay
                    );
                    sleep(delay).await;

                    // Exponential backoff with jitter
                    delay = std::cmp::min(delay * 2, max_delay);
                    // Add jitter (±25%)
                    let jitter = delay.as_millis() as u64 / 4;
                    let jitter = fastrand::u64(0..=jitter);
                    delay += Duration::from_millis(jitter);
                }
                Err(e) => return Err(e),
            }
        }
    }
}

/// Convenience function to create a transfer engine with a GrammersClient
pub fn create_engine(
    client: Arc<impl TelegramClient + 'static>,
    config: Option<TransferConfig>,
) -> TransferEngine<impl TelegramClient> {
    TransferEngine::new(client, config.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::TelegramError;
    use crate::types::{CancellationToken, DownloadRange, MediaType, MemorySink};
    use std::sync::Arc;

    // Mock client for testing
    struct MockClient {
        should_fail: bool,
        fail_count: std::sync::atomic::AtomicU32,
        max_fails: u32,
    }

    #[async_trait::async_trait]
    impl TelegramClient for MockClient {
        async fn connect(&mut self) -> Result<()> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<()> {
            Ok(())
        }
        fn is_connected(&self) -> bool {
            true
        }

        async fn send_document(
            &self,
            _chat_id: i64,
            _file_path: &Path,
            _caption: Option<&str>,
            _media_type: MediaType,
        ) -> Result<SentMedia> {
            if self.should_fail {
                let count = self
                    .fail_count
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if count < self.max_fails {
                    return Err(TelegramError::Network(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "Simulated network error",
                    )));
                }
            }
            Ok(SentMedia {
                chat_id: 123,
                message_id: 456,
                file_unique_id: "test_unique_id".into(),
                file_size: 1000,
                mime_type: "application/octet-stream".into(),
                file_name: "test.bin".into(),
                media_type: MediaType::Document,
                file_id: "test_file_id".into(),
                thumbnail_id: None,
                dc_id: 1,
                date: None,
            })
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

        async fn get_media(&self, _chat_id: i64, _message_id: i32) -> Result<Option<SentMedia>> {
            Ok(None)
        }

        async fn download_range(
            &self,
            _chat_id: i64,
            _message_id: i32,
            range: DownloadRange,
            sink: &mut dyn DownloadSink,
            cancel_token: &CancellationToken,
            _progress_callback: Option<Box<dyn Fn(TransferProgress) + Send + Sync>>,
        ) -> Result<()> {
            if cancel_token.is_cancelled() {
                return Err(TelegramError::Cancelled);
            }
            // Write dummy data
            let data = vec![0x42; range.length as usize];
            sink.write_chunk(bytes::Bytes::from(data)).await?;
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
            self.download_range(
                chat_id,
                message_id,
                DownloadRange::full(1000),
                sink,
                cancel_token,
                progress_callback,
            )
            .await
        }

        async fn download_media_to_memory(&self, _file_id: &str) -> Result<Vec<u8>> {
            Ok(vec![0x42; 100])
        }

        async fn save_session(&self) -> Result<()> {
            Ok(())
        }
        fn session_path(&self) -> &Path {
            Path::new("test.session")
        }

        async fn list_history(
            &self,
            _chat_id: i64,
            _offset_id: i32,
            _limit: u32,
        ) -> Result<Vec<(SentMedia, Option<String>)>> {
            Ok(vec![])
        }

        async fn get_profile_photo(&self, _user_id: i64) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn test_upload_success() {
        let client = Arc::new(MockClient {
            should_fail: false,
            fail_count: std::sync::atomic::AtomicU32::new(0),
            max_fails: 0,
        });
        let engine = TransferEngine::with_default_config(client);
        let cancel_token = CancellationToken::new();

        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("test.bin");
        tokio::fs::write(&file_path, b"test data").await.unwrap();

        let result = engine
            .upload_file(
                123,
                &file_path,
                Some("test"),
                MediaType::Document,
                &cancel_token,
                None,
            )
            .await;

        assert!(result.is_ok());
        let media = result.unwrap();
        assert_eq!(media.file_unique_id, "test_unique_id");
    }

    #[tokio::test]
    async fn test_upload_retry_success() {
        let client = Arc::new(MockClient {
            should_fail: true,
            fail_count: std::sync::atomic::AtomicU32::new(0),
            max_fails: 2, // Fail twice, then succeed
        });
        let engine = TransferEngine::new(
            client.clone(),
            TransferConfig {
                max_retries: 3,
                base_retry_delay_ms: 10,
                max_retry_delay_ms: 100,
                ..Default::default()
            },
        );
        let cancel_token = CancellationToken::new();

        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("test.bin");
        tokio::fs::write(&file_path, b"test data").await.unwrap();

        let result = engine
            .upload_file(
                123,
                &file_path,
                Some("test"),
                MediaType::Document,
                &cancel_token,
                None,
            )
            .await;

        assert!(result.is_ok());
        // fetch_add returns previous value, so after 2 failures + 1 success = 3 total calls
        assert_eq!(
            client.fail_count.load(std::sync::atomic::Ordering::SeqCst),
            3
        );
    }

    #[tokio::test]
    async fn test_upload_max_retries_exceeded() {
        let client = Arc::new(MockClient {
            should_fail: true,
            fail_count: std::sync::atomic::AtomicU32::new(0),
            max_fails: 10, // Always fail
        });
        let engine = TransferEngine::new(
            client.clone(),
            TransferConfig {
                max_retries: 3,
                base_retry_delay_ms: 10,
                max_retry_delay_ms: 100,
                ..Default::default()
            },
        );
        let cancel_token = CancellationToken::new();

        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("test.bin");
        tokio::fs::write(&file_path, b"test data").await.unwrap();

        let result = engine
            .upload_file(
                123,
                &file_path,
                Some("test"),
                MediaType::Document,
                &cancel_token,
                None,
            )
            .await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), TelegramError::Network(_)));
    }

    #[tokio::test]
    async fn test_download_range() {
        let client = Arc::new(MockClient {
            should_fail: false,
            fail_count: std::sync::atomic::AtomicU32::new(0),
            max_fails: 0,
        });
        let engine = TransferEngine::with_default_config(client);
        let cancel_token = CancellationToken::new();
        let mut sink = MemorySink::new();

        let result = engine
            .download_range(
                123,
                456,
                DownloadRange::new(100, 500),
                &mut sink,
                &cancel_token,
                None,
            )
            .await;

        assert!(result.is_ok());
        assert_eq!(sink.bytes_written(), 500);
    }

    #[tokio::test]
    async fn test_cancellation() {
        let client = Arc::new(MockClient {
            should_fail: false,
            fail_count: std::sync::atomic::AtomicU32::new(0),
            max_fails: 0,
        });
        let engine = TransferEngine::with_default_config(client);
        let cancel_token = CancellationToken::new();
        let mut sink = MemorySink::new();

        // Cancel immediately
        cancel_token.cancel();

        let result = engine
            .download_range(
                123,
                456,
                DownloadRange::new(0, 1000),
                &mut sink,
                &cancel_token,
                None,
            )
            .await;

        assert!(matches!(result, Err(TelegramError::Cancelled)));
    }
}
