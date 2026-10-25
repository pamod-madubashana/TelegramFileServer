//! Stored file records (`v2_files`) plus the shared media-serving helpers
//! behind `/dl/{file_name}` (attachment) and `/watch/{file_name}` (inline).

use async_trait::async_trait;
use axum::http::HeaderMap;
use bytes::Bytes;
use mongodb::{Collection, bson::doc};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tfs_telegram::{CancellationToken, DownloadSink, TelegramError};
use tokio::sync::mpsc;

use crate::{ApiError, DbError, SessionStore, data_database_name, validate_session};

/// Telegram's upload transport limit, as imposed by the MTProto part model
/// the transfer engine uses: at most 4000 parts of 512 KiB each (grammers'
/// fixed part size), so no file larger than that can be stored.
pub(crate) const TELEGRAM_PART_SIZE_BYTES: u64 = 512 * 1024;
pub(crate) const TELEGRAM_MAX_PARTS: u64 = 4000;
pub(crate) const MAX_UPLOAD_BYTES: u64 = TELEGRAM_MAX_PARTS * TELEGRAM_PART_SIZE_BYTES;

/// Reject uploads Telegram cannot store, before a bot is leased and any
/// bytes travel.
///
/// Both bounds surface remotely as the same opaque RPC error
/// (`400 FILE_PARTS_INVALID`): a zero-byte file produces a zero-part upload,
/// and anything over 4000 × 512 KiB exceeds the part-count limit. Failing
/// here turns that into an actionable message instead.
pub(crate) fn validate_upload_size(size: u64) -> Result<(), ApiError> {
    if size == 0 {
        return Err(ApiError::Validation(
            "empty files cannot be uploaded — Telegram cannot store zero-byte files".to_string(),
        ));
    }
    if size > MAX_UPLOAD_BYTES {
        return Err(ApiError::Validation(format!(
            "file is {} bytes; Telegram's upload limit is {} bytes (4000 parts × 512 KiB)",
            size, MAX_UPLOAD_BYTES
        )));
    }
    Ok(())
}

/// One file stored in Telegram, owned by the account that uploaded it.
///
/// The `_id` is derived from owner + destination + name, so a name collision
/// inside a folder is a duplicate key error rather than two rows that `/dl`
/// would then have to guess between.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FileDoc {
    #[serde(rename = "_id")]
    pub(crate) id: String,
    /// Owning account id (lowercased username).
    pub(crate) owner_id: String,
    pub(crate) file_name: String,
    /// Destination folder, e.g. `/` or `/Home/Images`.
    pub(crate) file_path: String,
    pub(crate) chat_id: i64,
    pub(crate) message_id: i32,
    pub(crate) file_unique_id: String,
    /// Telegram `file_id`, used for thumbnails.
    pub(crate) file_id: String,
    /// Bytes — i64 because BSON has no unsigned integers.
    pub(crate) file_size: i64,
    pub(crate) mime_type: String,
    /// `MediaType` name (`document`, `video`, …).
    pub(crate) media_type: String,
    #[serde(default)]
    pub(crate) thumbnail_id: Option<String>,
    pub(crate) dc_id: i32,
    /// Pool slot of the bot that stored this file.
    ///
    /// Only that bot can read the message back: the file may live in a
    /// private chat with it, or a group the other bots were never added to.
    /// Records written before multi-bot support existed default to slot 0.
    #[serde(default)]
    pub(crate) bot_index: i32,
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
    /// Caption from the Telegram message (surfaced in the explorer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) caption: Option<String>,
    /// Set while the file sits in the recycle bin: the full path it came
    /// from, so restore puts it back exactly there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) original_path: Option<String>,
}

impl FileDoc {
    pub(crate) const COLLECTION_NAME: &'static str = "v2_files";

    pub(crate) fn id_for(owner_id: &str, file_path: &str, file_name: &str) -> String {
        format!("{}:{}:{}", owner_id, file_path, file_name)
    }

