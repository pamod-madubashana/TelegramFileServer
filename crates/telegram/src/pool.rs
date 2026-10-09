//! Multi-bot pool with least-busy selection and load-driven growth
//!
//! A pool starts with a single connected bot. Every transfer (upload or
//! stream) leases a bot for its duration; the lease counts as one active task.
//! When a bot is carrying more than [`ACTIVE_BOT_THRESHOLD`] tasks at once and
//! another token is configured, the next bot is connected too, so a single busy
//! transfer never becomes a bottleneck for the others.
//!
//! Growth is best-effort: a bot that fails to connect is logged and skipped,
//! and the transfer continues on the bots that are up.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::client::{GrammersClient, TelegramClient};
use crate::error::{Result, TelegramError};

/// A connected bot starts another bot once it carries this many transfers.
pub const ACTIVE_BOT_THRESHOLD: usize = 5;

/// Index of the least busy slot among the first `connected` ones.
///
/// Ties go to the lower index, which keeps the first bot as the steady-state
/// home for traffic instead of spreading it evenly by default.
fn pick_least_busy(actives: &[usize]) -> Option<usize> {
    actives
        .iter()
        .enumerate()
        .min_by_key(|(index, count)| (*count, *index))
        .map(|(index, _)| index)
}

/// Is there an unused token left, and is some bot over the growth threshold?
fn needs_growth(actives: &[usize], connected: usize, total_tokens: usize) -> bool {
    connected < total_tokens && actives.iter().any(|count| *count > ACTIVE_BOT_THRESHOLD)
}

struct Slot {
    token: String,
    session_path: PathBuf,
    /// Connected client for this slot, if it is one of the `connected` prefix.
    client: Mutex<Option<Arc<GrammersClient>>>,
    /// Transfers currently running on this bot.
    active: AtomicUsize,
}

pub struct BotPool {
    api_id: i32,
    api_hash: String,
    slots: Vec<Slot>,
    /// Slots `0..connected` hold a live client. Only ever grows.
    connected: AtomicUsize,
    /// Serialises connect decisions so two racing leases cannot both start
    /// the same next bot.
    grow_lock: Mutex<()>,
}

impl BotPool {
    /// Build a pool. No Telegram connection happens here — the first bot is
    /// brought up by the first [`BotPool::lease`].
    pub fn new(
        api_id: i32,
        api_hash: String,
        tokens: Vec<String>,
        session_dir: &Path,
    ) -> Arc<Self> {
        let slots = tokens
            .iter()
            .enumerate()
            .filter(|(_, token)| !token.trim().is_empty())
            .map(|(index, token)| Slot {
                token: token.clone(),
                session_path: session_dir.join(format!("bot-{index}.session")),
                client: Mutex::new(None),
                active: AtomicUsize::new(0),
            })
            .collect();

        Arc::new(Self {
            api_id,
            api_hash,
            slots,
            connected: AtomicUsize::new(0),
            grow_lock: Mutex::new(()),
        })
    }

    /// Number of usable bot tokens in the pool.
    pub fn token_count(&self) -> usize {
        self.slots.len()
    }

    /// Connected bot count (for status endpoints and tests).
    pub fn connected_count(&self) -> usize {
        self.connected.load(Ordering::SeqCst)
    }

    /// Take a bot for one transfer.
    ///
    /// Connects the first bot on demand, picks the least busy connected bot,
    /// and — when that bot is over [`ACTIVE_BOT_THRESHOLD`] tasks — connects
    /// the next configured token. Dropping the lease frees the task slot.
    pub async fn lease(self: &Arc<Self>) -> Result<BotLease> {
        if self.connected.load(Ordering::SeqCst) == 0 {
            let _guard = self.grow_lock.lock().await;
            self.connect_through(1).await?;
        }

        let connected = self.connected.load(Ordering::SeqCst);
        let actives = self.snapshot_actives(connected);
        let index = pick_least_busy(&actives)
            .ok_or_else(|| TelegramError::Config("no Telegram bot is connected".to_string()))?;

        // Bind the client before counting the task: a bot that cannot be
        // reached must not inflate the workload of the slot it belongs to.
        let client = self.client_of(index).await?;

        self.slots[index].active.fetch_add(1, Ordering::SeqCst);

        let actives = self.snapshot_actives(connected);
        if needs_growth(&actives, connected, self.slots.len()) {
            let _guard = self.grow_lock.lock().await;
            if let Err(e) = self.connect_through(connected + 1).await {
                warn!(
                    "could not start bot {} to spread load: {}",
                    connected + 1,
                    e
                );
            }
        }

        Ok(BotLease {
            pool: Arc::clone(self),
            index,
            client,
        })
    }

