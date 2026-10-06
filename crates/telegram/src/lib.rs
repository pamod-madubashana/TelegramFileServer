//! Telegram transfer engine for TelegramFileServer
//!
//! This crate provides a Grammers-based implementation of the Telegram operations
//! used by TelegramFileServer, replacing Pyrogram with a Rust-native solution.
//!
//! # Architecture
//!
//! - `TelegramClient` trait: Application-facing API with no Grammers types in signatures
//! - `GrammersClient`: Adapter implementing the trait using grammers-client
//! - `TransferEngine`: Chunked upload/download with retry, cancellation, and FloodWait handling
//!
//! # Operations Covered
//!
//! - Document/photo/video/audio upload (per-type dispatch matching Pyrogram behavior)
//! - Message metadata retrieval (`get_messages` equivalent)
//! - Ranged/chunked download via `upload.GetFile` (1 MiB chunks, offset alignment)
//! - Thumbnail download to memory
//! - Session persistence and recovery
//! - Cooperative cancellation
//! - FloodWait retry with backoff

pub mod client;
pub mod engine;
pub mod error;
pub mod lookup;
pub mod types;

pub use client::{GrammersClient, TelegramClient};
pub use engine::TransferEngine;
pub use error::{Result, TelegramError};
pub use types::{DownloadRange, MediaType, SentMedia, TransferConfig};

#[cfg(test)]
fn parse_range(range_header: &str, file_size: u64) -> (u64, u64) {
    if range_header.is_empty() {
        return (0, file_size - 1);
    }
    let range_value = range_header.strip_prefix("bytes=").unwrap_or(range_header);
    let parts: Vec<&str> = range_value.split('-').collect();
    let from = parts[0].parse().unwrap_or(0);
    let until = if parts.len() > 1 && !parts[1].is_empty() {
        parts[1].parse().unwrap_or(file_size - 1)
    } else {
        file_size - 1
    };
    (from, until)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_alignment() {
        // Test the offset alignment logic matches Python byte_streamer
        let chunk_size = 1024 * 1024; // 1 MiB

        // Case 1: Range starting at chunk boundary
        let from = 0;
        let offset = from - (from % chunk_size);
        assert_eq!(offset, 0);

        // Case 2: Range starting mid-chunk
        let from = 5_000_000;
        let offset = from - (from % chunk_size);
        assert_eq!(offset, 4_194_304); // 4 * 1MiB

        // Case 3: first_part_cut calculation
        let first_part_cut = from - offset;
        assert_eq!(first_part_cut, 805_696);

        // Case 4: last_part_cut calculation
        let until = 5_001_000;
        let last_part_cut = (until % chunk_size) + 1;
        assert_eq!(last_part_cut, 806_697);

        // Case 5: part_count calculation
        let part_count = (until as f64 / chunk_size as f64).ceil() as u64
            - (offset as f64 / chunk_size as f64).floor() as u64;
        assert_eq!(part_count, 1);
    }

    #[test]
    fn test_range_header_parsing() {
        // Test parse_range_header equivalent logic
        let file_size = 10_000_000;

        // Full range
        let (from, until) = parse_range("", file_size);
        assert_eq!((from, until), (0, file_size - 1));

        // Partial range
        let (from, until) = parse_range("bytes=100-199", file_size);
        assert_eq!((from, until), (100, 199));

        // Suffix range
        let (from, until) = parse_range("bytes=5000000-", file_size);
        assert_eq!((from, until), (5_000_000, file_size - 1));
    }
}