    /// Build a record from the message Telegram just accepted.
    ///
    /// MIME is taken from Telegram when it actually probed the file, and
    /// otherwise guessed from the name — Telegram answers
    /// `application/octet-stream` for anything it did not inspect.
    pub(crate) fn new(
        owner_id: &str,
        file_path: &str,
        file_name: &str,
        file_size: u64,
        sent: &tfs_telegram::SentMedia,
        bot_index: i32,
    ) -> Self {
        let mime_type = if sent.mime_type.is_empty() || sent.mime_type == "application/octet-stream"
        {
            guess_mime(file_name)
        } else {
            sent.mime_type.clone()
        };
        Self {
            id: Self::id_for(owner_id, file_path, file_name),
            owner_id: owner_id.to_string(),
            file_name: file_name.to_string(),
            file_path: file_path.to_string(),
            chat_id: sent.chat_id,
            message_id: sent.message_id,
            file_unique_id: sent.file_unique_id.clone(),
            file_id: sent.file_id.clone(),
            file_size: i64::try_from(file_size).unwrap_or(i64::MAX),
            mime_type,
            media_type: format!("{:?}", sent.media_type).to_lowercase(),
            thumbnail_id: sent.thumbnail_id.clone(),
            dc_id: sent.dc_id,
            bot_index,
            created_at: chrono::Utc::now(),
            caption: None,
            original_path: None,
        }
    }
}

/// Admin/user-facing file view (never exposes Telegram ids beyond what the
/// client needs to build a download link).
#[derive(Debug, Serialize)]
pub(crate) struct FileSummary {
    file_name: String,
    file_path: String,
    file_size: i64,
    mime_type: String,
    media_type: String,
    owner_id: String,
    message_id: i32,
    download_path: String,
    watch_path: String,
}

impl FileSummary {
    pub(crate) fn new(doc: &FileDoc) -> Self {
        Self {
            file_name: doc.file_name.clone(),
            file_path: doc.file_path.clone(),
            file_size: doc.file_size,
            mime_type: doc.mime_type.clone(),
            media_type: doc.media_type.clone(),
            owner_id: doc.owner_id.clone(),
            message_id: doc.message_id,
            download_path: format!("/dl/{}", encode_path(&doc.file_name)),
            watch_path: format!("/watch/{}", encode_path(&doc.file_name)),
        }
    }
}

/// Percent-encode a file name so it can be pasted into a URL path.
fn encode_path(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for byte in name.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub(crate) fn get_files_collection(client: &mongodb::Client) -> Collection<FileDoc> {
    client
        .database(&data_database_name())
        .collection(FileDoc::COLLECTION_NAME)
}

/// Look a file up by exact name, then by basename — v1 accepted a pasted
/// path (`/Home/Images/x.jpg`) as well as the bare name.
pub(crate) async fn find_file(
    client: &mongodb::Client,
    owner_id: &str,
    file_name: &str,
) -> Result<Option<FileDoc>, DbError> {
    let collection = get_files_collection(client);
    if let Some(doc) = collection
        .find_one(doc! { "owner_id": owner_id, "file_name": file_name })
        .await?
    {
        return Ok(Some(doc));
    }
    let base = basename(file_name);
    if base != file_name
        && let Some(doc) = collection
            .find_one(doc! { "owner_id": owner_id, "file_name": base })
            .await?
    {
        return Ok(Some(doc));
    }
    Ok(None)
}

pub(crate) async fn insert_file(client: &mongodb::Client, doc: &FileDoc) -> Result<(), DbError> {
    get_files_collection(client).insert_one(doc).await?;
    Ok(())
}

/// Look a file up by the Telegram message it lives in — the identity the
/// explorer actually holds (`tg://msg/{id}`), unlike the display name.
pub(crate) async fn find_file_by_message(
    client: &mongodb::Client,
    owner_id: &str,
    message_id: i32,
) -> Result<Option<FileDoc>, DbError> {
    let doc = get_files_collection(client)
        .find_one(doc! { "owner_id": owner_id, "message_id": message_id })
        .await?;
    Ok(doc)
}

/// Last path segment, tolerant of both separators so a Windows-style paste
/// still resolves.
pub(crate) fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Destination folder for an upload path (`/Home/Images/x.jpg` →
/// `/Home/Images`, anything without a folder → `/`).
pub(crate) fn parent_path(path: &str) -> String {
    let trimmed = path.trim_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(idx) => format!("/{}", trimmed[..idx].replace('\\', "/")),
        None => "/".to_string(),
    }
}

/// Destination folder for an upload, tolerating the two shapes clients send:
/// a bare folder (`/Home/Images`) or a full destination path
/// (`/Home/Images/a.mp4`).
pub(crate) fn normalize_folder(raw: &str, file_name: &str) -> String {
    // The Mongo VFS root is /Home: a pathless upload must land there, not at
    // a path listing can never reach.
    let raw = raw.trim();
    if raw.is_empty() {
        return "/Home".to_string();
    }
    let folder = if basename(raw) == file_name {
        let parent = parent_path(raw);
        if parent == "/" {
            "/Home".to_string()
        } else {
            parent
        }
    } else {
        let joined = raw.replace('\\', "/");
        let trimmed = joined.trim_matches('/');
        if trimmed.is_empty() {
            "/Home".to_string()
        } else {
            format!("/{trimmed}")
        }
    };
    if folder.is_empty() {
        "/Home".to_string()
    } else {
        folder
    }
}

/// Strip any directory component from a client-supplied name and drop
/// anything that is not a usable file name.
pub(crate) fn sanitize_file_name(raw: &str) -> Result<String, ApiError> {
    let name = basename(raw.trim()).trim().to_string();
    if name.is_empty() || name == "." || name == ".." {
        return Err(ApiError::Validation(
            "file name is missing or invalid".to_string(),
        ));
    }
    if name.contains('\0') || name.chars().any(|c| c.is_control()) {
        return Err(ApiError::Validation(
            "file name may not contain control characters".to_string(),
        ));
    }
    if name.len() > 255 {
        return Err(ApiError::Validation(
            "file name must be 255 characters or fewer".to_string(),
        ));
    }
    Ok(name)
}

/// Result of interpreting a `Range` header against a known file size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ByteRange {
    /// No (or unusable) range: serve the whole file with 200.
    Full,
    /// Inclusive byte range to serve with 206.
    Part { start: u64, end: u64 },
    /// Range that starts beyond the file: RFC 7233 wants a 416.
    Unsatisfiable,
}