    /// Lease one specific bot instead of the least busy one.
    ///
    /// A stored file can only be read back by the bot that wrote it (private
    /// chats, or groups the other bots were never added to), so downloads pin
    /// the recorded slot and bring it up if the process restarted without it.
    pub async fn lease_slot(self: &Arc<Self>, index: usize) -> Result<BotLease> {
        if index >= self.slots.len() {
            return Err(TelegramError::Config(format!(
                "bot {} is no longer configured — the file was stored by a bot that has since been removed",
                index + 1
            )));
        }
        if self.connected.load(Ordering::SeqCst) <= index {
            let _guard = self.grow_lock.lock().await;
            self.connect_through(index + 1).await?;
        }
        let client = self.client_of(index).await?;
        self.slots[index].active.fetch_add(1, Ordering::SeqCst);
        Ok(BotLease {
            pool: Arc::clone(self),
            index,
            client,
        })
    }

    /// Connect slots up to (but not including) `target`, in order.
    ///
    /// Already-connected slots are left untouched, so calling this twice with
    /// the same target is a no-op under the grow lock.
    async fn connect_through(&self, target: usize) -> Result<()> {
        let mut connected = self.connected.load(Ordering::SeqCst);
        while connected < target && connected < self.slots.len() {
            let slot = &self.slots[connected];
            let mut client = GrammersClient::new_bot(
                self.api_id,
                self.api_hash.clone(),
                slot.token.clone(),
                slot.session_path.clone(),
            );
            client.connect().await.map_err(|e| {
                TelegramError::Config(format!("failed to connect bot {}: {}", connected + 1, e))
            })?;

            let mut guard = slot.client.lock().await;
            *guard = Some(Arc::new(client));
            drop(guard);

            connected += 1;
            self.connected.store(connected, Ordering::SeqCst);
            info!(
                "bot {} connected (session: {})",
                connected,
                slot.session_path.display()
            );
        }
        Ok(())
    }

    fn snapshot_actives(&self, connected: usize) -> Vec<usize> {
        (0..connected)
            .map(|i| self.slots[i].active.load(Ordering::SeqCst))
            .collect()
    }

    async fn client_of(&self, index: usize) -> Result<Arc<GrammersClient>> {
        let guard = self.slots[index].client.lock().await;
        guard
            .clone()
            .ok_or_else(|| TelegramError::Config(format!("bot {} is not connected", index + 1)))
    }
}

/// A leased bot. The task slot is released when the lease drops, so a stream
/// that is cancelled mid-flight still frees its workload.
pub struct BotLease {
    pool: Arc<BotPool>,
    index: usize,
    client: Arc<GrammersClient>,
}

impl BotLease {
    /// Client to run this transfer on.
    pub fn client(&self) -> Arc<GrammersClient> {
        Arc::clone(&self.client)
    }

    /// Which configured bot this is (0-based).
    pub fn index(&self) -> usize {
        self.index
    }

    /// Transfers running on this bot, including this one.
    pub fn active_tasks(&self) -> usize {
        self.pool.slots[self.index].active.load(Ordering::SeqCst)
    }
}

impl Drop for BotLease {
    fn drop(&mut self) {
        self.pool.slots[self.index]
            .active
            .fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_least_busy_and_breaks_ties_low() {
        assert_eq!(pick_least_busy(&[]), None);
        assert_eq!(pick_least_busy(&[3, 1, 2]), Some(1));
        assert_eq!(pick_least_busy(&[2, 2, 2]), Some(0));
        assert_eq!(pick_least_busy(&[5, 7]), Some(0));
    }

    #[test]
    fn grows_only_past_threshold_with_a_spare_token() {
        // Under the threshold: stay on one bot.
        assert!(!needs_growth(&[ACTIVE_BOT_THRESHOLD], 1, 3));
        // Over the threshold, spare token available: grow.
        assert!(needs_growth(&[ACTIVE_BOT_THRESHOLD + 1], 1, 3));
        // Over the threshold but every token already connected: stop.
        assert!(!needs_growth(&[ACTIVE_BOT_THRESHOLD + 1], 3, 3));
        // Idle pool never grows.
        assert!(!needs_growth(&[0], 1, 3));
    }

    #[tokio::test]
    async fn pool_starts_empty_and_reports_tokens() {
        let pool = BotPool::new(
            1,
            "hash".to_string(),
            vec!["t0".into(), "".into()],
            Path::new("."),
        );
        // The empty token is dropped, so only one usable bot remains.
        assert_eq!(pool.token_count(), 1);
        assert_eq!(pool.connected_count(), 0);
    }
}
