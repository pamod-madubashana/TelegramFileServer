//! On-disk cache of Telegram message thumbnails.
//!
//! The explorer paints a whole listing at once, so a cold page asks for
//! dozens of thumbnails in the same instant. Every one of them is fetched
//! from Telegram at most once: the bytes land in the data directory as
//! `<message_id>-<quality>.jpg`, and every later request - this process or
//! the next one - reads the file instead of going back to Telegram.
//!
//! Two tiers are kept side by side. `low` is the cheap preview the grid
//! paints the moment a row appears; `high` is fetched once in the background
//! and swapped in when it lands.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use tfs_telegram::{GrammersClient, ThumbnailQuality};
use tokio::{io::AsyncWriteExt, sync::Semaphore};

/// How many Telegram thumbnail downloads may run at once.
///
/// A cold listing outruns Telegram's appetite for parallel `upload.getFile`
/// calls by a wide margin, and the thumbnails it wants are the same ones
/// every other request is waiting on.
const MAX_CONCURRENT_FETCHES: usize = 4;

pub(crate) struct ThumbnailCache {
    root: PathBuf,
    fetches: Semaphore,
    /// One in-flight download per (message, quality): the first request pays
    /// for the Telegram round trip and its waiters share the result.
    keys: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// (message, quality) pairs Telegram answered with nothing, so a listing
    /// does not re-ask for a thumbnail that does not exist.
    missing: Mutex<HashSet<String>>,
}

impl ThumbnailCache {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            fetches: Semaphore::new(MAX_CONCURRENT_FETCHES),
            keys: Mutex::new(HashMap::new()),
            missing: Mutex::new(HashSet::new()),
        }
    }

    /// Process-wide cache rooted in the platform data directory.
    ///
    /// Built once: the root never moves, and the rest is nothing but locks.
    pub(crate) fn global() -> &'static ThumbnailCache {
        static CACHE: OnceLock<ThumbnailCache> = OnceLock::new();
        CACHE.get_or_init(|| ThumbnailCache::new(tfs_config::get_thumbnail_dir()))
    }

    /// Cached bytes, fetched from Telegram on a miss.
    ///
    /// Returns `None` when the message has no thumbnail of that quality, or
    /// when Telegram could not be reached: the caller answers 404 and the
    /// frontend falls back to an icon.
    pub(crate) async fn get_or_fetch(
        &self,
        client: &GrammersClient,
        chat_id: i64,
        message_id: i32,
        quality: ThumbnailQuality,
    ) -> Option<Vec<u8>> {
        if let Some(bytes) = self.read(message_id, quality).await {
            return Some(bytes);
        }

        let key = Self::key(message_id, quality);
        if self.is_known_missing(&key) {
            return None;
        }

        let lock = self.key_lock(key.clone());
        let _serialise = lock.lock().await;

        // Another request may have filled the cache while we queued.
        if let Some(bytes) = self.read(message_id, quality).await {
            return Some(bytes);
        }

        let _permit = self.fetches.acquire().await.ok()?;
        let fetched = client
            .download_message_thumbnail(chat_id, message_id, quality)
            .await;

        let bytes = match fetched {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                self.remember_missing(&key);
                return None;
            }
            // A Telegram hiccup costs this one request; it must not poison
            // the thumbnail for the rest of the session.
            Err(error) => {
                tracing::warn!(
                    message_id,
                    quality = quality.as_str(),
                    %error,
                    "thumbnail fetch failed"
                );
                return None;
            }
        };

        self.store(message_id, quality, &bytes).await?;
        Some(bytes)
    }

    async fn read(&self, message_id: i32, quality: ThumbnailQuality) -> Option<Vec<u8>> {
        tokio::fs::read(self.path_for(message_id, quality)).await.ok()
    }

    /// Write beside the final name and rename into place, so a concurrent
    /// reader never sees a half-written thumbnail.
    async fn store(&self, message_id: i32, quality: ThumbnailQuality, bytes: &[u8]) -> Option<()> {
        tokio::fs::create_dir_all(&self.root).await.ok()?;
        let target = self.path_for(message_id, quality);
        let temp = target.with_extension("part");
        {
            let mut file = tokio::fs::File::create(&temp).await.ok()?;
            file.write_all(bytes).await.ok()?;
            file.flush().await.ok()?;
        }
        tokio::fs::rename(&temp, &target).await.ok()?;
        Some(())
    }

    fn path_for(&self, message_id: i32, quality: ThumbnailQuality) -> PathBuf {
        self.root.join(format!("{message_id}-{}.jpg", quality.as_str()))
    }

    fn key(message_id: i32, quality: ThumbnailQuality) -> String {
        format!("{message_id}-{}", quality.as_str())
    }

    fn key_lock(&self, key: String) -> Arc<tokio::sync::Mutex<()>> {
        self.keys
            .lock()
            .expect("thumbnail key map poisoned")
            .entry(key)
            .or_default()
            .clone()
    }

    fn is_known_missing(&self, key: &str) -> bool {
        self.missing
            .lock()
            .expect("thumbnail miss set poisoned")
            .contains(key)
    }

    fn remember_missing(&self, key: &str) {
        self.missing
            .lock()
            .expect("thumbnail miss set poisoned")
            .insert(key.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_tiers_get_distinct_cache_files() {
        let cache = ThumbnailCache::new(PathBuf::from("/cache"));
        assert_eq!(cache.path_for(17, ThumbnailQuality::Low), PathBuf::from("/cache/17-low.jpg"));
        assert_eq!(cache.path_for(17, ThumbnailQuality::High), PathBuf::from("/cache/17-high.jpg"));
    }

    #[tokio::test]
    async fn an_uncached_thumbnail_reads_as_missing() {
        let cache = ThumbnailCache::new(std::env::temp_dir().join("tfs-thumb-absent"));
        assert!(cache.read(1, ThumbnailQuality::Low).await.is_none());
    }

    #[tokio::test]
    async fn stored_thumbnails_come_back_byte_for_byte() {
        let root = std::env::temp_dir().join("tfs-thumb-roundtrip");
        let cache = ThumbnailCache::new(root);
        cache
            .store(9, ThumbnailQuality::High, b"\xff\xd8jpeg")
            .await
            .expect("store");
        assert_eq!(
            cache.read(9, ThumbnailQuality::High).await.as_deref(),
            Some(b"\xff\xd8jpeg".as_slice())
        );
        // The temporary file never survives a successful store.
        assert!(!cache.path_for(9, ThumbnailQuality::High).with_extension("part").exists());
    }

    #[tokio::test]
    async fn a_negative_answer_is_remembered() {
        let cache = ThumbnailCache::new(std::env::temp_dir().join("tfs-thumb-miss"));
        let key = ThumbnailCache::key(4, ThumbnailQuality::Low);
        assert!(!cache.is_known_missing(&key));
        cache.remember_missing(&key);
        assert!(cache.is_known_missing(&key));
    }
}