impl ByteRange {
    /// Length of the body this range will produce.
    pub(crate) fn len(&self, file_size: u64) -> u64 {
        match *self {
            ByteRange::Full => file_size,
            ByteRange::Part { start, end } => end.saturating_sub(start).saturating_add(1),
            ByteRange::Unsatisfiable => 0,
        }
    }

    pub(crate) fn is_partial(&self) -> bool {
        matches!(self, ByteRange::Part { .. })
    }
}

/// Parse an HTTP `Range` header for a file of `file_size` bytes.
///
/// Malformed headers are ignored (a server may simply send 200 instead of
/// guessing), which is more forgiving than v1's hard failure.
pub(crate) fn parse_byte_range(header: Option<&str>, file_size: u64) -> ByteRange {
    let Some(header) = header.map(str::trim).filter(|h| !h.is_empty()) else {
        return ByteRange::Full;
    };
    let Some(spec) = header.strip_prefix("bytes=") else {
        return ByteRange::Full;
    };
    // Only a single range is ever requested by browsers; anything else is
    // served whole rather than rejected.
    if spec.contains(',') {
        return ByteRange::Full;
    }
    let Some((start, end)) = spec.split_once('-') else {
        return ByteRange::Full;
    };
    let start = start.trim();
    let end = end.trim();

    if start.is_empty() {
        // Suffix range: last N bytes.
        let Ok(suffix) = end.parse::<u64>() else {
            return ByteRange::Full;
        };
        if suffix == 0 || file_size == 0 {
            return ByteRange::Unsatisfiable;
        }
        return ByteRange::Part {
            start: file_size.saturating_sub(suffix),
            end: file_size - 1,
        };
    }

    let Ok(from) = start.parse::<u64>() else {
        return ByteRange::Full;
    };
    if from >= file_size {
        return ByteRange::Unsatisfiable;
    }
    let to = if end.is_empty() {
        file_size - 1
    } else {
        match end.parse::<u64>() {
            Ok(to) if to >= from => to.min(file_size - 1),
            // `bytes=5-2` is unsatisfiable per RFC 7233.
            Ok(_) => return ByteRange::Unsatisfiable,
            Err(_) => return ByteRange::Full,
        }
    };
    ByteRange::Part {
        start: from,
        end: to,
    }
}

/// MIME type for a file name, mirroring v1's browser-friendly table for the
/// formats players actually ask for.
pub(crate) fn guess_mime(file_name: &str) -> String {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "flv" => "video/x-flv",
        "wmv" => "video/x-ms-wmv",
        "ts" => "video/mp2t",
        "mpg" | "mpeg" => "video/mpeg",
        "3gp" => "video/3gpp",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "opus" => "audio/opus",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        "gz" => "application/gzip",
        "txt" | "srt" => "text/plain",
        "vtt" => "text/vtt",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    mime.to_string()
}

/// `Content-Disposition` with a quoted, header-safe file name.
pub(crate) fn content_disposition(file_name: &str, inline: bool) -> String {
    let safe: String = file_name
        .chars()
        .map(|c| match c {
            '"' | '\r' | '\n' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let kind = if inline { "inline" } else { "attachment" };
    format!("{kind}; filename=\"{safe}\"")
}

#[derive(Debug, Deserialize)]
pub(crate) struct MediaQuery {
    /// Session token for clients that cannot set an Authorization header
    /// (`<video src>`, `<a download>`).
    pub(crate) token: Option<String>,
}

/// Session for the media routes: Bearer header or `?token=`.
///
/// Same 401-with-challenge answer as `require_session`, so browsers and
/// players can tell "log in again" from "you asked for something wrong".
pub(crate) fn require_media_session(
    headers: &HeaderMap,
    query_token: Option<&str>,
    store: &SessionStore,
) -> Result<String, ApiError> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            query_token
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| ApiError::Unauthorized("authentication required".to_string()))?;

    validate_session(store, &token)
        .ok_or_else(|| ApiError::Unauthorized("invalid or expired session".to_string()))
}

/// Pushes Telegram bytes into the response body as they arrive.
///
/// The channel closes when this sink drops, which is how the client sees the
/// end of the body. If the client goes away first, `send` fails, the
/// cancellation token is raised, and the download stops instead of filling a
/// buffer nobody reads.
pub(crate) struct StreamSink {
    tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
    cancel: CancellationToken,
    written: u64,
}

impl StreamSink {
    pub(crate) fn new(
        tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            tx,
            cancel,
            written: 0,
        }
    }
}

#[async_trait]
impl DownloadSink for StreamSink {
    async fn write_chunk(&mut self, chunk: Bytes) -> Result<(), TelegramError> {
        self.written += chunk.len() as u64;
        if self.tx.send(Ok(chunk)).await.is_err() {
            self.cancel.cancel();
            return Err(TelegramError::Cancelled);
        }
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), TelegramError> {
        Ok(())
    }

    fn bytes_written(&self) -> u64 {
        self.written
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_size_bounds_match_telegram_part_limits() {
        // One full part exactly, and the maximum 4000-part file, are fine.
        assert!(validate_upload_size(1).is_ok());
        assert!(validate_upload_size(TELEGRAM_PART_SIZE_BYTES).is_ok());
        assert!(validate_upload_size(MAX_UPLOAD_BYTES).is_ok());
        // One byte over the part limit is already too many parts.
        assert!(validate_upload_size(MAX_UPLOAD_BYTES + 1).is_err());
        // Zero bytes means zero parts — Telegram rejects it.
        assert!(validate_upload_size(0).is_err());
    }

    #[test]
    fn id_is_keyed_by_owner_folder_and_name() {
        assert_eq!(
            FileDoc::id_for("alice", "/", "a.mp4"),
            "alice:/:a.mp4".to_string()
        );
        assert_eq!(
            FileDoc::id_for("alice", "/Home", "a.mp4"),
            "alice:/Home:a.mp4".to_string()
        );
        assert_ne!(
            FileDoc::id_for("alice", "/", "a.mp4"),
            FileDoc::id_for("bob", "/", "a.mp4")
        );
    }

    #[test]
    fn parent_path_defaults_to_root() {
        assert_eq!(parent_path("a.mp4"), "/");
        assert_eq!(parent_path("/a.mp4"), "/");
        assert_eq!(parent_path("/Home/Images/a.mp4"), "/Home/Images");
        assert_eq!(parent_path("Home\\Images\\a.mp4"), "/Home/Images");
    }

    #[test]
    fn folder_accepts_bare_folders_and_full_paths() {
        assert_eq!(normalize_folder("", "a.mp4"), "/Home");
        assert_eq!(normalize_folder("/Home/Images", "a.mp4"), "/Home/Images");
        assert_eq!(normalize_folder("Home/Images", "a.mp4"), "/Home/Images");
        assert_eq!(normalize_folder("/Home/Images/", "a.mp4"), "/Home/Images");
        // A full destination path collapses to the folder holding the file.
        assert_eq!(
            normalize_folder("/Home/Images/a.mp4", "a.mp4"),
            "/Home/Images"
        );
        assert_eq!(normalize_folder("a.mp4", "a.mp4"), "/Home");
        // A different file in the same paste is not mistaken for a folder.
        assert_eq!(
            normalize_folder("/Home/Images/b.mp4", "a.mp4"),
            "/Home/Images/b.mp4"
        );
    }

    #[test]
    fn sanitize_rejects_unusable_names() {
        assert_eq!(sanitize_file_name("movie.mp4").unwrap(), "movie.mp4");
        assert_eq!(sanitize_file_name("/Home/a.mp4").unwrap(), "a.mp4");
        assert_eq!(sanitize_file_name("C:\\tmp\\a.mp4").unwrap(), "a.mp4");
        assert!(sanitize_file_name("").is_err());
        assert!(sanitize_file_name("..").is_err());
        assert!(sanitize_file_name("bad\u{0}name").is_err());
    }

    #[test]
    fn basename_handles_both_separators() {
        assert_eq!(basename("/Home/a.mp4"), "a.mp4");
        assert_eq!(basename("a.mp4"), "a.mp4");
        assert_eq!(basename("C:\\tmp\\a.mp4"), "a.mp4");
    }

    #[test]
    fn range_parsing_matches_browser_habits() {
        assert_eq!(parse_byte_range(None, 100), ByteRange::Full);
        assert_eq!(parse_byte_range(Some(""), 100), ByteRange::Full);
        assert_eq!(parse_byte_range(Some("items=0-10"), 100), ByteRange::Full);
        assert_eq!(
            parse_byte_range(Some("bytes=0-49"), 100),
            ByteRange::Part { start: 0, end: 49 }
        );
        assert_eq!(
            parse_byte_range(Some("bytes=50-"), 100),
            ByteRange::Part { start: 50, end: 99 }
        );
        // End beyond EOF is clamped, not rejected.
        assert_eq!(
            parse_byte_range(Some("bytes=90-500"), 100),
            ByteRange::Part { start: 90, end: 99 }
        );
        // Suffix range.
        assert_eq!(
            parse_byte_range(Some("bytes=-20"), 100),
            ByteRange::Part { start: 80, end: 99 }
        );
        // Unsatisfiable.
        assert_eq!(
            parse_byte_range(Some("bytes=100-"), 100),
            ByteRange::Unsatisfiable
        );
        assert_eq!(
            parse_byte_range(Some("bytes=50-10"), 100),
            ByteRange::Unsatisfiable
        );
        assert_eq!(
            parse_byte_range(Some("bytes=-0"), 100),
            ByteRange::Unsatisfiable
        );
        // Multi-range is ignored rather than rejected.
        assert_eq!(
            parse_byte_range(Some("bytes=0-10,20-30"), 100),
            ByteRange::Full
        );
        // A zero-byte file cannot satisfy any range.
        assert_eq!(
            parse_byte_range(Some("bytes=0-"), 0),
            ByteRange::Unsatisfiable
        );
        assert_eq!(parse_byte_range(None, 0), ByteRange::Full);
    }

    #[test]
    fn range_lengths_drive_content_length() {
        assert_eq!(ByteRange::Full.len(100), 100);
        assert_eq!(ByteRange::Part { start: 10, end: 19 }.len(100), 10);
        assert_eq!(ByteRange::Unsatisfiable.len(100), 0);
        assert!(ByteRange::Part { start: 0, end: 0 }.is_partial());
        assert!(!ByteRange::Full.is_partial());
    }

    #[test]
    fn mime_table_covers_playback_formats() {
        assert_eq!(guess_mime("movie.mp4"), "video/mp4");
        assert_eq!(guess_mime("Movie.MKV"), "video/x-matroska");
        assert_eq!(guess_mime("song.flac"), "audio/flac");
        assert_eq!(guess_mime("cover.PNG"), "image/png");
        assert_eq!(guess_mime("archive.xyz"), "application/octet-stream");
        assert_eq!(guess_mime("noext"), "application/octet-stream");
    }

    #[test]
    fn disposition_is_inline_for_players_and_attachment_for_downloads() {
        assert_eq!(
            content_disposition("a.mp4", true),
            "inline; filename=\"a.mp4\""
        );
        assert_eq!(
            content_disposition("a.mp4", false),
            "attachment; filename=\"a.mp4\""
        );
        // Header injection attempts are neutralised.
        assert_eq!(
            content_disposition("a\"\r\nX: y.mp4", false),
            "attachment; filename=\"a___X: y.mp4\""
        );
    }

    #[test]
    fn media_session_accepts_header_or_query_token() {
        let store = crate::new_session_store();
        let token = crate::create_session(&store, "alice".to_string());

        let mut headers = HeaderMap::new();
        assert!(require_media_session(&headers, None, &store).is_err());
        assert!(require_media_session(&headers, Some("nope"), &store).is_err());
        assert_eq!(
            require_media_session(&headers, Some(&token), &store).unwrap(),
            "alice"
        );

        headers.insert(
            "authorization",
            axum::http::HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        assert_eq!(
            require_media_session(&headers, None, &store).unwrap(),
            "alice"
        );
    }

    #[test]
    fn encoded_paths_survive_a_url() {
        assert_eq!(encode_path("a b.mp4"), "a%20b.mp4");
        assert_eq!(encode_path("/Home/a-b_c.mp4"), "/Home/a-b_c.mp4");
        assert_eq!(encode_path("naïve.mp4"), "na%C3%AFve.mp4");
    }
}
