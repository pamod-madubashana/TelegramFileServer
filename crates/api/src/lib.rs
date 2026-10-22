use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Router,
    body::Body,
    extract::{Json, Multipart, Path, Query, State},
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{
            ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_TYPE, RANGE, WWW_AUTHENTICATE,
        },
    },
    response::{IntoResponse, Response},
    routing::{any, delete, get, patch, post},
};
use bytes::Bytes;
use futures::TryStreamExt;
use mongodb::{
    Client, Collection,
    bson::{self, doc},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tfs_config::{
    CheckResponse, ConfigError, KdfParams, SaveResponse, Step1Input, Step2Input,
    appdata::{
        ConnectionStore, delete_connection, delete_local_config, get_bin_dir, load_connection,
        load_local_config, save_connection, save_local_config,
    },
    create_setup_config, verify_and_decrypt,
};
use tfs_db::{DbError, connect, has_config, load_config, save_config};
use tfs_telegram::{
    BotPool, CancellationToken, ClaimBot, DownloadRange, GrammersClient, MediaType, TelegramClient,
    TelegramError, TransferEngine, lookup as tg_lookup,
};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

mod files;
mod thumbnails;
mod ui;
mod vfs;

/// Validate Step1Input manually (mirrors tfs-config validation)
fn validate_step1(input: &Step1Input) -> Result<(), String> {
    validate_mongo_uri(&input.mongo_uri)?;
    if input.password.len() < 8 {
        return Err("Password must be at least 8 characters".to_string());
    }
    Ok(())
}

/// A MongoDB URI is always supplied by the operator — there is no local
/// default to fall back on — so reject anything that is not one before
/// the wizard stores it in config.tfs.
fn validate_mongo_uri(uri: &str) -> Result<(), String> {
    if uri.trim().is_empty() {
        return Err("MongoDB URI is required".to_string());
    }
    let lower = uri.trim().to_ascii_lowercase();
    if lower.starts_with("mongodb://") || lower.starts_with("mongodb+srv://") {
        return Ok(());
    }
    Err("MongoDB URI must start with mongodb+srv:// (cloud) or mongodb://".to_string())
}

/// Session token length in bytes (32 bytes = 64 hex chars)
const SESSION_TOKEN_BYTES: usize = 32;
/// Session TTL: 7 days sliding
const SESSION_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// In-memory session store: token -> (username, last_accessed)
type SessionStore = Arc<Mutex<HashMap<String, (String, Instant)>>>;

/// Create a new empty session store
fn new_session_store() -> SessionStore {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Generate a secure random session token (32 bytes -> 64 hex chars)
fn generate_token() -> String {
    let mut bytes = [0u8; SESSION_TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Clean up expired sessions and return the username if token is valid.
/// Also refreshes the session's last_accessed time (sliding TTL).
fn validate_session(store: &SessionStore, token: &str) -> Option<String> {
    let mut sessions = store.lock().unwrap();
    let now = Instant::now();
    // Remove expired sessions
    sessions.retain(|_, (_, last_accessed)| now.duration_since(*last_accessed) < SESSION_TTL);
    // Check and refresh
    if let Some((username, last_accessed)) = sessions.get_mut(token) {
        *last_accessed = now;
        Some(username.clone())
    } else {
        None
    }
}

/// Insert a new session, returning the token
fn create_session(store: &SessionStore, username: String) -> String {
    let token = generate_token();
    let mut sessions = store.lock().unwrap();
    sessions.insert(token.clone(), (username, Instant::now()));
    token
}

/// Remove a session (idempotent)
fn remove_session(store: &SessionStore, token: &str) {
    let mut sessions = store.lock().unwrap();
    sessions.remove(token);
}

// ===== Owner claim flow =====
//
// First-run registration asks for a username only. If it matches the owner's
// Telegram name, the server issues a one-time secret and a t.me deep link;
// a dedicated claim bot watches for `/start <secret>` and marks the claim
// verified once the configured owner's Telegram account sends it. The web UI
// polls the claim, then the owner sets a password and the account is created.

/// Claim secrets expire this long after they are issued.
const CLAIM_TTL: Duration = Duration::from_secs(10 * 60);

/// Secret payload length in bytes (16 bytes -> 32 hex chars; the `/start`
/// deep-link payload limit is 64 characters).
const CLAIM_SECRET_BYTES: usize = 16;

/// Generate a one-time claim secret (32 hex chars).
fn generate_claim_secret() -> String {
    let mut bytes = [0u8; CLAIM_SECRET_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// One pending (or completed) account claim — the shared shape of the
/// username → verify → password flow for every new account.
struct ClaimEntry {
    username: String,
    created: Instant,
    /// The claim is verified once a `/start <secret>` arrives from the
    /// bound sender (or any Telegram user when the binding is `None`).
    verified: bool,
    /// Telegram user id that must send `/start`: the configured owner for an
    /// owner bootstrap, the invitee resolved at invite time, or `None` when
    /// no identity is known (dev override / unresolvable invite) — any
    /// Telegram user may then verify.
    expected_sender: Option<i64>,
    /// Who actually verified (set when `verified` flips true).
    verified_by: Option<i64>,
    /// The verifier's public @username, when their profile exposed one.
    verified_username: Option<String>,
    /// The verifier's Telegram first name, when their profile exposed one.
    verified_first_name: Option<String>,
    /// The verifier's Telegram last name, when their profile exposed one.
    verified_last_name: Option<String>,
}

impl ClaimEntry {
    fn new(username: String, expected_sender: Option<i64>) -> Self {
        Self {
            username,
            created: Instant::now(),
            verified: false,
            expected_sender,
            verified_by: None,
            verified_username: None,
            verified_first_name: None,
            verified_last_name: None,
        }
    }
}

/// In-memory claim store: secret -> entry. Secrets are single-use.
type ClaimStore = Arc<Mutex<HashMap<String, ClaimEntry>>>;

/// Handle to the lazily-started claim bot (its @username builds deep links).
#[derive(Clone)]
struct ClaimBotHandle {
    bot_username: String,
}

/// Extract Bearer token from Authorization header
fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Require a valid session from the Authorization header.
/// Returns the username on success, or an ApiError on failure.
///
/// Failures are 401 (with the `WWW-Authenticate` challenge), not 400, so
/// browsers and clients can tell "log in again" from "you asked for
/// something wrong".
pub fn require_session(headers: &HeaderMap, store: &SessionStore) -> Result<String, ApiError> {
    let token = extract_bearer_token(headers).ok_or_else(|| {
        ApiError::Unauthorized("missing or invalid Authorization header".to_string())
    })?;
    validate_session(store, &token)
        .ok_or_else(|| ApiError::Unauthorized("invalid or expired session".to_string()))
}

/// The user behind a valid session token, or `None` when the token is
/// missing, expired, or unknown. Callers treat `None` as "not logged in"
/// and fall back to pre-login behaviour (the owner account + the default
/// chat) so history indexing can still run before anyone signs in.
async fn session_user(
    headers: &HeaderMap,
    sessions: &SessionStore,
    mongo: &mongodb::Client,
) -> Result<Option<UserDoc>, ApiError> {
    let Some(token) = extract_bearer_token(headers) else {
        return Ok(None);
    };
    let Some(username) = validate_session(sessions, &token) else {
        return Ok(None);
    };
    find_user(mongo, &username).await.map_err(Into::into)
}

/// Username validation: 3-32 chars, [A-Za-z0-9_.-]
fn validate_username(username: &str) -> Result<(), String> {
    if username.len() < 3 || username.len() > 32 {
        return Err("username must be 3-32 characters".to_string());
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(
            "username may only contain letters, numbers, underscore, dot, and hyphen".to_string(),
        );
    }
    Ok(())
}

/// Password validation: at least 8 chars
fn validate_password(password: &str) -> Result<(), String> {
    if password.len() < 8 {
        return Err("password must be at least 8 characters".to_string());
    }
    Ok(())
}

/// Reserved handle for the owner account. The owner may open their account
/// under either their Telegram username or this name, and may sign in with
/// either one afterwards — there is only ever one owner account.
const ADMIN_USERNAME: &str = "admin";

/// Single wording for every failed credential check: a distinct message per
/// failure mode would tell an attacker which usernames exist.
const INVALID_CREDENTIALS: &str = "invalid username or password";

/// Is this username the owner's Telegram name or the reserved `admin` handle?
fn is_owner_signup_username(username: &str, owner_name: &str) -> bool {
    username.eq_ignore_ascii_case(owner_name) || username.eq_ignore_ascii_case(ADMIN_USERNAME)
}

/// Is this a valid sign-in handle for an owner account? Either the reserved
/// `admin` name or the owner's Telegram name — whichever the account was
/// opened under, the other one still has to work. Compared against the
/// document we already loaded, so no Telegram lookup runs on a failed login.
fn is_owner_signin_username(username: &str, owner: &UserDoc) -> bool {
    username.eq_ignore_ascii_case(ADMIN_USERNAME)
        || username.eq_ignore_ascii_case(&owner.username)
        || owner
            .telegram_username
            .as_deref()
            .is_some_and(|tg| username.eq_ignore_ascii_case(tg))
}

/// Hash password using Argon2id (PHC format) — mirrors tfs-config's private hash_password
fn hash_password_phc(password: &str, kdf: &KdfParams) -> Result<String, ConfigError> {
    let argon2 = kdf.argon2();
    let salt_str = SaltString::generate(&mut OsRng);
    let password_hash = argon2
        .hash_password(password.as_bytes(), &salt_str)
        .map_err(|e| ConfigError::Encryption(e.to_string()))?;
    Ok(password_hash.to_string())
}

/// Verify password against PHC hash — mirrors tfs-config's private verify_password
fn verify_password_phc(password: &str, password_hash: &str) -> Result<bool, ConfigError> {
    let parsed_hash =
        PasswordHash::new(password_hash).map_err(|e| ConfigError::Argon2(e.to_string()))?;
    let argon2 = Argon2::default();
    Ok(argon2
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

/// Per-account file permissions (v1 parity: read/download, write/upload).
/// Enforcement lands with the file API routes; stored and admin-managed now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Permissions {
    pub read: bool,
    pub write: bool,
}

fn default_permissions() -> Permissions {
    Permissions {
        read: true,
        write: true,
    }
}

fn default_role() -> String {
    "user".to_string()
}

/// User document in MongoDB (collection: v2_users)
///
/// Ownership model: every account carries the Telegram identity it belongs
/// to (`telegram_user_id`/`telegram_username`) — file ownership is keyed on
/// that. Accounts are never self-created except the owner: an admin creates
/// a username-only invite (`password_hash: None`), and the invited person
/// claims it by setting their own password via register.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserDoc {
    #[serde(rename = "_id")]
    id: String, // lowercased username
    username: String,
    /// Argon2 PHC string. `None` = admin-created invite, not claimed yet.
    #[serde(default)]
    password_hash: Option<String>,
    /// "admin" | "user". Docs written before roles existed default to "user".
    #[serde(default = "default_role")]
    role: String,
    #[serde(default)]
    telegram_user_id: Option<i64>,
    #[serde(default)]
    telegram_username: Option<String>,
    /// Telegram first name, captured at claim time from the verifier.
    #[serde(default)]
    telegram_first_name: Option<String>,
    /// Telegram last name, captured at claim time from the verifier.
    #[serde(default)]
    telegram_last_name: Option<String>,
    #[serde(default = "default_permissions")]
    permissions: Permissions,
    /// Private Telegram chat that receives this account's uploads. `None`
    /// means "use the setup wizard's `default_chat_id`" — the fallback for
    /// accounts that have not opened a chat with the bot.
    #[serde(default)]
    storage_chat_id: Option<i64>,
    /// Extra Telegram chats this account may browse as live "drives" in the
    /// explorer sidebar. Additive to the effective storage chat, which is
    /// always allowed without being listed here.
    #[serde(default)]
    storage_drives: Vec<DriveEntry>,
    created_at: chrono::DateTime<chrono::Utc>,
    /// Username of the admin who created this account.
    /// `None` marks the owner account (bootstrap admin from config owner_id).
    #[serde(default)]
    created_by: Option<String>,
}

/// One user-added drive chat: the chat id plus an optional display label
/// (bots cannot resolve chat titles, so the label is operator-supplied).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DriveEntry {
    chat_id: i64,
    #[serde(default)]
    label: String,
}

impl UserDoc {
    const COLLECTION_NAME: &'static str = "v2_users";
    const DATABASE_NAME: &'static str = "tfs_v2";

    fn is_admin(&self) -> bool {
        self.role == "admin"
    }

    /// Owner = the bootstrap admin account (`created_by: None`).
    fn is_owner(&self) -> bool {
        self.created_by.is_none() && self.is_admin()
    }

    fn claimed(&self) -> bool {
        self.password_hash.is_some()
    }
}

/// Database holding data documents.
///
/// Defaults to the canonical `tfs_v2` database. `TFS_USER_DB` redirects it so
/// an integration suite — which resets `v2_users` at the start of every test —
/// can claim a private database. Without this, two concurrent runs (e.g. a
/// `pull_request` run overlapping a `push` run) delete each other's fixtures
/// mid-test and fail spuriously. Unset in production, so behaviour there is
/// unchanged.
///
/// `v2_files` lives here too: file records must land in whatever database the
/// suite has claimed, otherwise a test that uploads would write production
/// rows.
fn data_database_name() -> String {
    std::env::var("TFS_USER_DB")
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| UserDoc::DATABASE_NAME.to_string())
}

fn get_users_collection(client: &mongodb::Client) -> Collection<UserDoc> {
    client
        .database(&data_database_name())
        .collection(UserDoc::COLLECTION_NAME)
}

/// Count users with the given role ("admin" / "user")
async fn count_role(client: &mongodb::Client, role: &str) -> Result<u64, DbError> {
    let collection = get_users_collection(client);
    let count = collection.count_documents(doc! { "role": role }).await?;
    Ok(count)
}

/// Insert a user document (duplicate _id → DbError::Connection with E11000)
async fn insert_user(client: &mongodb::Client, user: &UserDoc) -> Result<(), DbError> {
    let collection = get_users_collection(client);
    collection.insert_one(user).await?;
    Ok(())
}

/// Set/replace a user's password (used by the claim flow)
async fn set_password(
    client: &mongodb::Client,
    id: &str,
    password_hash: String,
) -> Result<(), DbError> {
    let collection = get_users_collection(client);
    collection
        .update_one(
            doc! { "_id": id },
            doc! { "$set": { "password_hash": password_hash } },
        )
        .await?;
    Ok(())
}

/// Promote an existing account to the owner/admin role and stamp its
/// Telegram identity (self-heals accounts created before roles existed).
async fn promote_to_owner(
    client: &mongodb::Client,
    id: &str,
    telegram_user_id: Option<i64>,
    telegram_username: &str,
) -> Result<(), DbError> {
    let collection = get_users_collection(client);
    collection
        .update_one(
            doc! { "_id": id },
            doc! { "$set": {
                "role": "admin",
                "created_by": bson::Bson::Null,
                "telegram_user_id": telegram_user_id.map(bson::Bson::from),
                "telegram_username": telegram_username,
            }},
        )
        .await?;
    Ok(())
}

/// Replace mutable profile fields (role / permissions / telegram link)
async fn update_user_fields(
    client: &mongodb::Client,
    id: &str,
    fields: bson::Document,
) -> Result<(), DbError> {
    let collection = get_users_collection(client);
    collection
        .update_one(doc! { "_id": id }, doc! { "$set": fields })
        .await?;
    Ok(())
}

/// Delete a user by id
async fn delete_user(client: &mongodb::Client, id: &str) -> Result<(), DbError> {
    let collection = get_users_collection(client);
    collection.delete_one(doc! { "_id": id }).await?;
    Ok(())
}

/// Find user by username (case-insensitive via lowercased _id)
async fn find_user(client: &mongodb::Client, username: &str) -> Result<Option<UserDoc>, DbError> {
    let collection = get_users_collection(client);
    let id = username.to_lowercase();
    let user = collection.find_one(doc! { "_id": &id }).await?;
    Ok(user)
}

/// The owner account — the bootstrap admin (`created_by: null`).
/// Matched by field rather than `_id` because the owner may have signed up
/// under either their Telegram username or the reserved `admin` handle.
async fn find_owner(client: &mongodb::Client) -> Result<Option<UserDoc>, DbError> {
    let collection = get_users_collection(client);
    let user = collection
        .find_one(doc! { "created_by": null, "role": "admin" })
        .await?;
    Ok(user)
}

/// Move a user document to a new username.
///
/// `_id` is immutable in MongoDB, so the account is re-inserted under the
/// new id and the old document removed. The insert goes first: it is the
/// operation guarded by the unique index, so a taken username fails the
/// rename instead of dropping the account. A failure after the insert leaves
/// the account alive under its new name and is surfaced to the caller.
async fn rename_user(
    client: &mongodb::Client,
    from: &UserDoc,
    to: &UserDoc,
) -> Result<(), DbError> {
    let collection = get_users_collection(client);
    collection.insert_one(to).await?;
    collection.delete_one(doc! { "_id": &from.id }).await?;
    Ok(())
}

/// All users, sorted by username (admin listing)
async fn list_users(client: &mongodb::Client) -> Result<Vec<UserDoc>, DbError> {
    let collection = get_users_collection(client);
    let mut cursor = collection.find(doc! {}).sort(doc! { "_id": 1 }).await?;
    let mut users = Vec::new();
    while let Some(user) = cursor.try_next().await? {
        users.push(user);
    }
    Ok(users)
}

/// Auth request/response types
#[derive(Debug, Deserialize)]
struct RegisterRequest {
    username: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct RegisterResponse {
    ok: bool,
    username: String,
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct LoginResponse {
    token: String,
    username: String,
}

#[derive(Debug, Serialize)]
struct MeResponse {
    username: String,
    role: String,
    permissions: Permissions,
    telegram_username: Option<String>,
    telegram_user_id: Option<i64>,
    first_name: Option<String>,
    last_name: Option<String>,
    has_profile_photo: bool,
}

#[derive(Debug, Serialize)]
struct AuthStatusResponse {
    needs_registration: bool,
    /// `"owner"` — bootstrap: register with the owner's Telegram username or
    /// the reserved `admin` name (becomes the admin account). `"invite"` —
    /// admin exists; invited accounts claim their password here, everyone
    /// else signs in.
    registration: &'static str,
}

/// How the first (owner) account's Telegram identity is resolved.
#[derive(Clone)]
pub enum OwnerResolver {
    /// Production: resolve the configured `owner_id`'s public username via
    /// the bot credentials from the local config mirror.
    Telegram,
    /// Fixed identity — tests and the `TFS_OWNER_USERNAME_OVERRIDE` dev
    /// escape hatch (bypasses Telegram verification; local use only).
    Fixed {
        username: String,
        user_id: Option<i64>,
    },
}

impl OwnerResolver {
    fn from_env() -> Self {
        match std::env::var("TFS_OWNER_USERNAME_OVERRIDE") {
            Ok(name) if !name.trim().is_empty() => {
                tracing::warn!(
                    "TFS_OWNER_USERNAME_OVERRIDE={} — owner registration skips Telegram verification (dev/test only)",
                    name.trim()
                );
                OwnerResolver::Fixed {
                    username: name.trim().to_string(),
                    user_id: None,
                }
            }
            _ => OwnerResolver::Telegram,
        }
    }
}

/// Telegram credentials needed for peer lookups, loaded from the saved
/// connection (appdata password) + local config mirror (binary dir).
struct TelegramCreds {
    api_id: i32,
    api_hash: String,
    /// First configured bot — used by the lookup client.
    bot_token: String,
    /// Every configured bot, in wizard order. The transfer pool starts with
    /// the first and adds more under load.
    bot_tokens: Vec<String>,
    owner_id: i64,
    session_path: PathBuf,
}

fn load_telegram_creds() -> Result<TelegramCreds, ApiError> {
    let conn = load_connection()
        .map_err(|e| ApiError::Telegram(format!("no saved connection: {e}")))?
        .ok_or_else(|| {
            ApiError::Telegram(
                "server is not configured yet — complete the setup wizard".to_string(),
            )
        })?;
    let local = load_local_config(&conn.password)
        .map_err(|e| ApiError::Telegram(format!("local config mirror unreadable: {e}")))?
        .ok_or_else(|| {
            ApiError::Telegram("local config mirror missing — re-run the setup wizard".to_string())
        })?;
    let api_id = i32::try_from(local.sensitive.api_id)
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            ApiError::Telegram(
                "api_id missing from local config — re-run the setup wizard".to_string(),
            )
        })?;
    let bot_tokens: Vec<String> = local
        .sensitive
        .bot_tokens
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let bot_token = bot_tokens.first().cloned().ok_or_else(|| {
        ApiError::Telegram("no bot token in local config — re-run the setup wizard".to_string())
    })?;
    Ok(TelegramCreds {
        api_id,
        api_hash: local.sensitive.api_hash,
        bot_token,
        bot_tokens,
        owner_id: local.owner_id,
        // Dedicated session file: lookups must not contend with the transfer
        // engine's own session when it lands.
        session_path: get_bin_dir().join("api-lookup.session"),
    })
}

/// Map lookup errors to actionable 503s.
fn telegram_err(e: tfs_telegram::TelegramError) -> ApiError {
    use tfs_telegram::TelegramError as E;
    match &e {
        E::FloodWait { seconds } => ApiError::Telegram(format!(
            "Telegram is rate-limiting lookups — retry in {seconds}s"
        )),
        E::Rpc { code, message } => ApiError::Telegram(format!(
            "Telegram rejected the lookup (RPC {code}: {message})"
        )),
        E::Config(msg) => ApiError::Telegram(msg.clone()),
        _ => ApiError::Telegram(format!("Telegram lookup failed: {e}")),
    }
}

type TgGuard<'a> = tokio::sync::MutexGuard<'a, Option<GrammersClient>>;

/// Lazily connect (once per process) and hand out the lookup client.
async fn tg_lookup_client(state: &AppState) -> Result<(TelegramCreds, TgGuard<'_>), ApiError> {
    let creds = load_telegram_creds()?;
    let mut guard = state.tg.lock().await;
    if guard.is_none() {
        let mut client = GrammersClient::new_bot(
            creds.api_id,
            creds.api_hash.clone(),
            creds.bot_token.clone(),
            creds.session_path.clone(),
        );
        client
            .connect()
            .await
            .map_err(|e| ApiError::Telegram(format!("failed to connect to Telegram: {e}")))?;
        tracing::info!(
            "Telegram lookup client connected (session: {})",
            creds.session_path.display()
        );
        *guard = Some(client);
    }
    Ok((creds, guard))
}

/// Resolve the configured owner's Telegram identity for owner registration.
async fn resolve_owner_identity(state: &AppState) -> Result<(Option<i64>, String), ApiError> {
    match &state.owner_resolver {
        OwnerResolver::Fixed { username, user_id } => Ok((*user_id, username.clone())),
        OwnerResolver::Telegram => {
            let (creds, guard) = tg_lookup_client(state).await?;
            let client = guard
                .as_ref()
                .and_then(|c| c.inner())
                .ok_or_else(|| ApiError::Telegram("Telegram client unavailable".to_string()))?;
            let name = tg_lookup::username_by_id(client, creds.owner_id)
                .await
                .map_err(telegram_err)?
                .ok_or_else(|| {
                    ApiError::Telegram(format!(
                        "owner account {} has no public @username — set a username in Telegram, then retry",
                        creds.owner_id
                    ))
                })?;
            Ok((Some(creds.owner_id), name))
        }
    }
}

/// Best-effort Telegram sync: username → user id (`None` = not linked).
/// Used at admin account creation (non-fatal) and resync (fatal on error).
///
/// Fixed (test/dev) resolver ⇒ always `None`: tests must never touch
/// Telegram or the real saved config.
async fn resolve_tg_user_id(state: &AppState, username: &str) -> Result<Option<i64>, ApiError> {
    if matches!(state.owner_resolver, OwnerResolver::Fixed { .. }) {
        return Ok(None);
    }
    let (_creds, guard) = tg_lookup_client(state).await?;
    let client = guard
        .as_ref()
        .and_then(|c| c.inner())
        .ok_or_else(|| ApiError::Telegram("Telegram client unavailable".to_string()))?;
    tg_lookup::id_by_username(client, username)
        .await
        .map_err(telegram_err)
}

/// GET /api/auth/status — registration mode for the login screen.
/// Never touches Telegram (register performs owner resolution lazily).
async fn auth_status(State(state): State<Arc<AppState>>) -> ApiResult<Json<AuthStatusResponse>> {
    let client = state.mongo_client().await?;
    if count_role(&client, "admin").await? == 0 {
        // No admin yet → owner bootstrap (create, or self-heal a legacy
        // account carrying the owner's username).
        return Ok(Json(AuthStatusResponse {
            needs_registration: true,
            registration: "owner",
        }));
    }
    Ok(Json(AuthStatusResponse {
        needs_registration: false,
        registration: "invite",
    }))
}

/// POST /api/auth/register
///
/// Two mutually exclusive flows:
/// - No admin yet (owner bootstrap): username must match the owner's
///   Telegram username → created as the admin account, linked to owner_id.
/// - Admin exists: only pre-created (passwordless) invites can be claimed;
///   any other username → 403 registration closed.
async fn auth_register(
    State(state): State<Arc<AppState>>,
    Json(input): Json<RegisterRequest>,
) -> ApiResult<Json<RegisterResponse>> {
    validate_username(&input.username).map_err(ApiError::Validation)?;
    validate_password(&input.password).map_err(ApiError::Validation)?;

    let client = state.mongo_client().await?;

    if count_role(&client, "admin").await? == 0 {
        // ===== Owner bootstrap =====
        let (owner_id, owner_name) = resolve_owner_identity(&state).await?;
        if !is_owner_signup_username(&input.username, &owner_name) {
            return Err(ApiError::Forbidden(format!(
                "username must match the Telegram owner account \"{owner_name}\" \
                 (or \"{ADMIN_USERNAME}\")"
            )));
        }
        let kdf = KdfParams::new();
        let password_hash = hash_password_phc(&input.password, &kdf)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        let username = bootstrap_owner_account(
            &client,
            owner_id,
            &owner_name,
            &input.username,
            password_hash,
            None,
            None,
        )
        .await?;
        return Ok(Json(RegisterResponse { ok: true, username }));
    }

    // ===== Invited users: claim a username an admin created =====
    let Some(existing) = find_user(&client, &input.username).await? else {
        return Err(ApiError::Forbidden(
            "registration closed — ask an administrator to create your account".to_string(),
        ));
    };
    if existing.claimed() {
        return Err(ApiError::Conflict(
            "account already registered — sign in instead".to_string(),
        ));
    }
    let kdf = KdfParams::new();
    let password_hash =
        hash_password_phc(&input.password, &kdf).map_err(|e| ApiError::Internal(e.to_string()))?;
    set_password(&client, &existing.id, password_hash).await?;
    Ok(Json(RegisterResponse {
        ok: true,
        username: existing.username,
    }))
}

/// Create or self-heal the owner account under the typed username.
/// Shared by the register and claim-confirm owner-bootstrap paths; returns
/// the username the account now lives under.
async fn bootstrap_owner_account(
    client: &mongodb::Client,
    owner_id: Option<i64>,
    owner_name: &str,
    typed_username: &str,
    password_hash: String,
    first_name: Option<String>,
    last_name: Option<String>,
) -> ApiResult<String> {
    match find_user(client, typed_username).await? {
        None => {
            // The account keeps the owner's Telegram name when that is what
            // was typed (the original behaviour), or the reserved `admin`
            // handle when that was used instead. The Telegram link carries
            // the real owner identity either way.
            let username = if typed_username.eq_ignore_ascii_case(owner_name) {
                owner_name.to_string()
            } else {
                typed_username.to_string()
            };
            let user = UserDoc {
                id: username.to_lowercase(),
                username,
                password_hash: Some(password_hash),
                role: "admin".to_string(),
                telegram_user_id: owner_id,
                telegram_username: Some(owner_name.to_string()),
                telegram_first_name: first_name,
                telegram_last_name: last_name,
                permissions: default_permissions(),
                storage_chat_id: None,
                storage_drives: Vec::new(),
                created_at: chrono::Utc::now(),
                created_by: None,
            };
            match insert_user(client, &user).await {
                Ok(()) => {}
                Err(DbError::Connection(e)) if e.to_string().contains("E11000") => {
                    return Err(ApiError::Conflict(
                        "username already exists — sign in instead".to_string(),
                    ));
                }
                Err(e) => return Err(e.into()),
            }
            Ok(user.username)
        }
        Some(existing) if existing.claimed() => {
            // Account already registered under the owner's name (legacy
            // test data): promote it to owner and ask them to sign in.
            promote_to_owner(client, &existing.id, owner_id, owner_name).await?;
            Err(ApiError::Conflict(
                "account already registered — sign in instead".to_string(),
            ))
        }
        Some(existing) => {
            // Owner invite sitting unclaimed: set password + promote.
            set_password(client, &existing.id, password_hash).await?;
            promote_to_owner(client, &existing.id, owner_id, owner_name).await?;
            Ok(existing.username)
        }
    }
}

/// POST /api/auth/login
async fn auth_login(
    State(state): State<Arc<AppState>>,
    Json(input): Json<LoginRequest>,
) -> ApiResult<Json<LoginResponse>> {
    let client = state.mongo_client().await?;

    let found = find_user(&client, &input.username).await?;
    let user = match found {
        Some(u) => u,
        // The owner may have opened their account under either name, so the
        // one they did not use stays a valid handle for it too. Matched off
        // the stored document — a failed login never triggers a Telegram
        // lookup, and every miss still returns the same generic error.
        None => match find_owner(&client).await? {
            Some(owner) if is_owner_signin_username(&input.username, &owner) => owner,
            // User not found — same error as wrong password (no user enumeration)
            _ => return Err(ApiError::InvalidInput(INVALID_CREDENTIALS.to_string())),
        },
    };

    // Unclaimed invites have no password yet — indistinguishable from a
    // wrong password (no user enumeration).
    let Some(ref stored_hash) = user.password_hash else {
        return Err(ApiError::InvalidInput(INVALID_CREDENTIALS.to_string()));
    };

    // Verify password
    if !verify_password_phc(&input.password, stored_hash)
        .map_err(|e| ApiError::Internal(e.to_string()))?
    {
        return Err(ApiError::InvalidInput(INVALID_CREDENTIALS.to_string()));
    }

    // Create session
    let token = create_session(&state.sessions, user.username.clone());

    Ok(Json(LoginResponse {
        token,
        username: user.username,
    }))
}

/// Best-effort backfill of a user's Telegram first/last name and public
/// @username when the account predates claim-time capture (or is missing the
/// username while the names are present). Non-fatal: any Telegram or Mongo
/// error leaves the stored values untouched.
async fn backfill_telegram_names(state: &AppState, client: &mongodb::Client, user: &mut UserDoc) {
    // Fetch only when the id is known and something is still missing.
    if user.telegram_user_id.is_none()
        || (user.telegram_first_name.is_some() && user.telegram_username.is_some())
    {
        return;
    }
    // Tests (Fixed resolver) must never touch Telegram.
    if matches!(state.owner_resolver, OwnerResolver::Fixed { .. }) {
        return;
    }
    let Some(tg_id) = user.telegram_user_id else {
        return;
    };
    let Ok((_creds, guard)) = tg_lookup_client(state).await else {
        return;
    };
    let Some(tg) = guard.as_ref().and_then(|c| c.inner()) else {
        return;
    };
    let Ok((first, last, username)) = tg_lookup::names_by_id(tg, tg_id).await else {
        return;
    };
    // Persist only the fields that are missing locally and known remotely, so
    // we never clobber good data (or write nulls over an existing name).
    let mut fields = bson::Document::new();
    if user.telegram_first_name.is_none()
        && let Some(name) = &first
    {
        fields.insert("telegram_first_name", bson::Bson::from(name.clone()));
    }
    if user.telegram_last_name.is_none()
        && let Some(name) = &last
    {
        fields.insert("telegram_last_name", bson::Bson::from(name.clone()));
    }
    if user.telegram_username.is_none()
        && let Some(name) = &username
    {
        fields.insert("telegram_username", bson::Bson::from(name.clone()));
    }
    if fields.is_empty() || update_user_fields(client, &user.id, fields).await.is_err() {
        return;
    }
    if user.telegram_first_name.is_none() {
        user.telegram_first_name = first;
    }
    if user.telegram_last_name.is_none() {
        user.telegram_last_name = last;
    }
    if user.telegram_username.is_none() {
        user.telegram_username = username;
    }
}

/// GET /api/auth/me — requires Bearer token, returns profile + role,
/// refreshes sliding TTL.
async fn auth_me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<MeResponse>> {
    let username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let mut user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    backfill_telegram_names(&state, &client, &mut user).await;
    Ok(Json(MeResponse {
        username: user.username,
        role: user.role,
        permissions: user.permissions,
        telegram_username: user.telegram_username,
        telegram_user_id: user.telegram_user_id,
        first_name: user.telegram_first_name,
        last_name: user.telegram_last_name,
        has_profile_photo: user.telegram_user_id.is_some(),
    }))
}

/// POST /api/auth/logout — idempotent, 204 even for unknown token
async fn auth_logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<impl IntoResponse> {
    if let Some(token) = extract_bearer_token(&headers) {
        remove_session(&state.sessions, &token);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ===== Owner claim endpoints (Telegram-verified bootstrap) =====

#[derive(Debug, Deserialize)]
struct ClaimStartRequest {
    username: String,
}

#[derive(Debug, Serialize)]
struct ClaimStartResponse {
    username: String,
    secret: String,
    deep_link: String,
}

#[derive(Debug, Serialize)]
struct ClaimStatusResponse {
    /// `"pending" | "verified" | "expired" | "unknown"`.
    status: &'static str,
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimConfirmRequest {
    secret: String,
    password: String,
}

#[derive(Debug, Serialize)]
struct ClaimConfirmResponse {
    token: String,
    username: String,
}

/// GET /api/auth/claim/available?username=… — unauthenticated gate for the
/// create screen: the Create Account button stays disabled until the name is
/// claimable, so users learn the problem before opening Telegram.
#[derive(Debug, Deserialize)]
struct ClaimAvailableQuery {
    username: String,
}

#[derive(Debug, Serialize)]
struct ClaimAvailableResponse {
    username: String,
    available: bool,
    /// Present when `available` is false — the reason to show the user.
    reason: Option<String>,
}

/// POST /api/auth/claim/start — issue a one-time secret + deep link.
///
/// The same entry point serves both modes:
/// - No admin yet (owner bootstrap): the username must match the owner's
///   Telegram name (or `admin`); verification is bound to the owner's id.
/// - Admin exists: only an administrator-created, still-unclaimed username
///   may start; verification is bound to the Telegram id resolved at invite
///   time (any Telegram user when the invite carries none).
async fn claim_start(
    State(state): State<Arc<AppState>>,
    Json(input): Json<ClaimStartRequest>,
) -> ApiResult<Json<ClaimStartResponse>> {
    validate_username(&input.username).map_err(ApiError::Validation)?;

    let client = state.mongo_client().await?;
    let expected_sender = if count_role(&client, "admin").await? == 0 {
        // ===== Owner bootstrap =====
        let (owner_id, owner_name) = resolve_owner_identity(&state).await?;
        if !is_owner_signup_username(&input.username, &owner_name) {
            return Err(ApiError::Forbidden(format!(
                "username must match the Telegram owner account \"{owner_name}\" \
                 (or \"{ADMIN_USERNAME}\")"
            )));
        }
        if let Some(existing) = find_user(&client, &input.username).await?
            && existing.claimed()
        {
            return Err(ApiError::Conflict(
                "account already registered — sign in instead".to_string(),
            ));
        }
        owner_id
    } else {
        // ===== Invited users: the name must exist and still be unclaimed =====
        let Some(existing) = find_user(&client, &input.username).await? else {
            return Err(ApiError::Forbidden(
                "registration closed — ask an administrator to create your account".to_string(),
            ));
        };
        if existing.claimed() {
            return Err(ApiError::Conflict(
                "account already registered — sign in instead".to_string(),
            ));
        }
        existing.telegram_user_id
    };

    let handle = state.ensure_claim_bot().await?;
    let secret = generate_claim_secret();
    state.claims.lock().unwrap().insert(
        secret.clone(),
        ClaimEntry::new(input.username.clone(), expected_sender),
    );
    tracing::info!(username = %input.username, ?expected_sender, "account claim started");
    Ok(Json(ClaimStartResponse {
        username: input.username,
        deep_link: format!("https://t.me/{}?start={}", handle.bot_username, secret),
        secret,
    }))
}

/// GET /api/auth/claim/status/:secret — polled by the web UI while waiting
/// for the owner to tap the deep link in Telegram.
async fn claim_status(
    State(state): State<Arc<AppState>>,
    Path(secret): Path<String>,
) -> ApiResult<Json<ClaimStatusResponse>> {
    let mut claims = state.claims.lock().unwrap();
    let now = Instant::now();
    // An expired secret is indistinguishable from an unknown one from here
    // on: purge it so the store does not grow without bound.
    claims.retain(|_, entry| now.duration_since(entry.created) < CLAIM_TTL);
    match claims.get(&secret) {
        None => Ok(Json(ClaimStatusResponse {
            status: "unknown",
            username: None,
        })),
        Some(entry) => Ok(Json(ClaimStatusResponse {
            status: if entry.verified {
                "verified"
            } else {
                "pending"
            },
            username: Some(entry.username.clone()),
        })),
    }
}

/// POST /api/auth/claim/confirm — create the owner account once the claim
/// has been verified in Telegram. Returns a session token so the web UI can
/// continue without a second round trip.
async fn claim_confirm(
    State(state): State<Arc<AppState>>,
    Json(input): Json<ClaimConfirmRequest>,
) -> ApiResult<Json<ClaimConfirmResponse>> {
    validate_password(&input.password).map_err(ApiError::Validation)?;

    // Consume the claim only if it is verified and unexpired.
    let claim = {
        let mut claims = state.claims.lock().unwrap();
        let now = Instant::now();
        claims.retain(|_, entry| now.duration_since(entry.created) < CLAIM_TTL);
        match claims.get(&input.secret) {
            None => {
                return Err(ApiError::Forbidden(
                    "claim expired or unknown — start again".to_string(),
                ));
            }
            Some(entry) if !entry.verified => {
                return Err(ApiError::Forbidden(
                    "not verified in Telegram yet — open the claim link first".to_string(),
                ));
            }
            Some(_) => claims.remove(&input.secret).expect("entry just checked"),
        }
    };

    let client = state.mongo_client().await?;
    let kdf = KdfParams::new();
    let password_hash =
        hash_password_phc(&input.password, &kdf).map_err(|e| ApiError::Internal(e.to_string()))?;

    let username = if count_role(&client, "admin").await? == 0 {
        // ===== Owner bootstrap =====
        let (owner_id, owner_name) = resolve_owner_identity(&state).await?;
        bootstrap_owner_account(
            &client,
            owner_id,
            &owner_name,
            &claim.username,
            password_hash,
            claim.verified_first_name.clone(),
            claim.verified_last_name.clone(),
        )
        .await?
    } else {
        // ===== Invited users: the admin pre-created this name =====
        let Some(existing) = find_user(&client, &claim.username).await? else {
            return Err(ApiError::Forbidden(
                "registration closed — ask an administrator to create your account".to_string(),
            ));
        };
        if existing.claimed() {
            return Err(ApiError::Conflict(
                "account already registered — sign in instead".to_string(),
            ));
        }
        set_password(&client, &existing.id, password_hash).await?;
        // Stamp the Telegram identity the bot actually saw, so the invite's
        // pre-resolved binding (if any) is replaced by the verified one.
        let mut fields = bson::Document::new();
        if let Some(verified_by) = claim.verified_by {
            fields.insert("telegram_user_id", bson::Bson::from(verified_by));
        }
        if let Some(name) = &claim.verified_username {
            fields.insert("telegram_username", bson::Bson::from(name.clone()));
        }
        if let Some(first_name) = &claim.verified_first_name {
            fields.insert("telegram_first_name", bson::Bson::from(first_name.clone()));
        }
        if let Some(last_name) = &claim.verified_last_name {
            fields.insert("telegram_last_name", bson::Bson::from(last_name.clone()));
        }
        if !fields.is_empty() {
            update_user_fields(&client, &existing.id, fields).await?;
        }
        existing.username
    };

    let token = create_session(&state.sessions, username.clone());
    tracing::info!(username = %username, "account claim completed — signed in");
    Ok(Json(ClaimConfirmResponse { token, username }))
}

/// GET /api/auth/claim/available?username=… — pre-flight check for the
/// username-only create screen (no session, no Telegram).
async fn claim_available(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ClaimAvailableQuery>,
) -> ApiResult<Json<ClaimAvailableResponse>> {
    // Syntax first: never touch Mongo for a malformed name.
    if let Err(reason) = validate_username(&query.username) {
        return Ok(Json(ClaimAvailableResponse {
            username: query.username,
            available: false,
            reason: Some(reason.to_string()),
        }));
    }

    let client = state.mongo_client().await?;
    let response = if count_role(&client, "admin").await? == 0 {
        // ===== Owner bootstrap: the name is free to claim =====
        if find_user(&client, &query.username)
            .await?
            .is_some_and(|u| u.claimed())
        {
            ClaimAvailableResponse {
                username: query.username,
                available: false,
                reason: Some("username already registered — sign in instead".to_string()),
            }
        } else {
            ClaimAvailableResponse {
                username: query.username,
                available: true,
                reason: None,
            }
        }
    } else {
        // ===== Invited users: only an existing, unclaimed invite qualifies =====
        match find_user(&client, &query.username).await? {
            Some(existing) if !existing.claimed() => ClaimAvailableResponse {
                username: query.username,
                available: true,
                reason: None,
            },
            Some(_) => ClaimAvailableResponse {
                username: query.username,
                available: false,
                reason: Some("username already registered — sign in instead".to_string()),
            },
            None => ClaimAvailableResponse {
                username: query.username,
                available: false,
                reason: Some(
                    "registration closed — ask an administrator to create your account".to_string(),
                ),
            },
        }
    };
    Ok(Json(response))
}

// ===== Self-service account management =====
//
// Accounts are never created without an administrator unlocking the username
// first — but once created, the holder owns the credentials: they rename and
// re-password themselves without going through an admin.

#[derive(Debug, Deserialize)]
struct UsernameAvailableQuery {
    username: String,
}

#[derive(Debug, Serialize)]
struct UsernameAvailableResponse {
    username: String,
    available: bool,
    /// Present when `available` is false — the reason to show the user.
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChangeUsernameRequest {
    username: String,
}

#[derive(Debug, Serialize)]
struct ChangeUsernameResponse {
    username: String,
    /// Sessions are keyed by username, so a rename issues a fresh token and
    /// the client must swap it in for the old one.
    token: String,
    telegram_username: Option<String>,
    telegram_user_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

/// GET /api/auth/username-available?username=…
///
/// Usernames are unique (the `_id` is the lowercased name), so a rename has
/// to check before it commits. Any signed-in account may ask: the only names
/// this reveals are ones members already see in each other's listings.
async fn auth_username_available(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<UsernameAvailableQuery>,
) -> ApiResult<Json<UsernameAvailableResponse>> {
    let username = require_session(&headers, &state.sessions)?;

    let (available, reason) = match validate_username(&query.username) {
        Err(msg) => (false, Some(msg)),
        Ok(()) => {
            let client = state.mongo_client().await?;
            let me_id = username.to_lowercase();
            match find_user(&client, &query.username).await? {
                // Already yours (differing only in case) — nothing to change.
                Some(existing) if existing.id == me_id => (true, None),
                Some(_) => (false, Some("username already taken".to_string())),
                None => (true, None),
            }
        }
    };

    Ok(Json(UsernameAvailableResponse {
        username: query.username,
        available,
        reason,
    }))
}

/// POST /api/auth/change-username — rename the signed-in account.
///
/// Uniqueness is enforced twice: once by asking here, and again by the insert
/// that carries the new `_id`, so a name taken between the two still fails
/// rather than silently colliding.
async fn auth_change_username(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<ChangeUsernameRequest>,
) -> ApiResult<Json<ChangeUsernameResponse>> {
    validate_username(&input.username).map_err(ApiError::Validation)?;

    let old_username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let me = find_user(&client, &old_username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;

    if me.username.eq_ignore_ascii_case(&input.username) {
        // Same name, different casing: the session already fits.
        return Ok(Json(ChangeUsernameResponse {
            username: me.username,
            token: extract_bearer_token(&headers).unwrap_or_default(),
            telegram_username: me.telegram_username,
            telegram_user_id: me.telegram_user_id,
        }));
    }

    if find_user(&client, &input.username).await?.is_some() {
        return Err(ApiError::Conflict(
            "that username is already taken".to_string(),
        ));
    }

    // The owner's Telegram identity comes from the configured owner account,
    // not from their login name, so a rename must not drop it. Everyone else
    // is re-resolved from the new name: not found clears the link, a
    // connection failure keeps the old one (resync covers it).
    let (telegram_user_id, telegram_username) = if me.is_owner() {
        match resolve_owner_identity(&state).await {
            Ok((owner_id, owner_name)) => (owner_id, Some(owner_name)),
            Err(e) => {
                tracing::warn!("owner rename kept its Telegram link: {e}");
                (me.telegram_user_id, me.telegram_username.clone())
            }
        }
    } else {
        match resolve_tg_user_id(&state, &input.username).await {
            Ok(Some(id)) => (Some(id), Some(input.username.clone())),
            Ok(None) => (None, None),
            Err(e) => {
                tracing::warn!("rename of {} kept its Telegram link: {e}", me.username);
                (me.telegram_user_id, me.telegram_username.clone())
            }
        }
    };

    let renamed = UserDoc {
        id: input.username.to_lowercase(),
        username: input.username.clone(),
        password_hash: me.password_hash.clone(),
        role: me.role.clone(),
        telegram_user_id,
        telegram_username,
        telegram_first_name: me.telegram_first_name.clone(),
        telegram_last_name: me.telegram_last_name.clone(),
        permissions: me.permissions,
        storage_chat_id: me.storage_chat_id,
        storage_drives: me.storage_drives.clone(),
        created_at: me.created_at,
        created_by: me.created_by.clone(),
    };

    if let Err(e) = rename_user(&client, &me, &renamed).await {
        // Lost the race against another account taking the name.
        if e.to_string().contains("E11000") {
            return Err(ApiError::Conflict(
                "that username is already taken".to_string(),
            ));
        }
        return Err(e.into());
    }

    // The old token names an account that no longer exists under that
    // username — drop it and hand back one that does.
    if let Some(token) = extract_bearer_token(&headers) {
        remove_session(&state.sessions, &token);
    }
    let token = create_session(&state.sessions, renamed.username.clone());

    Ok(Json(ChangeUsernameResponse {
        username: renamed.username,
        token,
        telegram_username: renamed.telegram_username,
        telegram_user_id: renamed.telegram_user_id,
    }))
}

/// POST /api/auth/change-password — re-password the signed-in account.
///
/// The current password is required: an unattended session must not be able
/// to lock the real holder out of their own account.
async fn auth_change_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<ChangePasswordRequest>,
) -> ApiResult<StatusCode> {
    validate_password(&input.new_password).map_err(ApiError::Validation)?;

    let username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;

    let Some(ref stored_hash) = user.password_hash else {
        return Err(ApiError::InvalidInput(
            "this account has no password yet — claim it by registering".to_string(),
        ));
    };
    if !verify_password_phc(&input.current_password, stored_hash)
        .map_err(|e| ApiError::Internal(e.to_string()))?
    {
        return Err(ApiError::InvalidInput(
            "current password is incorrect".to_string(),
        ));
    }

    let kdf = KdfParams::new();
    let password_hash = hash_password_phc(&input.new_password, &kdf)
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    set_password(&client, &user.id, password_hash).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Validate Step2Input manually (mirrors tfs-config validation)
fn validate_step2(input: &Step2Input) -> Result<(), String> {
    if input.api_id <= 0 {
        return Err("API ID must be a positive integer".to_string());
    }
    if input.api_hash.is_empty() {
        return Err("API hash is required".to_string());
    }
    if input.bot_token_1.is_empty() {
        return Err("Bot token 1 is required".to_string());
    }
    if input.owner_id <= 0 {
        return Err("Owner ID must be a positive integer".to_string());
    }
    if input.default_chat_id == 0 {
        return Err("Default chat ID is required".to_string());
    }
    Ok(())
}

/// Response for GET /api/setup/resume - uses untagged enum to match exact JSON contract
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResumeResponse {
    /// No connection file found: {"saved":false}
    NotSaved(ResumeNotSaved),

    /// Configured: {"saved":true,"configured":true,"api_id":...,"owner_id":...,"bot_count":...}
    Configured(ResumeConfigured),

    /// Valid connection, no config in DB: {"saved":true,"configured":false,"connection":{...}}
    NotConfigured(ResumeNotConfigured),

    /// Password mismatch (file deleted): {"saved":true,"configured":false,"stale":true,"reason":"password-mismatch"}
    StalePasswordMismatch(ResumeStalePasswordMismatch),

    /// Mongo unreachable (file kept): {"saved":true,"configured":false,"stale":true,"reason":"connection-failed","connection":{...}}
    StaleConnectionFailed(ResumeStaleConnectionFailed),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeNotSaved {
    pub saved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeConfigured {
    pub saved: bool,
    pub configured: bool,
    pub api_id: i64,
    pub owner_id: i64,
    pub bot_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeNotConfigured {
    pub saved: bool,
    pub configured: bool,
    pub connection: ConnectionStore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeStalePasswordMismatch {
    pub saved: bool,
    pub configured: bool,
    pub stale: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeStaleConnectionFailed {
    pub saved: bool,
    pub configured: bool,
    pub stale: bool,
    pub reason: String,
    pub connection: ConnectionStore,
}

impl ResumeResponse {
    fn not_saved() -> Self {
        Self::NotSaved(ResumeNotSaved { saved: false })
    }

    fn saved_configured(api_id: i64, owner_id: i64, bot_count: usize) -> Self {
        Self::Configured(ResumeConfigured {
            saved: true,
            configured: true,
            api_id,
            owner_id,
            bot_count,
        })
    }

    fn saved_not_configured(connection: ConnectionStore) -> Self {
        Self::NotConfigured(ResumeNotConfigured {
            saved: true,
            configured: false,
            connection,
        })
    }

    fn saved_stale_password_mismatch() -> Self {
        Self::StalePasswordMismatch(ResumeStalePasswordMismatch {
            saved: true,
            configured: false,
            stale: true,
            reason: "password-mismatch".to_string(),
        })
    }

    fn saved_stale_connection_failed(connection: ConnectionStore) -> Self {
        Self::StaleConnectionFailed(ResumeStaleConnectionFailed {
            saved: true,
            configured: false,
            stale: true,
            reason: "connection-failed".to_string(),
            connection,
        })
    }
}

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("database error: {0}")]
    Database(#[from] DbError),
    #[error("config error: {0}")]
    Config(#[from] ConfigError),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("telegram unavailable: {0}")]
    Telegram(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error_message, detail) = match &self {
            ApiError::Database(e @ DbError::Connection(_)) => {
                // Full technical detail belongs in the server log, never in
                // the user-facing message.
                tracing::error!(error = %e, "MongoDB connection failed");
                (
                    StatusCode::BAD_GATEWAY,
                    e.user_message(),
                    Some(e.to_string()),
                )
            }
            ApiError::Database(DbError::NotFound) => (
                StatusCode::NOT_FOUND,
                "Configuration not found".to_string(),
                None,
            ),
            ApiError::Database(DbError::NotConfigured) => (
                StatusCode::SERVICE_UNAVAILABLE,
                DbError::NotConfigured.to_string(),
                None,
            ),
            ApiError::Config(ConfigError::InvalidPassword(msg)) => {
                (StatusCode::UNAUTHORIZED, msg.clone(), None)
            }
            ApiError::Config(ConfigError::Validation(msg)) => {
                (StatusCode::BAD_REQUEST, msg.clone(), None)
            }
            ApiError::Validation(msg) => (StatusCode::BAD_REQUEST, msg.clone(), None),
            ApiError::InvalidInput(msg) => (StatusCode::BAD_REQUEST, msg.clone(), None),
            ApiError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg.clone(), None),
            ApiError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone(), None),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone(), None),
            ApiError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone(), None),
            ApiError::Telegram(msg) => {
                tracing::error!(error = %msg, "Telegram lookup unavailable");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    msg.clone(),
                    Some(msg.clone()),
                )
            }
            _ => {
                tracing::error!(error = %self, "unhandled API error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Something went wrong on the server. Please check the server logs.".to_string(),
                    Some(self.to_string()),
                )
            }
        };

        let body = match detail {
            Some(detail) => Json(serde_json::json!({ "error": error_message, "detail": detail })),
            None => Json(serde_json::json!({ "error": error_message })),
        };
        let mut response = (status, body).into_response();
        // Tell a browser/player how to authenticate instead of failing silently.
        if matches!(self, ApiError::Unauthorized(_)) {
            response
                .headers_mut()
                .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        response
    }
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;

#[derive(Clone)]
pub struct AppState {
    pub mongo_uri: String,
    pub sessions: SessionStore,
    /// Owner-identity resolution strategy (env-overridable, see `OwnerResolver`).
    pub owner_resolver: OwnerResolver,
    /// Lazily-connected Telegram lookup client (owner/username sync).
    tg: Arc<tokio::sync::Mutex<Option<GrammersClient>>>,
    /// Lazily-built Mongo client, shared for the process lifetime.
    ///
    /// `mongodb::Client` owns a connection pool and performs topology discovery
    /// when it is built. The auth/admin handlers used to call `connect()` on
    /// every request, repeating that work and dropping the pool as soon as the
    /// response was written.
    mongo: Arc<tokio::sync::OnceCell<Client>>,
    /// Lazily-built bot pool for uploads and streams. Nothing connects to
    /// Telegram until the first transfer: the setup wizard may not have run.
    transfer: Arc<tokio::sync::OnceCell<Arc<BotPool>>>,
    /// Pending owner claims: secret -> entry (see the claim flow above).
    claims: ClaimStore,
    /// Lazily-started claim bot (its @username builds t.me deep links).
    claim_bot: Arc<tokio::sync::OnceCell<Arc<ClaimBotHandle>>>,
    /// Broadcast bus for `/api/events` SSE subscribers. Payloads are JSON
    /// objects shaped `{ "type": ..., "payload": ... }`.
    events: tokio::sync::broadcast::Sender<serde_json::Value>,
    /// Shared state for the history indexer: whether a run is active and
    /// how many messages it has scanned/indexed so far. Guarded by a mutex
    /// so only one indexing task runs at a time per process.
    indexer: Arc<tokio::sync::Mutex<IndexerState>>,
    /// Per-user Telegram profile-photo cache (tg user id → bytes + timestamp).
    photo_cache: Arc<Mutex<HashMap<i64, CachedPhoto>>>,
    /// Server-side cache of Telegram message thumbnails, shared for the life
    /// of the process.
    thumbnails: &'static thumbnails::ThumbnailCache,
}

/// Snapshot of the history indexer's progress, published via SSE and
/// returned by `POST /api/fs/index` when a run is already in flight.
#[derive(Debug, Clone, Default)]
struct IndexerState {
    running: bool,
    scanned: u64,
    indexed: u64,
    last_error: Option<String>,
}

impl AppState {
    pub fn new(mongo_uri: String) -> Self {
        Self {
            mongo_uri,
            sessions: new_session_store(),
            owner_resolver: OwnerResolver::from_env(),
            tg: Arc::new(tokio::sync::Mutex::new(None)),
            mongo: Arc::new(tokio::sync::OnceCell::new()),
            transfer: Arc::new(tokio::sync::OnceCell::new()),
            claims: Arc::new(Mutex::new(HashMap::new())),
            claim_bot: Arc::new(tokio::sync::OnceCell::new()),
            events: tokio::sync::broadcast::channel(64).0,
            indexer: Arc::new(tokio::sync::Mutex::new(IndexerState::default())),
            photo_cache: Arc::new(Mutex::new(HashMap::new())),
            thumbnails: thumbnails::ThumbnailCache::global(),
        }
    }

    /// The process-wide thumbnail cache.
    pub(crate) fn thumbnails(&self) -> &thumbnails::ThumbnailCache {
        self.thumbnails
    }

    /// Publish one event to every `/api/events` SSE subscriber. A closed or
    /// empty subscriber list is fine — nothing is listening yet.
    pub fn publish_event(&self, event_type: &str, payload: serde_json::Value) {
        let _ = self.events.send(serde_json::json!({
            "type": event_type,
            "payload": payload,
        }));
    }

    /// The shared Mongo client, built on first use with the same fast timeouts
    /// and ping as `tfs_db::connect`.
    ///
    /// A failed attempt is not cached, so a transient outage still recovers on
    /// the next request instead of latching an unusable client.
    pub async fn mongo_client(&self) -> Result<Client, DbError> {
        let uri = self.resolve_mongo_uri()?;
        let client = self.mongo.get_or_try_init(|| connect(&uri)).await?;
        Ok(client.clone())
    }

    /// The MongoDB URI this process should talk to: whatever the setup
    /// wizard stored in config.tfs. No environment variable and no
    /// localhost default — the operator supplies a URI (a cloud cluster
    /// in practice) and the wizard persists it.
    ///
    /// Resolved per call rather than captured at boot, so a wizard run
    /// against an already-serving process takes effect immediately.
    fn resolve_mongo_uri(&self) -> Result<String, DbError> {
        if !self.mongo_uri.is_empty() {
            // Tests and CI build state with an explicit URI.
            return Ok(self.mongo_uri.clone());
        }
        match load_connection() {
            Ok(Some(store)) => Ok(store.mongo_uri),
            Ok(None) | Err(_) => Err(DbError::NotConfigured),
        }
    }

    /// The bot pool backing uploads and streams, built on first use from the
    /// saved config.
    ///
    /// As with `mongo_client`, a failed build is not cached: a wizard that
    /// has not run yet must not permanently disable transfers.
    pub(crate) async fn transfer_pool(&self) -> Result<Arc<BotPool>, ApiError> {
        let pool = self
            .transfer
            .get_or_try_init(|| async {
                let creds = load_telegram_creds()?;
                tracing::info!(
                    "transfer pool ready with {} bot token(s)",
                    creds.bot_tokens.len()
                );
                Ok::<Arc<BotPool>, ApiError>(BotPool::new(
                    creds.api_id,
                    creds.api_hash,
                    creds.bot_tokens,
                    &get_bin_dir(),
                ))
            })
            .await?;
        Ok(Arc::clone(pool))
    }

    /// Start (once per process) the claim bot listener and return its handle.
    ///
    /// The first connection runs inline so its @username is available for the
    /// deep link; afterwards a background task keeps the listener alive with
    /// reconnect/backoff. A failed first connect is not cached, so a transient
    /// Telegram outage does not permanently disable claiming.
    pub(crate) async fn ensure_claim_bot(&self) -> Result<Arc<ClaimBotHandle>, ApiError> {
        let handle = self
            .claim_bot
            .get_or_try_init(|| async {
                let creds = load_telegram_creds()?;
                let token = creds
                    .bot_tokens
                    .first()
                    .cloned()
                    .ok_or_else(|| ApiError::Telegram("no bot token configured".to_string()))?;
                let session_path = get_bin_dir().join("claim-bot.session");
                let bot = ClaimBot::connect(
                    creds.api_id,
                    creds.api_hash.clone(),
                    token.clone(),
                    session_path.clone(),
                )
                .await
                .map_err(|e| ApiError::Telegram(format!("claim bot failed to connect: {e}")))?;
                let bot_username = bot.bot_username().to_string();
                tracing::info!(bot_username = %bot_username, "claim bot ready");

                let claims = Arc::clone(&self.claims);
                let api_id = creds.api_id;
                let api_hash = creds.api_hash.clone();
                tokio::spawn(async move {
                    let mut bot = Some(bot);
                    let mut attempt = 0u32;
                    loop {
                        let current = match bot.take() {
                            Some(b) => b,
                            None => {
                                match ClaimBot::connect(
                                    api_id,
                                    api_hash.clone(),
                                    token.clone(),
                                    session_path.clone(),
                                )
                                .await
                                {
                                    Ok(b) => b,
                                    Err(e) => {
                                        tracing::error!(error = %e, attempt, "claim bot reconnect failed");
                                        attempt += 1;
                                        let delay =
                                            std::cmp::min(30, 1u64 << attempt.min(5));
                                        tokio::time::sleep(Duration::from_secs(delay)).await;
                                        continue;
                                    }
                                }
                            }
                        };
                        attempt = 0;
                        let store = Arc::clone(&claims);
                        let result = current
                            .run(move |ev| {
                                let mut map = store.lock().unwrap();
                                match map.get_mut(&ev.secret) {
                                    Some(entry) if entry.verified => {
                                        "This link was already used. Start again from TelegramFileServer.".to_string()
                                    }
                                    Some(entry) => {
                                        match entry.expected_sender {
                                            Some(expected) if expected != ev.sender_id => {
                                                "This link is not valid for your Telegram account.".to_string()
                                            }
                                            _ => {
                                                entry.verified = true;
                                                entry.verified_by = Some(ev.sender_id);
                                                entry.verified_username = ev.sender_username;
                                                entry.verified_first_name = ev.sender_first_name;
                                                entry.verified_last_name = ev.sender_last_name;
                                                "Verified. Return to TelegramFileServer to finish creating your account.".to_string()
                                            }
                                        }
                                    }
                                    None => "Unknown or expired link. Start again from TelegramFileServer.".to_string(),
                                }
                            })
                            .await;
                        tracing::warn!(?result, "claim bot listener stopped");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                });

                Ok::<Arc<ClaimBotHandle>, ApiError>(Arc::new(ClaimBotHandle { bot_username }))
            })
            .await?;
        Ok(Arc::clone(handle))
    }

    /// Tests/dev: fixed owner identity, no Telegram involved.
    #[cfg(test)]
    fn with_owner_resolver(mut self, resolver: OwnerResolver) -> Self {
        self.owner_resolver = resolver;
        self
    }
}

/// POST /api/setup/check
async fn check_setup(
    State(_state): State<Arc<AppState>>,
    Json(input): Json<Step1Input>,
) -> ApiResult<Json<CheckResponse>> {
    validate_step1(&input).map_err(ApiError::Validation)?;

    // The URI typed in the wizard is authoritative — do NOT read the saved
    // config.tfs here: this request is what decides which database the rest
    // of the setup will live in.
    let client = connect(&input.mongo_uri).await?;
    tracing::info!("Setup check: MongoDB reachable");

    if !has_config(&client).await? {
        // No config in MongoDB — any local mirror is stale.
        if let Err(e) = delete_local_config() {
            tracing::warn!("Failed to delete stale local config mirror: {}", e);
        }
        return Ok(Json(CheckResponse {
            configured: false,
            api_id: None,
            owner_id: None,
            bot_count: None,
            error: None,
        }));
    }

    let config = load_config(&client).await?;
    let sensitive = verify_and_decrypt(&config, &input.password)?;

    // Persist connection on successful verification
    let store = ConnectionStore {
        mongo_uri: input.mongo_uri.clone(),
        password: input.password.clone(),
    };
    if let Err(e) = save_connection(&store) {
        tracing::warn!("Failed to persist connection: {}", e);
    }
    // Mirror the downloaded config locally so future resumes are local-first.
    if let Err(e) = save_local_config(&config, &sensitive, &input.password) {
        tracing::warn!("Failed to mirror setup config locally: {}", e);
    } else {
        tracing::info!("Setup check: config mirrored to local config.tfs");
    }

    Ok(Json(CheckResponse {
        configured: true,
        api_id: Some(sensitive.api_id),
        owner_id: Some(config.owner_id),
        bot_count: Some(sensitive.bot_tokens.len()),
        error: None,
    }))
}

/// POST /api/setup/save
async fn save_setup(
    State(_state): State<Arc<AppState>>,
    Json(input): Json<SaveSetupInput>,
) -> ApiResult<Json<SaveResponse>> {
    // Validate step1 (uses the URI the user saved in step 1 / resume state)
    let step1 = Step1Input {
        mongo_uri: input.mongo_uri.clone(),
        password: input.password.clone(),
    };
    validate_step1(&step1).map_err(ApiError::Validation)?;

    // Validate step2
    let step2 = Step2Input {
        api_id: input.api_id,
        api_hash: input.api_hash.clone(),
        bot_token_1: input.bot_token_1.clone(),
        bot_token_2: input.bot_token_2.clone(),
        bot_token_3: input.bot_token_3.clone(),
        owner_id: input.owner_id,
        default_chat_id: input.default_chat_id,
    };
    validate_step2(&step2).map_err(ApiError::Validation)?;

    let client = connect(&step1.mongo_uri).await?;
    tracing::info!("Setup save: MongoDB reachable");

    // Check if config already exists
    if has_config(&client).await? {
        // Verify password matches existing config
        let existing = load_config(&client).await?;
        verify_and_decrypt(&existing, &input.password).map_err(|_| {
            ApiError::Config(ConfigError::InvalidPassword(
                "password doesn't match existing config".to_string(),
            ))
        })?;
    }

    let config = create_setup_config(&step1, &step2)?;
    save_config(&client, &config).await?;
    tracing::info!("Setup save: configuration written to MongoDB");

    // Keep the local mirror in sync with MongoDB (cheap local KDF).
    let sensitive = verify_and_decrypt(&config, &input.password)?;
    if let Err(e) = save_local_config(&config, &sensitive, &input.password) {
        tracing::warn!("Failed to mirror setup config locally: {}", e);
    }

    // Persist connection after successful save
    let store = ConnectionStore {
        mongo_uri: input.mongo_uri.clone(),
        password: input.password.clone(),
    };
    if let Err(e) = save_connection(&store) {
        tracing::warn!("Failed to persist connection: {}", e);
    }

    Ok(Json(SaveResponse {
        ok: true,
        error: None,
    }))
}

/// GET /api/setup/resume
async fn resume_setup(State(_state): State<Arc<AppState>>) -> ApiResult<Json<ResumeResponse>> {
    // Try to load connection from local storage
    let Some(store) = load_connection()? else {
        return Ok(Json(ResumeResponse::not_saved()));
    };

    // Local-first: the mirrored setup config opens without touching
    // MongoDB, so a restarted server (or an offline one) lands straight on
    // the wizard's final step in milliseconds. MongoDB is only the fallback.
    // No PHC verify here — the AEAD tag authenticates the password, and the
    // local files use the cheap KDF params (see KdfParams::local).
    let local_started = std::time::Instant::now();
    match load_local_config(&store.password) {
        Ok(Some(local)) => {
            tracing::info!(
                elapsed_ms = local_started.elapsed().as_millis() as u64,
                "Resume: answered from local config, MongoDB skipped"
            );
            return Ok(Json(ResumeResponse::saved_configured(
                local.sensitive.api_id,
                local.owner_id,
                local.sensitive.bot_tokens.len(),
            )));
        }
        Ok(None) => {
            tracing::warn!(
                "Resume: local config missing or password does not open it; falling back to MongoDB"
            );
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                "Resume: unreadable local config mirror; falling back to MongoDB"
            );
        }
    }

    // Fallback: connect to MongoDB
    let client = match connect(&store.mongo_uri).await {
        Ok(c) => c,
        Err(err) => {
            // Case 5: MongoDB unreachable - keep file, return stale with connection info
            tracing::warn!(error = %err, "Resume: cannot reach MongoDB at saved URI");
            return Ok(Json(ResumeResponse::saved_stale_connection_failed(store)));
        }
    };

    // Check if config exists in database
    let has_config_doc = match has_config(&client).await {
        Ok(true) => true,
        Ok(false) => false,
        Err(err) => {
            // DB error - treat as connection failed
            tracing::warn!(error = %err, "Resume: error while checking for setup config");
            return Ok(Json(ResumeResponse::saved_stale_connection_failed(store)));
        }
    };

    if !has_config_doc {
        // Case 3: Connection file exists but no config doc in DB — the local
        // mirror (if any) is stale too.
        if let Err(e) = delete_local_config() {
            tracing::warn!("Failed to delete stale local config mirror: {}", e);
        }
        return Ok(Json(ResumeResponse::saved_not_configured(store)));
    }

    // Config exists - try to verify password
    let config = match load_config(&client).await {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(error = %err, "Resume: error while loading setup config");
            return Ok(Json(ResumeResponse::saved_stale_connection_failed(store)));
        }
    };

    match verify_and_decrypt(&config, &store.password) {
        Ok(sensitive) => {
            // Case 2: Password verifies - return configured info.
            // Refresh the local mirror so the next resume is local-first.
            if let Err(e) = save_local_config(&config, &sensitive, &store.password) {
                tracing::warn!("Failed to mirror setup config locally: {}", e);
            }
            Ok(Json(ResumeResponse::saved_configured(
                sensitive.api_id,
                config.owner_id,
                sensitive.bot_tokens.len(),
            )))
        }
        Err(err) => {
            // Case 4: Password mismatch - delete file and return stale
            tracing::warn!(
                error = %err,
                "Resume: stored password no longer verifies; discarding saved connection"
            );
            let _ = delete_connection();
            let _ = delete_local_config();
            Ok(Json(ResumeResponse::saved_stale_password_mismatch()))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SaveSetupInput {
    pub mongo_uri: String,
    pub password: String,
    pub api_id: i64,
    pub api_hash: String,
    pub bot_token_1: String,
    pub bot_token_2: Option<String>,
    pub bot_token_3: Option<String>,
    pub owner_id: i64,
    /// Missing field maps to 0 so validation returns our friendly message
    /// instead of a bare serde 422.
    #[serde(default)]
    pub default_chat_id: i64,
}

// ===== Admin user management =====

/// Admin-facing user view (never exposes password hashes).
#[derive(Debug, Serialize)]
struct UserSummary {
    username: String,
    role: String,
    permissions: Permissions,
    /// Upload destination chat; `None` = the configured default chat.
    storage_chat_id: Option<i64>,
    telegram_username: Option<String>,
    telegram_user_id: Option<i64>,
    /// False until the invited owner has set their password.
    claimed: bool,
    /// True for the bootstrap owner account.
    is_owner: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    created_by: Option<String>,
}

impl From<&UserDoc> for UserSummary {
    fn from(u: &UserDoc) -> Self {
        Self {
            username: u.username.clone(),
            role: u.role.clone(),
            permissions: u.permissions,
            storage_chat_id: u.storage_chat_id,
            telegram_username: u.telegram_username.clone(),
            telegram_user_id: u.telegram_user_id,
            claimed: u.claimed(),
            is_owner: u.is_owner(),
            created_at: u.created_at,
            created_by: u.created_by.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
struct AdminUsersResponse {
    users: Vec<UserSummary>,
}

#[derive(Debug, Deserialize)]
struct AdminCreateUserRequest {
    username: String,
}

#[derive(Debug, Deserialize)]
struct PermissionsPatch {
    read: Option<bool>,
    write: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct AdminUpdateUserRequest {
    #[serde(default)]
    permissions: Option<PermissionsPatch>,
    #[serde(default)]
    role: Option<String>,
    /// Three states: absent = leave alone, `null` = clear (fall back to the
    /// default chat), number = set.
    ///
    /// Plain `Option<Option<i64>>` cannot express this: serde reads a JSON
    /// `null` as "absent" on the outer option, so clearing would be
    /// indistinguishable from not asking.
    #[serde(default, deserialize_with = "patch_option")]
    storage_chat_id: Option<Option<i64>>,
}

fn patch_option<'de, D>(deserializer: D) -> Result<Option<Option<i64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct PatchVisitor;

    impl<'de> serde::de::Visitor<'de> for PatchVisitor {
        type Value = Option<Option<i64>>;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a chat id, or null to clear it")
        }

        fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(Some(None))
        }

        fn visit_some<D2: serde::Deserializer<'de>>(
            self,
            deserializer: D2,
        ) -> Result<Self::Value, D2::Error> {
            Ok(Some(Some(i64::deserialize(deserializer)?)))
        }
    }

    deserializer.deserialize_option(PatchVisitor)
}

/// Require a valid session AND the admin role; returns the acting user.
async fn require_admin(headers: &HeaderMap, state: &AppState) -> Result<UserDoc, ApiError> {
    let username = require_session(headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    if !user.is_admin() {
        return Err(ApiError::Forbidden(
            "administrator access required".to_string(),
        ));
    }
    Ok(user)
}

/// GET /api/admin/users — full user list (admin only)
async fn admin_list_users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<AdminUsersResponse>> {
    let _actor = require_admin(&headers, &state).await?;
    let client = state.mongo_client().await?;
    let users = list_users(&client).await?;
    Ok(Json(AdminUsersResponse {
        users: users.iter().map(UserSummary::from).collect(),
    }))
}

/// POST /api/admin/users — create a username-only invite (no password;
/// the invited owner claims it via register).
///
/// Telegram sync is best-effort: creation succeeds even when the lookup
/// fails (no config / not resolvable) — the admin can resync later.
async fn admin_create_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<AdminCreateUserRequest>,
) -> ApiResult<(StatusCode, Json<UserSummary>)> {
    validate_username(&input.username).map_err(ApiError::Validation)?;
    let actor = require_admin(&headers, &state).await?;
    let client = state.mongo_client().await?;
    if find_user(&client, &input.username).await?.is_some() {
        return Err(ApiError::Conflict("username already exists".to_string()));
    }

    let (telegram_user_id, telegram_username) = match resolve_tg_user_id(&state, &input.username)
        .await
    {
        Ok(Some(id)) => (Some(id), Some(input.username.clone())),
        Ok(None) => {
            tracing::info!(
                "invite {} created unlinked — no Telegram user resolves to that username (resync later)",
                input.username
            );
            (None, None)
        }
        Err(e) => {
            tracing::warn!("telegram sync skipped for invite {}: {}", input.username, e);
            (None, None)
        }
    };

    let user = UserDoc {
        id: input.username.to_lowercase(),
        username: input.username.clone(),
        password_hash: None,
        role: "user".to_string(),
        telegram_user_id,
        telegram_username,
        telegram_first_name: None,
        telegram_last_name: None,
        permissions: default_permissions(),
        storage_chat_id: None,
        storage_drives: Vec::new(),
        created_at: chrono::Utc::now(),
        created_by: Some(actor.username.clone()),
    };
    match insert_user(&client, &user).await {
        Ok(()) => {}
        Err(DbError::Connection(e)) if e.to_string().contains("E11000") => {
            return Err(ApiError::Conflict("username already exists".to_string()));
        }
        Err(e) => return Err(e.into()),
    }
    Ok((StatusCode::CREATED, Json(UserSummary::from(&user))))
}

/// PATCH /api/admin/users/:username — update permissions and/or role.
///
/// Guards: can't touch your own role, can't touch the owner's role,
/// can't demote the last administrator.
async fn admin_update_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(username): Path<String>,
    Json(input): Json<AdminUpdateUserRequest>,
) -> ApiResult<Json<UserSummary>> {
    let actor = require_admin(&headers, &state).await?;
    let client = state.mongo_client().await?;
    let target = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::NotFound("user not found".to_string()))?;

    let mut fields = bson::Document::new();

    if let Some(role) = &input.role {
        if role != "admin" && role != "user" {
            return Err(ApiError::Validation(
                "role must be \"admin\" or \"user\"".to_string(),
            ));
        }
        if target.id == actor.id {
            return Err(ApiError::Forbidden(
                "cannot change your own role".to_string(),
            ));
        }
        if target.is_owner() {
            return Err(ApiError::Forbidden(
                "cannot change the owner's role".to_string(),
            ));
        }
        if role == "user" && target.is_admin() && count_role(&client, "admin").await? <= 1 {
            return Err(ApiError::Forbidden(
                "cannot demote the last administrator".to_string(),
            ));
        }
        fields.insert("role", role.as_str());
    }

    if let Some(patch) = &input.permissions {
        let mut perms = target.permissions;
        if let Some(r) = patch.read {
            perms.read = r;
        }
        if let Some(w) = patch.write {
            perms.write = w;
        }
        let bson_perms = bson::to_bson(&perms)
            .map_err(|e| ApiError::Internal(format!("permissions serialization: {e}")))?;
        fields.insert("permissions", bson_perms);
    }

    if let Some(chat) = input.storage_chat_id {
        match chat {
            // 0 is never a valid Telegram chat id; negatives are groups/channels.
            Some(0) => {
                return Err(ApiError::Validation(
                    "storage_chat_id must be a real chat id (0 is invalid, negatives are valid)"
                        .to_string(),
                ));
            }
            Some(id) => {
                fields.insert("storage_chat_id", id);
            }
            None => {
                fields.insert("storage_chat_id", bson::Bson::Null);
            }
        }
    }

    if fields.is_empty() {
        return Err(ApiError::Validation(
            "nothing to update — provide role, permissions and/or storage_chat_id".to_string(),
        ));
    }

    update_user_fields(&client, &target.id, fields).await?;
    let updated = find_user(&client, &target.id)
        .await?
        .ok_or_else(|| ApiError::NotFound("user not found".to_string()))?;
    Ok(Json(UserSummary::from(&updated)))
}

/// DELETE /api/admin/users/:username — remove an account.
///
/// Guards: can't delete yourself, the owner, or the last administrator.
async fn admin_delete_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> ApiResult<StatusCode> {
    let actor = require_admin(&headers, &state).await?;
    let client = state.mongo_client().await?;
    let target = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::NotFound("user not found".to_string()))?;

    if target.id == actor.id {
        return Err(ApiError::Forbidden(
            "cannot delete your own account".to_string(),
        ));
    }
    if target.is_owner() {
        return Err(ApiError::Forbidden(
            "cannot delete the owner account".to_string(),
        ));
    }
    if target.is_admin() && count_role(&client, "admin").await? <= 1 {
        return Err(ApiError::Forbidden(
            "cannot delete the last administrator".to_string(),
        ));
    }
    delete_user(&client, &target.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/admin/users/:username/resync — re-run the Telegram username
/// sync. Fatal on lookup failure (admin action: surface the reason so they
/// can retry). Unresolvable username clears the stored link.
async fn admin_resync_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> ApiResult<Json<UserSummary>> {
    let _actor = require_admin(&headers, &state).await?;
    let client = state.mongo_client().await?;
    let target = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::NotFound("user not found".to_string()))?;

    let tg_id = resolve_tg_user_id(&state, &target.username).await?;
    let mut fields = bson::Document::new();
    fields.insert(
        "telegram_user_id",
        tg_id.map(bson::Bson::from).unwrap_or(bson::Bson::Null),
    );
    fields.insert(
        "telegram_username",
        match tg_id {
            Some(_) => bson::Bson::String(target.username.clone()),
            None => bson::Bson::Null,
        },
    );
    update_user_fields(&client, &target.id, fields).await?;
    let updated = find_user(&client, &target.id)
        .await?
        .ok_or_else(|| ApiError::NotFound("user not found".to_string()))?;
    Ok(Json(UserSummary::from(&updated)))
}

// ===== Telegram file transfer: upload, download, watch =====

/// Where an upload goes: the account's own chat when it has one, otherwise
/// the fallback chat from the setup wizard.
fn storage_chat_for(user: &UserDoc, default_chat_id: i64) -> i64 {
    user.storage_chat_id.unwrap_or(default_chat_id)
}

/// True when `chat_id` may be browsed/uploaded as a drive by this user:
/// either it is the effective storage chat, or it is one of the user's
/// registered extra drives.
fn drive_chat_allowed(user: &UserDoc, effective: i64, chat_id: i64) -> bool {
    chat_id == effective || user.storage_drives.iter().any(|d| d.chat_id == chat_id)
}

/// Fallback chat id from `v2_setup` (stored in the clear, next to the
/// encrypted payload — no wizard password needed to serve files).
async fn default_chat_id(client: &mongodb::Client) -> ApiResult<i64> {
    let config = load_config(client).await?;
    if config.default_chat_id == 0 {
        return Err(ApiError::Telegram(
            "no storage chat configured — finish the setup wizard".to_string(),
        ));
    }
    Ok(config.default_chat_id)
}

// ===== Storage settings (usage stats + chat management) =====

/// One media-type slice of the caller's Telegram storage.
#[derive(Debug, Serialize)]
struct StorageStatsBucket {
    media_type: String,
    count: i64,
    total_bytes: i64,
}

#[derive(Debug, Serialize)]
struct StorageStatsResponse {
    buckets: Vec<StorageStatsBucket>,
    total_files: i64,
    total_bytes: i64,
}

/// GET /api/fs/stats — byte/count totals per media type for the caller's
/// files (recycled items excluded). Powers the storage pie chart.
async fn fs_storage_stats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<StorageStatsResponse>> {
    let owner = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let coll: Collection<bson::Document> = client
        .database(&data_database_name())
        .collection(files::FileDoc::COLLECTION_NAME);
    let pipeline = vec![
        doc! { "$match": { "owner_id": &owner, "original_path": null } },
        doc! { "$group": {
            "_id": "$media_type",
            "count": { "$sum": 1i64 },
            "total_bytes": { "$sum": "$file_size" },
        } },
        doc! { "$sort": { "total_bytes": -1i64 } },
    ];
    let mut cursor = coll
        .aggregate(pipeline)
        .await
        .map_err(|e| ApiError::Database(DbError::from(e)))?;
    let mut buckets = Vec::new();
    while let Some(row) = cursor
        .try_next()
        .await
        .map_err(|e| ApiError::Database(DbError::from(e)))?
    {
        let media_type = row
            .get_str("_id")
            .unwrap_or("document")
            .to_string();
        let count = row.get_i64("count").unwrap_or(0);
        let total_bytes = row.get_i64("total_bytes").unwrap_or(0);
        buckets.push(StorageStatsBucket {
            media_type,
            count,
            total_bytes,
        });
    }
    let total_files = buckets.iter().map(|b| b.count).sum();
    let total_bytes = buckets.iter().map(|b| b.total_bytes).sum();
    Ok(Json(StorageStatsResponse {
        buckets,
        total_files,
        total_bytes,
    }))
}

/// Current storage-chat view for the signed-in user.
#[derive(Debug, Serialize)]
struct StorageChatResponse {
    /// Setup-wizard fallback every account uses unless overridden.
    default_chat_id: i64,
    /// Per-account override; `None` = follow the default.
    user_storage_chat_id: Option<i64>,
    /// What uploads actually use right now.
    effective_chat_id: i64,
    /// True when the caller may change the global default (admin).
    can_change_default: bool,
}

#[derive(Debug, Deserialize)]
struct StorageChatPut {
    /// Personal override. Absent = unchanged; `null` = clear (use default).
    #[serde(default)]
    storage_chat_id: Option<Option<i64>>,
    /// Global default — admin only. 0 is invalid; negatives are valid.
    #[serde(default)]
    default_chat_id: Option<i64>,
}

/// GET /api/storage/chat — default + personal override + effective chat id.
async fn storage_chat_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<StorageChatResponse>> {
    let username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    let default = default_chat_id(&client).await.unwrap_or(0);
    let is_admin = user.is_admin();
    Ok(Json(StorageChatResponse {
        // The global default chat is admin-only (r/w): mask it from others.
        default_chat_id: if is_admin { default } else { 0 },
        user_storage_chat_id: user.storage_chat_id,
        effective_chat_id: storage_chat_for(&user, default),
        can_change_default: is_admin,
    }))
}

/// PUT /api/storage/chat — set/clear the personal override; admins may also
/// replace the global default chat in the same call.
async fn storage_chat_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<StorageChatPut>,
) -> ApiResult<Json<StorageChatResponse>> {
    let username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let mut user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;

    if let Some(new_default) = input.default_chat_id {
        if !user.is_admin() {
            return Err(ApiError::Forbidden(
                "administrator access required to change the default chat".to_string(),
            ));
        }
        if new_default == 0 {
            return Err(ApiError::Validation(
                "default_chat_id must be a real chat id (0 is invalid, negatives are valid)"
                    .to_string(),
            ));
        }
        let mut config = load_config(&client).await?;
        config.default_chat_id = new_default;
        save_config(&client, &config).await?;
    }

    if let Some(personal) = input.storage_chat_id {
        match personal {
            Some(0) => {
                return Err(ApiError::Validation(
                    "storage_chat_id must be a real chat id (0 is invalid, negatives are valid)"
                        .to_string(),
                ));
            }
            Some(id) => {
                update_user_fields(&client, &user.id, doc! { "storage_chat_id": id }).await?;
                user.storage_chat_id = Some(id);
            }
            None => {
                update_user_fields(
                    &client,
                    &user.id,
                    doc! { "storage_chat_id": bson::Bson::Null },
                )
                .await?;
                user.storage_chat_id = None;
            }
        }
    }

    let default = default_chat_id(&client).await.unwrap_or(0);
    let is_admin = user.is_admin();
    Ok(Json(StorageChatResponse {
        default_chat_id: if is_admin { default } else { 0 },
        user_storage_chat_id: user.storage_chat_id,
        effective_chat_id: storage_chat_for(&user, default),
        can_change_default: is_admin,
    }))
}

/// Serialized drive list for the signed-in user.
#[derive(Debug, Serialize)]
struct StorageDrivesResponse {
    drives: Vec<DriveEntry>,
}

#[derive(Debug, Deserialize)]
struct StorageDrivePut {
    chat_id: i64,
    #[serde(default)]
    label: String,
}

/// GET /api/storage/drives — the caller's extra browseable drive chats.
async fn storage_drives_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<StorageDrivesResponse>> {
    let username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    Ok(Json(StorageDrivesResponse {
        drives: user.storage_drives,
    }))
}

/// POST /api/storage/drives — register an extra drive chat.
///
/// The bot must be able to read the chat, so the add is probed with
/// `latest_message_id` before it is persisted: an unreadable chat fails
/// fast instead of surfacing later as an empty sidebar entry.
async fn storage_drives_post(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<StorageDrivePut>,
) -> ApiResult<(StatusCode, Json<StorageDrivesResponse>)> {
    if input.chat_id == 0 {
        return Err(ApiError::Validation(
            "chat_id must be a real chat id (0 is invalid, negatives are valid)".to_string(),
        ));
    }
    let username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let mut user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;

    if user.storage_drives.iter().any(|d| d.chat_id == input.chat_id) {
        return Err(ApiError::Conflict(format!(
            "chat {} is already a drive",
            input.chat_id
        )));
    }

    // Probe readability before saving — the bot must be a member of the chat.
    {
        let pool = state.transfer_pool().await?;
        let lease = pool
            .lease()
            .await
            .map_err(|e| ApiError::Telegram(e.to_string()))?;
        lease
            .client()
            .latest_message_id(input.chat_id)
            .await
            .map_err(|e| {
                ApiError::Validation(format!(
                    "bot cannot read chat {chat_id}: {e}",
                    chat_id = input.chat_id
                ))
            })?;
    }

    let entry = DriveEntry {
        chat_id: input.chat_id,
        label: input.label.trim().to_string(),
    };
    user.storage_drives.push(entry);
    update_user_fields(
        &client,
        &user.id,
        doc! { "storage_drives": bson::to_bson(&user.storage_drives).map_err(|e| ApiError::Internal(e.to_string()))? },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(StorageDrivesResponse {
            drives: user.storage_drives,
        }),
    ))
}

/// DELETE /api/storage/drives/{chat_id} — drop one drive from the caller.
async fn storage_drives_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(chat_id): Path<i64>,
) -> ApiResult<Json<StorageDrivesResponse>> {
    let username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let mut user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;

    let before = user.storage_drives.len();
    user.storage_drives.retain(|d| d.chat_id != chat_id);
    if user.storage_drives.len() == before {
        return Err(ApiError::NotFound(format!("no drive for chat {chat_id}")));
    }
    update_user_fields(
        &client,
        &user.id,
        doc! { "storage_drives": bson::to_bson(&user.storage_drives).map_err(|e| ApiError::Internal(e.to_string()))? },
    )
    .await?;
    Ok(Json(StorageDrivesResponse {
        drives: user.storage_drives,
    }))
}

/// One file spooled to disk, ready to be handed to Telegram.
///
/// `send_document` takes a path, so a multipart body has to land somewhere
/// first; the temp file is removed when this value drops.
struct StagedUpload {
    file_name: String,
    path: PathBuf,
    size: u64,
    _temp: tempfile::TempDir,
}

/// Stream one multipart field into a temp file.
///
/// The bytes land at `<tempdir>/<original-file-name>` (extension included)
/// rather than a random `tfs-upload-*` name: grammers derives the Telegram
/// `DocumentAttributeFilename` — and the mime type — from the basename of the
/// path it uploads, so staging under a random name would strip the extension
/// and rename the file on Telegram.
async fn stage_upload(
    file_name: &str,
    field: &mut axum::extract::multipart::Field<'_>,
) -> ApiResult<StagedUpload> {
    let dir = tempfile::tempdir()
        .map_err(|e| ApiError::Internal(format!("could not create a temp dir: {e}")))?;
    let path = dir.path().join(file_name);
    let mut out = tokio::fs::File::create(&path)
        .await
        .map_err(|e| ApiError::Internal(format!("could not open a temp file: {e}")))?;

    let mut size = 0u64;
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|e| ApiError::Validation(format!("malformed upload body: {e}")))?
    {
        out.write_all(&chunk)
            .await
            .map_err(|e| ApiError::Internal(format!("could not write the upload: {e}")))?;
        size += chunk.len() as u64;
    }
    out.flush()
        .await
        .map_err(|e| ApiError::Internal(format!("could not write the upload: {e}")))?;
    drop(out);

    Ok(StagedUpload {
        file_name: file_name.to_string(),
        path,
        size,
        _temp: dir,
    })
}

/// POST /api/files/upload — multipart upload into Telegram.
///
/// Fields: `file` (required, the payload) and `path` (optional destination
/// folder, e.g. `/Home/Images`).
async fn files_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<files::FileSummary>)> {
    let username = require_session(&headers, &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    if !user.permissions.write {
        return Err(ApiError::Forbidden(
            "this account cannot upload files".to_string(),
        ));
    }

    let mut folder: Option<String> = None;
    let mut upload_chat_id: Option<i64> = None;
    let mut staged: Option<StagedUpload> = None;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::Validation(format!("malformed multipart body: {e}")))?
    {
        let name = field.name().map(str::to_string);
        match name.as_deref() {
            Some("path") => {
                let raw = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::Validation(format!("malformed path field: {e}")))?;
                folder = Some(String::from_utf8_lossy(&raw).into_owned());
            }
            Some("chat_id") => {
                let raw = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::Validation(format!("malformed chat_id field: {e}")))?;
                let text = String::from_utf8_lossy(&raw);
                let parsed: i64 = text.trim().parse().map_err(|_| {
                    ApiError::Validation("chat_id must be an integer chat id".to_string())
                })?;
                if parsed == 0 {
                    return Err(ApiError::Validation(
                        "chat_id must be a real chat id (0 is invalid, negatives are valid)"
                            .to_string(),
                    ));
                }
                upload_chat_id = Some(parsed);
            }
            Some("file") if staged.is_none() => {
                let raw_name = field.file_name().unwrap_or("upload.bin").to_string();
                let file_name = files::sanitize_file_name(&raw_name)?;
                staged = Some(stage_upload(&file_name, &mut field).await?);
            }
            _ => {
                // Unknown or repeated fields are drained and ignored so the
                // rest of the body stays in sync.
                let _ = field.bytes().await;
            }
        }
    }

    let staged = staged
        .ok_or_else(|| ApiError::Validation("missing \"file\" field in the upload".to_string()))?;
    let folder = files::normalize_folder(folder.as_deref().unwrap_or(""), &staged.file_name);

    let default = default_chat_id(&client).await?;
    let effective = storage_chat_for(&user, default);
    // Active-drive uploads pass their drive's chat id; everything else keeps
    // the personal/default storage chat.
    let chat_id = match upload_chat_id {
        Some(target) => {
            if !drive_chat_allowed(&user, effective, target) {
                return Err(ApiError::Forbidden(
                    "chat is not a storage drive of this account".to_string(),
                ));
            }
            target
        }
        None => effective,
    };
    let extension = std::path::Path::new(&staged.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let media_type = MediaType::from_extension(&format!(".{extension}"));

    let pool = state.transfer_pool().await?;
    let lease = pool
        .lease()
        .await
        .map_err(|e| ApiError::Telegram(e.to_string()))?;
    let bot_index = lease.index() as i32;
    let engine = TransferEngine::with_default_config(lease.client());
    let mut sent = engine
        .upload_file(
            chat_id,
            &staged.path,
            None,
            media_type,
            &CancellationToken::new(),
            None,
        )
        .await
        .map_err(|e| ApiError::Telegram(format!("upload failed: {e}")))?;
    drop(lease);

    // Telegram types the message by what it actually received - a `Photo`
    // for an image it accepted, a `Document` for everything else - while the
    // explorer must route by the file the user chose. Restore the
    // extension-based classification so folder + gallery routing does not
    // depend on which transport Telegram happened to use.
    sent.media_type = media_type;

    // A photo upload is re-encoded by Telegram, so the bytes it now holds are
    // not the staged ones; record the size it reports or the listing would
    // promise bytes the download does not deliver.
    let reported_size = if sent.file_size > 0 {
        sent.file_size
    } else {
        staged.size
    };

    let doc = files::FileDoc::new(
        &user.id,
        &folder,
        &staged.file_name,
        reported_size,
        &sent,
        bot_index,
    );
    match files::insert_file(&client, &doc).await {
        Ok(()) => {}
        Err(DbError::Connection(e)) if e.to_string().contains("E11000") => {
            return Err(ApiError::Conflict(
                "a file with that name already exists in this folder".to_string(),
            ));
        }
        Err(e) => return Err(e.into()),
    }

    tracing::info!(
        "stored {} in chat {} (bot {})",
        doc.file_name,
        doc.chat_id,
        bot_index
    );
    Ok((StatusCode::CREATED, Json(files::FileSummary::new(&doc))))
}

/// GET /dl/{file_name} — the file as a download (`Content-Disposition:
/// attachment`).
async fn download_file(
    State(state): State<Arc<AppState>>,
    method: Method,
    Path(file_name): Path<String>,
    headers: HeaderMap,
    Query(query): Query<files::MediaQuery>,
) -> ApiResult<Response> {
    serve_media(
        &state,
        &file_name,
        false,
        method,
        &headers,
        query.token.as_deref(),
    )
    .await
}

/// GET /watch/{file_name} — the same bytes served inline so a `<video>`
/// element can stream and seek.
async fn watch_file(
    State(state): State<Arc<AppState>>,
    method: Method,
    Path(file_name): Path<String>,
    headers: HeaderMap,
    Query(query): Query<files::MediaQuery>,
) -> ApiResult<Response> {
    serve_media(
        &state,
        &file_name,
        true,
        method,
        &headers,
        query.token.as_deref(),
    )
    .await
}

/// Shared body of `/dl` and `/watch`: authorise, resolve the record, then
/// answer the range request.
async fn serve_media(
    state: &Arc<AppState>,
    file_name: &str,
    inline: bool,
    method: Method,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> ApiResult<Response> {
    let owner = files::require_media_session(headers, query_token, &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &owner)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    if !user.permissions.read {
        return Err(ApiError::Forbidden(
            "this account cannot download files".to_string(),
        ));
    }
    let doc = files::find_file(&client, &user.id, file_name)
        .await?
        .ok_or_else(|| ApiError::NotFound("file not found".to_string()))?;
    serve_media_doc(state, doc, inline, method, headers).await
}

/// GET /api/fs/media?message_id=N — the explorer's stream/preview/download
/// URL: keyed by the Telegram message (`tg://msg/{id}`), which the display
/// name used by `/dl` and `/watch` cannot disambiguate when two folders hold
/// files with the same name. `inline=false` switches to a download.
async fn media_by_message(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    Query(query): Query<MediaByMessageQuery>,
) -> ApiResult<Response> {
    let owner = files::require_media_session(&headers, query.token.as_deref(), &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &owner)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    if !user.permissions.read {
        return Err(ApiError::Forbidden(
            "this account cannot download files".to_string(),
        ));
    }
    let doc = files::find_file_by_message(&client, &user.id, query.message_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("file not found".to_string()))?;
    serve_media_doc(&state, doc, query.inline.unwrap_or(true), method, &headers).await
}

/// GET /api/fs/thumbnail -? one message's preview image, served out of the
/// server-side thumbnail cache and fetched from Telegram on a miss.
///
/// Two tiers exist so a listing paints instantly: `low` is the cheap preview
/// the grid shows the moment a row appears, `high` is the largest Telegram
/// will serve. The webui asks for `low` first and swaps in `high` once the
/// larger bytes have arrived, which is why both are cached independently.
async fn thumbnail_by_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ThumbnailQuery>,
) -> ApiResult<Response> {
    let owner = files::require_media_session(&headers, query.token.as_deref(), &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &owner)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    if !user.permissions.read {
        return Err(ApiError::Forbidden(
            "this account cannot view files".to_string(),
        ));
    }

    let quality = match query.quality.as_deref().unwrap_or("low").parse() {
        Ok(quality) => quality,
        Err(()) => {
            return Err(ApiError::InvalidInput(
                "quality must be \"low\" or \"high\"".to_string(),
            ));
        }
    };

    let doc = files::find_file_by_message(&client, &user.id, query.message_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("file not found".to_string()))?;

    // Pin the bot that stored the file, exactly as the media route does: the
    // others may not be able to see that chat at all.
    let pool = state.transfer_pool().await?;
    let slot = usize::try_from(doc.bot_index).map_err(|_| {
        ApiError::Telegram(format!(
            "file was stored by an unknown bot (slot {})",
            doc.bot_index
        ))
    })?;
    let lease = pool
        .lease_slot(slot)
        .await
        .map_err(|e| ApiError::Telegram(e.to_string()))?;

    let telegram = lease.client();
    let Some(bytes) = state
        .thumbnails()
        .get_or_fetch(telegram.as_ref(), doc.chat_id, doc.message_id, quality)
        .await
    else {
        return Err(ApiError::NotFound(
            "no thumbnail is available for this file".to_string(),
        ));
    };

    Ok(Response::builder()
        .header(CONTENT_TYPE, "image/jpeg")
        // Telegram never re-encodes a thumbnail, so the bytes behind a given
        // message id and tier are fixed for good.
        .header(CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))
        .map_err(|e| ApiError::Internal(format!("response build failed: {e}")))?)
}

#[derive(Debug, Deserialize)]
struct ThumbnailQuery {
    message_id: i32,
    /// Defaults to `low`: the grid asks for the cheap tier first.
    quality: Option<String>,
    /// Session token for the `<img src>` element, which cannot set headers.
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MediaByMessageQuery {
    message_id: i32,
    token: Option<String>,
    /// `1`/`0` are as valid in a query string as `true`/`false`, and the
    /// webui has always sent the short form — so accept both rather than
    /// 400 a URL that reaches the handler fine otherwise.
    #[serde(default, deserialize_with = "flexible_bool")]
    inline: Option<bool>,
}

/// Query strings have no bool literal, so `serde`'s `bool` only ever sees a
/// string. Accept `1`/`0` alongside `true`/`false` instead of rejecting with
/// axum's "provided string was not `true` or `false`".
fn flexible_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" => Ok(Some(true)),
        "0" | "false" => Ok(Some(false)),
        "" => Ok(None),
        other => Err(serde::de::Error::custom(format!(
            "expected `true`, `false`, `1` or `0`, got `{other}`"
        ))),
    }
}

// ===== Live drive browsing (extra chat drives) =====

/// Serialised drive item, shaped exactly like the legacy
/// `TelegramChatDriveItem` the webui's `driveItemToFileItem` already consumes.
#[derive(Debug, Serialize)]
struct DriveItem {
    chat_id: i64,
    message_id: i32,
    media_kind: String,
    content_type: String,
    file_name: String,
    file_size: u64,
    file_extension: Option<String>,
    mime_type: Option<String>,
    caption: Option<String>,
    modified_at: String,
    thumbnail: Option<String>,
}

#[derive(Debug, Serialize)]
struct DriveItemsPage {
    items: Vec<DriveItem>,
    has_more: bool,
    next_offset: i32,
}

#[derive(Debug, Deserialize)]
struct DriveItemsQuery {
    chat_id: i64,
    /// Exclusive upper bound on message ids; 0/absent = start at the newest.
    #[serde(default)]
    offset: i32,
    #[serde(default = "drive_page_size")]
    limit: u32,
}

fn drive_page_size() -> u32 {
    60
}

fn media_kind_str(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Photo => "photo",
        MediaType::Video => "video",
        MediaType::Audio => "audio",
        MediaType::Voice => "voice",
        MediaType::Document => "document",
        MediaType::Animation => "animation",
        MediaType::Sticker => "sticker",
    }
}

/// Session + read permission + "this chat is a drive of this user".
/// Returns the signed-in user on success.
async fn require_drive_access(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    query_token: Option<&str>,
    chat_id: i64,
) -> Result<UserDoc, ApiError> {
    let owner = files::require_media_session(headers, query_token, &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &owner)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    if !user.permissions.read {
        return Err(ApiError::Forbidden(
            "this account cannot view files".to_string(),
        ));
    }
    if chat_id == 0 {
        return Err(ApiError::Validation(
            "chat_id must be a real chat id (0 is invalid, negatives are valid)".to_string(),
        ));
    }
    let effective = storage_chat_for(&user, default_chat_id(&client).await.unwrap_or(0));
    if !drive_chat_allowed(&user, effective, chat_id) {
        return Err(ApiError::Forbidden(
            "chat is not a storage drive of this account".to_string(),
        ));
    }
    Ok(user)
}

/// GET /api/fs/drive/items — page a drive chat's media newest-first.
///
/// Live read via `list_history` (no Mongo rows required): `offset == 0`
/// probes the newest message id, otherwise `offset` is the same exclusive
/// upper bound the history indexer walks with.
async fn fs_drive_items(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DriveItemsQuery>,
) -> ApiResult<Json<DriveItemsPage>> {
    require_drive_access(&state, &headers, None, query.chat_id).await?;

    if query.limit == 0 || query.limit > 200 {
        return Err(ApiError::InvalidInput(
            "limit must be between 1 and 200".to_string(),
        ));
    }

    let pool = state.transfer_pool().await?;
    let lease = pool
        .lease()
        .await
        .map_err(|e| ApiError::Telegram(e.to_string()))?;
    let client = lease.client();

    let mut upper = query.offset;
    if upper <= 0 {
        let latest = client.latest_message_id(query.chat_id).await.map_err(|e| {
            ApiError::Telegram(format!("could not read chat {}: {e}", query.chat_id))
        })?;
        if latest <= 0 {
            return Ok(Json(DriveItemsPage {
                items: Vec::new(),
                has_more: false,
                next_offset: 0,
            }));
        }
        upper = latest.saturating_add(1);
    }

    let page = client
        .list_history(query.chat_id, upper, query.limit)
        .await
        .map_err(|e| ApiError::Telegram(format!("history listing failed: {e}")))?;
    drop(lease);

    let mut items = Vec::with_capacity(page.len());
    for (sent, caption) in &page {
        let extension = std::path::Path::new(&sent.file_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_string);
        items.push(DriveItem {
            chat_id: sent.chat_id,
            message_id: sent.message_id,
            media_kind: media_kind_str(sent.media_type).to_string(),
            content_type: sent.mime_type.clone(),
            file_name: sent.file_name.clone(),
            file_size: sent.file_size,
            file_extension: extension,
            mime_type: Some(sent.mime_type.clone()),
            caption: caption.clone(),
            modified_at: sent
                .date
                .map(|d| d.to_rfc3339())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            thumbnail: Some(format!(
                "/api/fs/drive/thumbnail?chat_id={}&message_id={}&quality=low",
                sent.chat_id, sent.message_id
            )),
        });
    }

    // The requested window was [upper - limit, upper); when it reached id 1
    // (or below), there is nothing older left to page.
    let next_offset = (upper - query.limit as i32).max(1);
    let has_more = next_offset > 1 && !page.is_empty();
    Ok(Json(DriveItemsPage {
        items,
        has_more,
        next_offset,
    }))
}

#[derive(Debug, Deserialize)]
struct DriveMediaQuery {
    chat_id: i64,
    message_id: i32,
    /// Filename for Content-Disposition; falls back to `file` on Telegram.
    name: Option<String>,
    token: Option<String>,
    #[serde(default, deserialize_with = "flexible_bool")]
    inline: Option<bool>,
}

/// GET /api/fs/drive/media — stream one live drive message's file.
///
/// Same Range-capable streaming as `/api/fs/media`, but keyed on
/// chat+message instead of a Mongo FileDoc, so never-indexed chats work.
async fn fs_drive_media(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    method: Method,
    Query(query): Query<DriveMediaQuery>,
) -> ApiResult<Response> {
    require_drive_access(&state, &headers, query.token.as_deref(), query.chat_id).await?;

    let pool = state.transfer_pool().await?;
    let lease = pool
        .lease()
        .await
        .map_err(|e| ApiError::Telegram(e.to_string()))?;
    let engine = TransferEngine::with_default_config(lease.client());

    let media = engine
        .get_media(query.chat_id, query.message_id)
        .await
        .map_err(|e| ApiError::Telegram(format!("could not read the file: {e}")))?
        .ok_or_else(|| ApiError::NotFound("file no longer exists on Telegram".to_string()))?;

    let file_name = query
        .name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(files::sanitize_file_name)
        .transpose()?
        .unwrap_or_else(|| media.file_name.clone());
    let mime_type = if media.mime_type.is_empty() {
        "application/octet-stream".to_string()
    } else {
        media.mime_type.clone()
    };
    let file_size = if media.file_size > 0 {
        media.file_size
    } else {
        0
    };

    let range =
        files::parse_byte_range(headers.get(RANGE).and_then(|v| v.to_str().ok()), file_size);
    let inline = query.inline.unwrap_or(true);
    let disposition = files::content_disposition(&file_name, inline);
    if let files::ByteRange::Unsatisfiable = range {
        let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        if let Ok(value) = HeaderValue::from_str(&format!("bytes */{file_size}")) {
            response.headers_mut().insert(CONTENT_RANGE, value);
        }
        return Ok(response);
    }

    let status = if range.is_partial() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut builder = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, mime_type)
        .header(CONTENT_LENGTH, range.len(file_size))
        .header(CONTENT_DISPOSITION, disposition)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "public, max-age=3600, immutable");
    if let files::ByteRange::Part { start, end } = range {
        builder = builder.header(CONTENT_RANGE, format!("bytes {start}-{end}/{file_size}"));
    }

    if method == Method::HEAD || file_size == 0 {
        return builder
            .body(Body::empty())
            .map_err(|e| ApiError::Internal(format!("response build failed: {e}")));
    }

    let (start, length) = match range {
        files::ByteRange::Part { start, end } => (start, end - start + 1),
        _ => (0, file_size),
    };
    let (chat_id, message_id, label) = (query.chat_id, query.message_id, file_name.clone());

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    let cancel = CancellationToken::new();
    tokio::spawn(async move {
        let _lease = lease;
        let mut sink = files::StreamSink::new(tx, cancel.clone());
        let outcome = engine
            .download_range(
                chat_id,
                message_id,
                DownloadRange::new(start, length),
                &mut sink,
                &cancel,
                None,
            )
            .await;
        match outcome {
            Ok(()) => tracing::debug!("finished streaming {}", label),
            Err(TelegramError::Cancelled) => tracing::info!("stream of {} cancelled", label),
            Err(e) => {
                cancel.cancel();
                tracing::warn!("stream of {} failed: {}", label, e);
            }
        }
    });

    let stream = futures::stream::unfold(rx, |mut rx| async move {
        let next = rx.recv().await;
        next.map(|value| (value, rx))
    });
    builder
        .body(Body::from_stream(stream))
        .map_err(|e| ApiError::Internal(format!("response build failed: {e}")))
}

#[derive(Debug, Deserialize)]
struct DriveThumbnailQuery {
    chat_id: i64,
    message_id: i32,
    quality: Option<String>,
    token: Option<String>,
}

/// GET /api/fs/drive/thumbnail — preview image for one live drive message.
async fn fs_drive_thumbnail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DriveThumbnailQuery>,
) -> ApiResult<Response> {
    require_drive_access(&state, &headers, query.token.as_deref(), query.chat_id).await?;

    let quality = match query.quality.as_deref().unwrap_or("low").parse() {
        Ok(quality) => quality,
        Err(()) => {
            return Err(ApiError::InvalidInput(
                "quality must be \"low\" or \"high\"".to_string(),
            ));
        }
    };

    let pool = state.transfer_pool().await?;
    let lease = pool
        .lease()
        .await
        .map_err(|e| ApiError::Telegram(e.to_string()))?;
    let telegram = lease.client();
    let Some(bytes) = state
        .thumbnails()
        .get_or_fetch(telegram.as_ref(), query.chat_id, query.message_id, quality)
        .await
    else {
        return Err(ApiError::NotFound(
            "no thumbnail is available for this message".to_string(),
        ));
    };

    Response::builder()
        .header(CONTENT_TYPE, "image/jpeg")
        .header(CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))
        .map_err(|e| ApiError::Internal(format!("response build failed: {e}")))
}

// ===== Profile photo + history indexing =====

/// In-process cache for the owner's Telegram profile photo: the bytes and
/// the instant they were fetched. Avoids re-downloading on every page load.
struct CachedPhoto {
    bytes: Vec<u8>,
    fetched_at: Instant,
}

#[derive(Debug, Deserialize)]
struct ProfilePhotoQuery {
    token: Option<String>,
}

/// GET /api/auth/profile-photo — the signed-in account's Telegram profile
/// photo as `image/jpeg`. Accepts either a Bearer header or a `?token=`
/// query parameter (the latter for `<img src>` loads). 404 when the account
/// has no photo or the lookup fails (the frontend degrades to initials).
async fn auth_profile_photo(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ProfilePhotoQuery>,
) -> ApiResult<Response> {
    let username = files::require_media_session(&headers, query.token.as_deref(), &state.sessions)?;
    let client = state.mongo_client().await?;
    let user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    let Some(tg_id) = user.telegram_user_id else {
        return Err(ApiError::NotFound("no Telegram account linked".to_string()));
    };

    // Serve from cache when fresh (10 minutes).
    {
        let cache = state.photo_cache.lock().unwrap();
        if let Some(entry) = cache.get(&tg_id)
            && entry.fetched_at.elapsed() < Duration::from_secs(600)
        {
            return Ok(photo_response(&entry.bytes));
        }
    }

    let pool = state.transfer_pool().await?;
    let lease = pool
        .lease()
        .await
        .map_err(|e| ApiError::Telegram(e.to_string()))?;
    let photo = lease
        .client()
        .get_profile_photo(tg_id)
        .await
        .map_err(|e| ApiError::Telegram(format!("could not fetch profile photo: {e}")))?;
    drop(lease);

    match photo {
        Some(bytes) => {
            let mut cache = state.photo_cache.lock().unwrap();
            cache.insert(
                tg_id,
                CachedPhoto {
                    bytes: bytes.clone(),
                    fetched_at: Instant::now(),
                },
            );
            Ok(photo_response(&bytes))
        }
        None => Err(ApiError::NotFound("no profile photo".to_string())),
    }
}

fn photo_response(bytes: &[u8]) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "image/jpeg")
        .header(CACHE_CONTROL, "private, max-age=600")
        .body(Body::from(bytes.to_vec()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Response body for `POST /api/fs/index`. Mirrors the shape the webUI
/// already expects from the old `tg_index_saved_messages` command.
#[derive(Debug, Serialize)]
struct IndexStartResponse {
    total_new_messages: u64,
    started_from_empty_db: bool,
    saved_messages_chat_id: i64,
    historical_sync_complete: bool,
    indexed_count: u64,
    /// Newest message id probed in the storage chat (0 when the chat looks
    /// empty or is unreadable). Lets the UI show real progress instead of a
    /// blank "0 / false" that reads like a silent failure.
    latest_message_id: i32,
    /// Set when the chat could not be indexed (e.g. the bot lacks read access).
    notice: Option<String>,
    /// `true` when this call attached to an already-running index instead of
    /// starting one. That is a normal outcome (a page refresh during a backfill),
    /// not a failure, so the UI must not render it as an error.
    already_running: bool,
}

/// Release the indexer's `running` claim. Called on every synchronous error
/// path in `fs_index` after the flag is taken, so a failed probe doesn't wedge
/// the indexer as "already in progress" until the server restarts.
async fn release_index_running(state: &AppState) {
    let mut guard = state.indexer.lock().await;
    guard.running = false;
}

/// POST /api/fs/index — start (or join) a background history-index task.
///
/// Pages the account's storage chat from newest to oldest, upserting a
/// `FileDoc` for every media message. Progress is published over SSE as
/// `account_sync_changed` snapshots; individual items as `tg-update-received`.
async fn fs_index(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<IndexStartResponse>> {
    let mongo = state.mongo_client().await?;
    // The session is optional, and which chat we index depends on it:
    //
    // * **Before login** (no / expired token) we index the *default* chat as
    //   the owner account — a pre-login backfill that needs no session.
    // * **After login** we index the signed-in user's storage chat, which is
    //   the chat they *configured* (if any) falling back to the default. A
    //   configured chat can only be resolved from their session, so it is
    //   indexed only once they are signed in.
    let (user, chat_id) = match session_user(&headers, &state.sessions, &mongo).await? {
        Some(user) => {
            let chat_id = storage_chat_for(&user, default_chat_id(&mongo).await?);
            (user, chat_id)
        }
        None => {
            let owner = find_owner(&mongo).await?.ok_or_else(|| {
                ApiError::Forbidden("no owner account yet — finish the setup wizard".to_string())
            })?;
            (owner, default_chat_id(&mongo).await?)
        }
    };

    // Detect an empty DB so the frontend can show "first-run backfill".
    let files_coll = mongo
        .database(&data_database_name())
        .collection::<files::FileDoc>(files::FileDoc::COLLECTION_NAME);
    let existing = files_coll
        .count_documents(doc! { "owner_id": &user.id })
        .await
        .map_err(|e| ApiError::Database(DbError::Connection(e)))?;
    let started_from_empty = existing == 0;

    // If a run is already active, return its current snapshot instead of
    // starting a second one.
    {
        let mut state_guard = state.indexer.lock().await;
        if state_guard.running {
            let indexed = state_guard.indexed;
            drop(state_guard);
            // A refresh while a backfill is in flight re-POSTs this endpoint.
            // That is an expected join, so publish a snapshot for the freshly
            // opened toolbar instead of staying silent — without it the bar
            // only moves once the background task emits its next page.
            state.publish_event(
                "account_sync_changed",
                serde_json::json!({ "state": "Syncing", "indexed_count": indexed }),
            );
            return Ok(Json(IndexStartResponse {
                total_new_messages: 0,
                started_from_empty_db: started_from_empty,
                saved_messages_chat_id: chat_id,
                historical_sync_complete: false,
                indexed_count: indexed,
                latest_message_id: 0,
                notice: None,
                already_running: true,
            }));
        }
        state_guard.running = true;
        state_guard.scanned = 0;
        state_guard.indexed = 0;
        state_guard.last_error = None;
    }

    // Probe the newest message id up front so failures surface here (a clear
    // synchronous error) instead of dying silently in the background task.
    // A value of 0 means the chat looks empty *or* the bot cannot read it.
    // Every error path below releases the `running` flag before returning, or
    // the indexer would report "already in progress" until the server restarts.
    let latest_id = {
        let probed = async {
            let pool = state
                .transfer_pool()
                .await
                .map_err(|e| ApiError::Telegram(e.to_string()))?;
            let lease = pool
                .lease()
                .await
                .map_err(|e| ApiError::Telegram(e.to_string()))?;
            let probed = lease
                .client()
                .latest_message_id(chat_id)
                .await
                .map_err(|e| ApiError::Telegram(format!("could not read storage chat: {e}")))?;
            drop(lease);
            Ok::<i32, ApiError>(probed)
        }
        .await;
        match probed {
            Ok(id) => id,
            Err(e) => {
                release_index_running(&state).await;
                return Err(e);
            }
        }
    };

    if latest_id == 0 {
        // Nothing readable. Release the running flag and tell the caller why
        // rather than spawning a task that would index nothing.
        {
            let mut state_guard = state.indexer.lock().await;
            state_guard.running = false;
        }
        let notice = format!(
            "no readable messages in chat {chat_id}. Ensure the bot is an \
             ADMIN of that chat with the \"Read Messages\" permission, then \
             re-run indexing."
        );
        tracing::warn!(chat_id, "history index aborted: {notice}");
        return Ok(Json(IndexStartResponse {
            total_new_messages: 0,
            started_from_empty_db: started_from_empty,
            saved_messages_chat_id: chat_id,
            historical_sync_complete: false,
            indexed_count: 0,
            latest_message_id: 0,
            notice: Some(notice),
            already_running: false,
        }));
    }

    // Publish the initial "Syncing" snapshot so the toolbar reacts immediately.
    state.publish_event(
        "account_sync_changed",
        serde_json::json!({ "state": "Syncing", "indexed_count": 0u64 }),
    );

    // Spawn the background indexing task.
    let state_clone = Arc::clone(&state);
    let mongo_clone = mongo.clone();
    let user_id = user.id.clone();
    let owner_username = user.username.clone();
    tokio::spawn(async move {
        let result =
            run_history_index(&state_clone, &mongo_clone, &user_id, chat_id, latest_id).await;
        let mut guard = state_clone.indexer.lock().await;
        guard.running = false;
        match result {
            Ok(indexed) => {
                tracing::info!(
                    "history index complete for {owner_username}: {indexed} new file(s)"
                );
                state_clone.publish_event(
                    "account_sync_changed",
                    serde_json::json!({ "state": "UpToDate", "indexed_count": indexed }),
                );
            }
            Err(e) => {
                tracing::error!(error = %e, "history index failed for {owner_username}");
                guard.last_error = Some(e.to_string());
                state_clone.publish_event(
                    "account_sync_changed",
                    serde_json::json!({ "state": { "Error": { "message": e.to_string() } } }),
                );
            }
        }
    });

    Ok(Json(IndexStartResponse {
        total_new_messages: 0,
        started_from_empty_db: started_from_empty,
        saved_messages_chat_id: chat_id,
        historical_sync_complete: false,
        indexed_count: 0,
        latest_message_id: latest_id,
        notice: None,
        already_running: false,
    }))
}

/// Folder that a given media type belongs to inside the virtual VFS.
fn folder_for_media(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Photo => "/Home/Images",
        MediaType::Video => "/Home/Videos",
        MediaType::Audio | MediaType::Voice => "/Home/Audio",
        _ => "/Home/Documents",
    }
}

/// One `account_sync_changed` snapshot for a walk still in flight: `covered`
/// is how many message ids are done (ids above the current page plus this
/// page's share of the ids its items cover). Walking the id span keeps the
/// bar moving even when a page yields no media, and capping at 99 keeps 100%
/// reserved for the closing `UpToDate` snapshot — the bar must never claim
/// completion while indexing is still running.
fn publish_index_progress(state: &Arc<AppState>, latest_id: i64, covered: u64, indexed: u64) {
    let total_span = latest_id.max(1) as u64;
    let progress_percent = ((covered.min(total_span) * 100) / total_span).min(99);
    state.publish_event(
        "account_sync_changed",
        serde_json::json!({
            "state": "Syncing",
            "indexed_count": indexed,
            "progress_percent": progress_percent,
        }),
    );
}

/// Core indexing loop: page history newest→oldest, upsert FileDocs, publish
/// progress. Returns the number of newly-inserted documents. `latest_id` is
/// the pre-probed newest message id (must be > 0; callers abort earlier when
/// the chat is unreadable/empty).
async fn run_history_index(
    state: &Arc<AppState>,
    mongo: &Client,
    owner_id: &str,
    chat_id: i64,
    latest_id: i32,
) -> Result<u64, ApiError> {
    let pool = state.transfer_pool().await?;
    let files_coll = mongo
        .database(&data_database_name())
        .collection::<files::FileDoc>(files::FileDoc::COLLECTION_NAME);

    // The FileDocs written below land in /Home/Images & co., but only a
    // FolderDoc row makes those paths show up under /Home. Seed them before
    // the first page so indexed items are browsable as soon as they arrive.
    vfs::ensure_media_folders(mongo, owner_id).await?;

    // Bots cannot call messages.getHistory (BOT_METHOD_INVALID), so we
    // walk downward from the pre-probed newest id in fixed batches with
    // list_history (getMessagesByIDs-based).
    const PAGE: i32 = 100;
    let mut offset_id: i32 = latest_id.saturating_add(1); // exclusive upper bound
    let latest_id = latest_id as i64;
    let mut total_new: u64 = 0;
    let mut scanned: u64 = 0;

    loop {
        if offset_id <= 1 {
            break;
        }
        let lease = pool
            .lease()
            .await
            .map_err(|e| ApiError::Telegram(e.to_string()))?;
        let client = lease.client();
        let page = client
            .list_history(chat_id, offset_id, PAGE as u32)
            .await
            .map_err(|e| ApiError::Telegram(format!("history listing failed: {e}")))?;
        drop(lease);

        // Ids this page covers: `offset_id` is an exclusive upper bound, so
        // the page is [offset_id - PAGE, offset_id) clipped to real ids. The
        // final page is short and must not be counted as a full page, or the
        // bar would hit 100% a page early.
        let page_ids = PAGE.min(offset_id).max(0) as u64;
        let covered_before = latest_id.saturating_sub(i64::from(offset_id)).max(0) as u64;
        let page_total = page.len() as u64;
        let mut last_progress_publish: Option<std::time::Instant> = None;

        // Process the page (may be empty when no media exists in this id
        // range — we still walk downward so no gaps are left).
        let mut page_new: u64 = 0;
        for (i, (sent, caption)) in page.iter().enumerate() {
            scanned += 1;
            let folder = folder_for_media(sent.media_type);
            let mut doc =
                files::FileDoc::new(owner_id, folder, &sent.file_name, sent.file_size, sent, 0);
            doc.caption = caption.clone();
            // A file row's `_id` embeds the name, and the name this code
            // produces for a message can change between builds (photos used
            // to collapse onto "photo.jpg", nameless videos onto "unknown").
            // Drop any row still keyed to this message under an older name,
            // or re-indexing strands a stale duplicate beside the new one.
            let _ = files_coll
                .delete_many(doc! {
                    "owner_id": owner_id,
                    "file_path": folder,
                    "chat_id": sent.chat_id,
                    "message_id": sent.message_id,
                    "_id": { "$ne": &doc.id },
                })
                .await;
            // Overwrite any previous record for this (owner, folder, name)
            // so re-indexing refreshes message ids instead of failing on
            // a duplicate key.
            let _ = files_coll
                .replace_one(doc! { "_id": &doc.id }, &doc)
                .upsert(true)
                .await;
            page_new += 1;

            // Live explorer refresh: one event per indexed message.
            let folder_kind = match sent.media_type {
                MediaType::Photo => "Images",
                MediaType::Video => "Videos",
                MediaType::Audio | MediaType::Voice => "Audio",
                _ => "Documents",
            };
            state.publish_event(
                "tg-update-received",
                serde_json::json!({
                    "message_id": sent.message_id,
                    "folder_kind": folder_kind,
                }),
            );

            // Real-time percent while the page is being written: ids walked
            // before this page plus this page's share as each item lands.
            // Without it a chat that fits in one page emits a single 0%
            // snapshot and then jumps straight to 100% at the end. Throttled
            // so a large backfill cannot flood the SSE broadcast.
            if page_total > 0 {
                let now = std::time::Instant::now();
                let last_item = i + 1 == page.len();
                let due = match last_progress_publish {
                    None => true,
                    Some(at) => now.duration_since(at).as_millis() >= 100,
                };
                if last_item || due {
                    last_progress_publish = Some(now);
                    let covered =
                        covered_before + page_ids.saturating_mul(i as u64 + 1) / page_total;
                    publish_index_progress(state, latest_id, covered, total_new + page_new);
                }
            }
        }

        total_new += page_new;

        // Progress snapshot after every page (also the only one when the page
        // carried no media, so an empty stretch of chat still advances).
        {
            let mut guard = state.indexer.lock().await;
            guard.scanned = scanned;
            guard.indexed = total_new;
        }
        publish_index_progress(
            state,
            latest_id,
            covered_before + page_ids,
            total_new,
        );

        // Walk downward by one page: the next batch is [offset-PAGE, offset).
        offset_id -= PAGE;

        // Yield briefly so SSE flushes and the HTTP server stays responsive.
        tokio::task::yield_now().await;
    }

    Ok(total_new)
}

/// The range/stream body, shared by the name-keyed and message-keyed media
/// routes once the record (and the caller's read permission) are settled.
async fn serve_media_doc(
    state: &Arc<AppState>,
    doc: files::FileDoc,
    inline: bool,
    method: Method,
    headers: &HeaderMap,
) -> ApiResult<Response> {
    // Pin the bot that stored the file: the others may not be able to see
    // that chat at all.
    let pool = state.transfer_pool().await?;
    let slot = usize::try_from(doc.bot_index).map_err(|_| {
        ApiError::Telegram(format!(
            "file was stored by an unknown bot (slot {})",
            doc.bot_index
        ))
    })?;
    let lease = pool
        .lease_slot(slot)
        .await
        .map_err(|e| ApiError::Telegram(e.to_string()))?;
    let engine = TransferEngine::with_default_config(lease.client());

    // One metadata read before committing to a status code: it is the only
    // way to learn the size Telegram actually holds, and it proves the
    // message still exists.
    let media = engine
        .get_media(doc.chat_id, doc.message_id)
        .await
        .map_err(|e| ApiError::Telegram(format!("could not read the file: {e}")))?
        .ok_or_else(|| ApiError::NotFound("file no longer exists on Telegram".to_string()))?;

    let file_size = if media.file_size > 0 {
        media.file_size
    } else {
        doc.file_size.max(0) as u64
    };
    let range =
        files::parse_byte_range(headers.get(RANGE).and_then(|v| v.to_str().ok()), file_size);

    let disposition = files::content_disposition(&doc.file_name, inline);
    if let files::ByteRange::Unsatisfiable = range {
        let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        if let Ok(value) = HeaderValue::from_str(&format!("bytes */{file_size}")) {
            response.headers_mut().insert(CONTENT_RANGE, value);
        }
        return Ok(response);
    }

    let status = if range.is_partial() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mut builder = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, doc.mime_type.clone())
        .header(CONTENT_LENGTH, range.len(file_size))
        .header(CONTENT_DISPOSITION, disposition)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "public, max-age=3600, immutable");
    if let files::ByteRange::Part { start, end } = range {
        builder = builder.header(CONTENT_RANGE, format!("bytes {start}-{end}/{file_size}"));
    }

    // HEAD needs the headers and nothing else — no reason to pull the file
    // out of Telegram for it.
    if method == Method::HEAD || file_size == 0 {
        return builder
            .body(Body::empty())
            .map_err(|e| ApiError::Internal(format!("response build failed: {e}")));
    }

    let (start, length) = match range {
        files::ByteRange::Part { start, end } => (start, end - start + 1),
        _ => (0, file_size),
    };
    let (chat_id, message_id, label) = (doc.chat_id, doc.message_id, doc.file_name.clone());

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    let cancel = CancellationToken::new();
    tokio::spawn(async move {
        // Held for the life of the stream: the pool counts this transfer
        // until the last byte is out, not just until the headers.
        let _lease = lease;
        let mut sink = files::StreamSink::new(tx, cancel.clone());
        let outcome = engine
            .download_range(
                chat_id,
                message_id,
                DownloadRange::new(start, length),
                &mut sink,
                &cancel,
                None,
            )
            .await;
        match outcome {
            Ok(()) => tracing::debug!("finished streaming {}", label),
            // A dropped receiver is the normal end of an aborted seek.
            Err(TelegramError::Cancelled) => tracing::info!("stream of {} cancelled", label),
            Err(e) => {
                cancel.cancel();
                tracing::warn!("stream of {} failed: {}", label, e);
            }
        }
    });

    // `mpsc::Receiver` is not itself a `futures::Stream`; unwrap it one
    // message at a time so `Body::from_stream` has something to pull from.
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        let next = rx.recv().await;
        next.map(|value| (value, rx))
    });

    builder
        .body(Body::from_stream(stream))
        .map_err(|e| ApiError::Internal(format!("response build failed: {e}")))
}

pub fn router(mongo_uri: String) -> Router {
    let state = Arc::new(AppState::new(mongo_uri));
    Router::new()
        .route("/api/setup/check", post(check_setup))
        .route("/api/setup/save", post(save_setup))
        .route("/api/setup/resume", get(resume_setup))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/register", post(auth_register))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/claim/start", post(claim_start))
        .route("/api/auth/claim/status/:secret", get(claim_status))
        .route("/api/auth/claim/confirm", post(claim_confirm))
        .route("/api/auth/claim/available", get(claim_available))
        .route("/api/auth/me", get(auth_me))
        .route("/api/auth/profile-photo", get(auth_profile_photo))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/auth/username-available", get(auth_username_available))
        .route("/api/auth/change-username", post(auth_change_username))
        .route("/api/auth/change-password", post(auth_change_password))
        .route(
            "/api/admin/users",
            get(admin_list_users).post(admin_create_user),
        )
        .route(
            "/api/admin/users/:username",
            patch(admin_update_user).delete(admin_delete_user),
        )
        .route("/api/admin/users/:username/resync", post(admin_resync_user))
        .route("/api/files/upload", post(files_upload))
        // WebUI support: settings, favorites, recents, session probes, logs.
        .route(
            "/api/settings/:key",
            get(ui::settings_get).put(ui::settings_put),
        )
        .route(
            "/api/favorites",
            get(ui::favorites_list).post(ui::favorites_add),
        )
        .route("/api/favorites/:id", delete(ui::favorites_remove))
        .route("/api/recents", get(ui::recents_list).post(ui::recents_add))
        .route("/api/session/readiness", get(ui::session_readiness))
        .route("/api/session/auth", get(ui::session_auth))
        .route("/api/logs", post(ui::logs_ingest))
        .route("/api/events", get(ui::events_sse))
        // Mongo VFS: folder/file listing and mutations for the explorer.
        .route("/api/fs/items", get(vfs::list_items))
        .route(
            "/api/fs/items/by-message/:message_id",
            get(vfs::item_by_message),
        )
        .route("/api/fs/folders", post(vfs::create_folder))
        .route("/api/fs/move", post(vfs::move_item))
        .route("/api/fs/copy", post(vfs::copy_item))
        .route("/api/fs/rename", post(vfs::rename_item))
        .route("/api/fs/recycle", post(vfs::recycle_item))
        .route("/api/fs/restore", post(vfs::restore_item))
        .route("/api/fs/delete", post(vfs::delete_items))
        .route("/api/fs/gallery", get(vfs::gallery))
        .route("/api/fs/stats", get(fs_storage_stats))
        .route(
            "/api/storage/chat",
            get(storage_chat_get).put(storage_chat_put),
        )
        .route(
            "/api/storage/drives",
            get(storage_drives_get).post(storage_drives_post),
        )
        .route("/api/storage/drives/:chat_id", delete(storage_drives_delete))
        // Live drive browsing: pages, media and previews keyed on chat+message
        // so never-indexed chats work without Mongo rows.
        .route("/api/fs/drive/items", get(fs_drive_items))
        .route(
            "/api/fs/drive/media",
            get(fs_drive_media).head(fs_drive_media),
        )
        .route("/api/fs/drive/thumbnail", get(fs_drive_thumbnail))
        .route("/api/fs/media", get(media_by_message))
    .route("/api/fs/thumbnail", get(thumbnail_by_message))
        .route("/api/fs/index", post(fs_index))
        // Unknown /api/* paths answer JSON 404 instead of the SPA fallback
        // (which serves index.html 200 and breaks response.json()).
        .route("/api/*rest", any(ui::api_not_found))
        // Catch-all so a file name may contain slashes (a pasted path) and a
        // dot (every real file name).
        .route("/dl/*file_name", get(download_file))
        .route("/watch/*file_name", get(watch_file))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use std::env;
    use tempfile::tempdir;

    #[test]
    fn test_validate_step1_valid() {
        let input = Step1Input {
            mongo_uri: "mongodb://localhost:27017".to_string(),
            password: "password123".to_string(),
        };
        assert!(validate_step1(&input).is_ok());
    }

    #[test]
    fn test_validate_step1_empty_mongo_uri() {
        let input = Step1Input {
            mongo_uri: "".to_string(),
            password: "password123".to_string(),
        };
        let err = validate_step1(&input).unwrap_err();
        assert!(err.contains("MongoDB URI is required"));
    }

    #[test]
    fn test_validate_step1_short_password() {
        let input = Step1Input {
            mongo_uri: "mongodb://localhost:27017".to_string(),
            password: "short".to_string(),
        };
        let err = validate_step1(&input).unwrap_err();
        assert!(err.contains("Password must be at least 8 characters"));
    }

    #[test]
    fn test_validate_step2_valid() {
        let input = Step2Input {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            bot_token_2: Some("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew12".to_string()),
            bot_token_3: None,
            owner_id: 987654321,
            default_chat_id: -1001234567890,
        };
        assert!(validate_step2(&input).is_ok());
    }

    #[test]
    fn test_validate_step2_zero_api_id() {
        let input = Step2Input {
            api_id: 0,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            default_chat_id: -1001234567890,
            bot_token_2: None,
            bot_token_3: None,
            owner_id: 987654321,
        };
        let err = validate_step2(&input).unwrap_err();
        assert!(err.contains("API ID must be a positive integer"));
    }

    #[test]
    fn test_validate_step2_empty_api_hash() {
        let input = Step2Input {
            api_id: 123456,
            api_hash: "".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            default_chat_id: -1001234567890,
            bot_token_2: None,
            bot_token_3: None,
            owner_id: 987654321,
        };
        let err = validate_step2(&input).unwrap_err();
        assert!(err.contains("API hash is required"));
    }

    #[test]
    fn test_validate_step2_empty_bot_token() {
        let input = Step2Input {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "".to_string(),
            default_chat_id: -1001234567890,
            bot_token_2: None,
            bot_token_3: None,
            owner_id: 987654321,
        };
        let err = validate_step2(&input).unwrap_err();
        assert!(err.contains("Bot token 1 is required"));
    }

    #[test]
    fn test_validate_step2_zero_owner_id() {
        let input = Step2Input {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            default_chat_id: -1001234567890,
            bot_token_2: None,
            bot_token_3: None,
            owner_id: 0,
        };
        let err = validate_step2(&input).unwrap_err();
        assert!(err.contains("Owner ID must be a positive integer"));
    }

    #[test]
    fn test_validate_step2_zero_default_chat_id() {
        let input = Step2Input {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            default_chat_id: 0,
            bot_token_2: None,
            bot_token_3: None,
            owner_id: 987654321,
        };
        let err = validate_step2(&input).unwrap_err();
        assert!(err.contains("Default chat ID is required"));
    }

    // Both resume tests mutate TFS_DATA_DIR; serialize them to avoid env races.
    // The guard spans an await on purpose: each #[tokio::test] runs on its own
    // OS thread with a current_thread runtime, so holding a std Mutex here
    // cannot starve the runtime (the whole test *is* the critical section).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_resume_no_connection_file() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        unsafe {
            env::set_var("TFS_DATA_DIR", temp_dir.path());
            env::set_var("TFS_BIN_DIR", temp_dir.path().join("bin"));
        };

        let result = resume_setup(State(Arc::new(AppState::new(
            "mongodb://localhost:27017".to_string(),
        ))))
        .await;

        assert!(result.is_ok());
        let response = result.unwrap();
        match response.0 {
            ResumeResponse::NotSaved(inner) => assert!(!inner.saved),
            _ => panic!("expected NotSaved variant"),
        }

        unsafe {
            env::remove_var("TFS_DATA_DIR");
            env::remove_var("TFS_BIN_DIR");
        };
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_resume_connection_file_no_mongo() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        unsafe {
            env::set_var("TFS_DATA_DIR", temp_dir.path());
            env::set_var("TFS_BIN_DIR", temp_dir.path().join("bin"));
        };

        // Create a connection file
        let store = tfs_config::appdata::ConnectionStore {
            mongo_uri: "mongodb://invalid-host:27017".to_string(),
            password: "password123".to_string(),
        };
        tfs_config::appdata::save_connection(&store).unwrap();

        let result = resume_setup(State(Arc::new(AppState::new(
            "mongodb://localhost:27017".to_string(),
        ))))
        .await;

        assert!(result.is_ok());
        let response = result.unwrap();
        match response.0 {
            ResumeResponse::StaleConnectionFailed(inner) => {
                assert!(inner.saved);
                assert!(!inner.configured);
                assert!(inner.stale);
                assert_eq!(inner.reason, "connection-failed");
                assert_eq!(inner.connection.mongo_uri, "mongodb://invalid-host:27017");
                assert_eq!(inner.connection.password, "password123");
            }
            _ => panic!("expected StaleConnectionFailed variant"),
        }

        unsafe {
            env::remove_var("TFS_DATA_DIR");
            env::remove_var("TFS_BIN_DIR");
        };
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_resume_local_config_first_skips_mongo() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        unsafe {
            env::set_var("TFS_DATA_DIR", temp_dir.path());
            env::set_var("TFS_BIN_DIR", temp_dir.path().join("bin"));
        };

        let step1 = Step1Input {
            mongo_uri: "mongodb://localhost:27017".to_string(),
            password: "password123".to_string(),
        };
        let step2 = Step2Input {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            bot_token_2: None,
            bot_token_3: None,
            owner_id: 987654321,
            default_chat_id: -1001234567890,
        };
        let config = tfs_config::create_setup_config(&step1, &step2).unwrap();
        // Unreachable MongoDB URI: if resume did NOT answer from the local
        // mirror it would fall back here and return Stale*, never Configured.
        tfs_config::appdata::save_connection(&ConnectionStore {
            mongo_uri: "mongodb://invalid-host:27017".to_string(),
            password: "password123".to_string(),
        })
        .unwrap();
        let sensitive = tfs_config::SensitiveData {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_tokens: vec!["123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string()],
        };
        tfs_config::appdata::save_local_config(&config, &sensitive, "password123").unwrap();

        // No MongoDB reachable at an unused local port — success here proves
        // the resume answered from the local mirror alone.
        let result = resume_setup(State(Arc::new(AppState::new(
            "mongodb://localhost:27017".to_string(),
        ))))
        .await;

        assert!(result.is_ok());
        let response = result.unwrap();
        match response.0 {
            ResumeResponse::Configured(inner) => {
                assert!(inner.saved);
                assert!(inner.configured);
                assert_eq!(inner.api_id, 123456);
                assert_eq!(inner.owner_id, 987654321);
                assert_eq!(inner.bot_count, 1);
            }
            _ => panic!("expected Configured variant from local mirror"),
        }

        unsafe {
            env::remove_var("TFS_DATA_DIR");
            env::remove_var("TFS_BIN_DIR");
        };
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn test_resume_local_config_wrong_password_falls_back() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        unsafe {
            env::set_var("TFS_DATA_DIR", temp_dir.path());
            env::set_var("TFS_BIN_DIR", temp_dir.path().join("bin"));
        };

        let step1 = Step1Input {
            mongo_uri: "mongodb://localhost:27017".to_string(),
            password: "password123".to_string(),
        };
        let step2 = Step2Input {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            bot_token_2: None,
            bot_token_3: None,
            owner_id: 987654321,
            default_chat_id: -1001234567890,
        };
        let config = tfs_config::create_setup_config(&step1, &step2).unwrap();
        // Stored password does NOT match the config's password_hash.
        tfs_config::appdata::save_connection(&ConnectionStore {
            mongo_uri: "mongodb://localhost:27017".to_string(),
            password: "wrong-password".to_string(),
        })
        .unwrap();
        let sensitive = tfs_config::SensitiveData {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_tokens: vec!["123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string()],
        };
        tfs_config::appdata::save_local_config(&config, &sensitive, "password123").unwrap();

        let result = resume_setup(State(Arc::new(AppState::new(
            "mongodb://localhost:27017".to_string(),
        ))))
        .await;

        assert!(result.is_ok());
        let response = result.unwrap();
        // A local mirror whose password no longer verifies must never be
        // reported as configured — resume falls through to the MongoDB path
        // (which yields NotConfigured/Stale* here, never Configured).
        assert!(
            !matches!(response.0, ResumeResponse::Configured(_)),
            "wrong-password local mirror must not report configured"
        );

        unsafe {
            env::remove_var("TFS_DATA_DIR");
            env::remove_var("TFS_BIN_DIR");
        };
    }

    // ===== Auth tests (offline: validation + session store) =====

    #[test]
    fn test_validate_username_valid() {
        assert!(validate_username("user").is_ok());
        assert!(validate_username("user123").is_ok());
        assert!(validate_username("user_name").is_ok());
        assert!(validate_username("user.name").is_ok());
        assert!(validate_username("user-name").is_ok());
        assert!(validate_username("User123").is_ok());
        assert!(validate_username(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn test_validate_username_too_short() {
        let err = validate_username("ab").unwrap_err();
        assert!(err.contains("3-32 characters"));
    }

    #[test]
    fn test_validate_username_too_long() {
        let err = validate_username(&"a".repeat(33)).unwrap_err();
        assert!(err.contains("3-32 characters"));
    }

    #[test]
    fn test_validate_username_invalid_chars() {
        assert!(validate_username("user@name").is_err());
        assert!(validate_username("user name").is_err());
        assert!(validate_username("user/name").is_err());
        assert!(validate_username("user#name").is_err());
    }

    #[test]
    fn test_validate_password_valid() {
        assert!(validate_password("password123").is_ok());
        assert!(validate_password(&"a".repeat(8)).is_ok());
        assert!(validate_password(&"a".repeat(100)).is_ok());
    }

    #[test]
    fn test_validate_password_too_short() {
        let err = validate_password("short").unwrap_err();
        assert!(err.contains("at least 8 characters"));
    }

    #[test]
    fn test_session_store_token_generation() {
        let store = new_session_store();
        let token1 = create_session(&store, "user1".to_string());
        let token2 = create_session(&store, "user2".to_string());
        // Tokens should be 64 hex chars (32 bytes)
        assert_eq!(token1.len(), 64);
        assert_eq!(token2.len(), 64);
        assert_ne!(token1, token2);
        // Should be valid hex
        assert!(hex::decode(&token1).is_ok());
        assert!(hex::decode(&token2).is_ok());
    }

    #[test]
    fn test_session_store_validate_and_refresh() {
        let store = new_session_store();
        let token = create_session(&store, "user1".to_string());

        // Valid token returns username
        let username = validate_session(&store, &token);
        assert_eq!(username, Some("user1".to_string()));

        // Unknown token returns None
        assert_eq!(validate_session(&store, "unknown"), None);

        // Wrong token returns None
        assert_eq!(validate_session(&store, &"0".repeat(64)), None);
    }

    #[test]
    fn test_session_store_remove_idempotent() {
        let store = new_session_store();
        let token = create_session(&store, "user1".to_string());

        // First remove works
        remove_session(&store, &token);
        assert_eq!(validate_session(&store, &token), None);

        // Second remove also works (idempotent)
        remove_session(&store, &token);
        assert_eq!(validate_session(&store, &token), None);
    }

    #[test]
    fn test_extract_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer abc123"));
        assert_eq!(extract_bearer_token(&headers), Some("abc123".to_string()));

        // Case sensitive: "bearer" (lowercase) is not recognized
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("bearer xyz789"));
        assert_eq!(extract_bearer_token(&headers), None);

        // Missing header
        let headers = HeaderMap::new();
        assert_eq!(extract_bearer_token(&headers), None);

        // No Bearer prefix
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Basic abc123"));
        assert_eq!(extract_bearer_token(&headers), None);

        // Empty token
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer "));
        assert_eq!(extract_bearer_token(&headers), None);
    }

    // ===== Transfer routes (no database, no Telegram) =====

    fn sample_user(storage_chat_id: Option<i64>) -> UserDoc {
        UserDoc {
            id: "alice".to_string(),
            username: "alice".to_string(),
            password_hash: None,
            role: "user".to_string(),
            telegram_user_id: None,
            telegram_username: None,
            telegram_first_name: None,
            telegram_last_name: None,
            permissions: default_permissions(),
            storage_chat_id,
            storage_drives: Vec::new(),
            created_at: chrono::Utc::now(),
            created_by: Some("admin".to_string()),
        }
    }

    #[test]
    fn storage_chat_uses_the_account_chat_and_otherwise_the_default() {
        assert_eq!(storage_chat_for(&sample_user(None), -100123), -100123);
        assert_eq!(storage_chat_for(&sample_user(Some(-42)), -100123), -42);
    }

    #[test]
    fn storage_chat_patch_distinguishes_clear_from_absent() {
        let absent: AdminUpdateUserRequest = serde_json::from_str("{}").unwrap();
        assert!(absent.storage_chat_id.is_none());

        let cleared: AdminUpdateUserRequest =
            serde_json::from_str(r#"{"storage_chat_id": null}"#).unwrap();
        assert_eq!(cleared.storage_chat_id, Some(None));

        let set: AdminUpdateUserRequest =
            serde_json::from_str(r#"{"storage_chat_id": -100500}"#).unwrap();
        assert_eq!(set.storage_chat_id, Some(Some(-100500)));
    }

    #[test]
    fn drive_access_covers_the_effective_chat_and_registered_drives_only() {
        let mut user = sample_user(None);
        user.storage_drives = vec![
            DriveEntry {
                chat_id: -1001,
                label: "Media".to_string(),
            },
            DriveEntry {
                chat_id: -1002,
                label: String::new(),
            },
        ];

        // The effective storage chat needs no drive registration.
        assert!(drive_chat_allowed(&user, -777, -777));
        // Registered drives are allowed.
        assert!(drive_chat_allowed(&user, -777, -1001));
        assert!(drive_chat_allowed(&user, -777, -1002));
        // Anything else — including 0 — is not.
        assert!(!drive_chat_allowed(&user, -777, -999));
        assert!(!drive_chat_allowed(&user, -777, 0));
    }

    #[test]
    fn drive_entry_deserializes_without_a_label() {
        let entry: DriveEntry = serde_json::from_str(r#"{"chat_id": -100442}"#).unwrap();
        assert_eq!(entry.chat_id, -100442);
        assert_eq!(entry.label, "");

        // A UserDoc written before drives existed still deserializes.
        let legacy = r#"{
            "_id": "bob", "username": "bob", "role": "user",
            "permissions": {"read": true, "write": true},
            "created_at": "2026-01-01T00:00:00Z"
        }"#;
        let user: UserDoc = serde_json::from_str(legacy).unwrap();
        assert!(user.storage_drives.is_empty());
    }

    /// The URI the wizard stored in config.tfs — encrypted under the password
    /// that appdata data.tfs holds — is what a running server connects with.
    /// No environment variable, no localhost fallback.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn saved_config_tfs_supplies_the_mongo_uri() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        unsafe {
            env::set_var("TFS_DATA_DIR", temp_dir.path());
            env::set_var("TFS_BIN_DIR", temp_dir.path().join("bin"));
        };

        save_connection(&ConnectionStore {
            mongo_uri: "mongodb+srv://cluster.example.net/tfs".to_string(),
            password: "password123".to_string(),
        })
        .unwrap();

        // Empty state URI is exactly what the server boots with now.
        let state = AppState::new(String::new());
        assert_eq!(
            state.resolve_mongo_uri().unwrap(),
            "mongodb+srv://cluster.example.net/tfs"
        );

        unsafe {
            env::remove_var("TFS_DATA_DIR");
            env::remove_var("TFS_BIN_DIR");
        };
    }

    /// The webUI decides "join vs failure" purely from the JSON body, so the
    /// `already_running` flag has to survive serialization and must never be
    /// paired with a notice. A regression here re-introduces the
    /// "index already in progress" error toast on every page refresh.
    #[test]
    fn index_start_response_serializes_join_as_not_a_failure() {
        let joined = IndexStartResponse {
            total_new_messages: 0,
            started_from_empty_db: false,
            saved_messages_chat_id: -100,
            historical_sync_complete: false,
            indexed_count: 42,
            latest_message_id: 0,
            notice: None,
            already_running: true,
        };
        let value = serde_json::to_value(&joined).unwrap();
        assert_eq!(value["already_running"], true);
        assert!(value["notice"].is_null());
        assert_eq!(value["indexed_count"], 42);

        // A genuine failure keeps its notice and never claims to be a join.
        let failed = IndexStartResponse {
            total_new_messages: 0,
            started_from_empty_db: false,
            saved_messages_chat_id: -100,
            historical_sync_complete: false,
            indexed_count: 0,
            latest_message_id: 0,
            notice: Some("no readable messages".to_string()),
            already_running: false,
        };
        let value = serde_json::to_value(&failed).unwrap();
        assert_eq!(value["already_running"], false);
        assert_eq!(value["notice"], "no readable messages");
    }

    /// With no saved config there is nothing to dial, and saying so beats
    /// guessing localhost. (A non-empty state URI still wins — that path
    /// exists only for tests and CI.)
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn no_saved_config_is_not_configured() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        unsafe {
            env::set_var("TFS_DATA_DIR", temp_dir.path());
            env::set_var("TFS_BIN_DIR", temp_dir.path().join("bin"));
        };

        let state = AppState::new(String::new());
        assert!(matches!(
            state.resolve_mongo_uri(),
            Err(DbError::NotConfigured)
        ));

        let explicit = AppState::new("mongodb://example.invalid:27017".to_string());
        assert_eq!(
            explicit.resolve_mongo_uri().unwrap(),
            "mongodb://example.invalid:27017"
        );

        unsafe {
            env::remove_var("TFS_DATA_DIR");
            env::remove_var("TFS_BIN_DIR");
        };
    }

    /// Claim status reads only the in-memory store: pending → verified, and
    /// a secret that was never issued (or has expired) reads as unknown.
    #[tokio::test]
    async fn claim_status_reflects_pending_verified_and_unknown() {
        let state = test_state("mongodb://127.0.0.1:1");
        state.claims.lock().unwrap().insert(
            "secret123".to_string(),
            ClaimEntry::new("admin".to_string(), None),
        );

        let resp = claim_status(State(Arc::clone(&state)), Path("secret123".to_string()))
            .await
            .unwrap();
        assert_eq!(resp.0.status, "pending");
        assert_eq!(resp.0.username.as_deref(), Some("admin"));

        state
            .claims
            .lock()
            .unwrap()
            .get_mut("secret123")
            .unwrap()
            .verified = true;
        let resp = claim_status(State(Arc::clone(&state)), Path("secret123".to_string()))
            .await
            .unwrap();
        assert_eq!(resp.0.status, "verified");

        let resp = claim_status(State(state), Path("never-issued".to_string()))
            .await
            .unwrap();
        assert_eq!(resp.0.status, "unknown");
        assert!(resp.0.username.is_none());
    }

    /// Expired secrets are purged on read and report as unknown.
    #[tokio::test]
    async fn claim_status_expires_old_secrets() {
        let state = test_state("mongodb://127.0.0.1:1");
        let created = Instant::now()
            .checked_sub(CLAIM_TTL + Duration::from_secs(1))
            .expect("machine uptime exceeds the claim TTL");
        let mut stale = ClaimEntry::new("admin".to_string(), None);
        stale.created = created;
        stale.verified = true;
        state
            .claims
            .lock()
            .unwrap()
            .insert("stale".to_string(), stale);

        let resp = claim_status(State(Arc::clone(&state)), Path("stale".to_string()))
            .await
            .unwrap();
        assert_eq!(resp.0.status, "unknown");
        assert!(!state.claims.lock().unwrap().contains_key("stale"));
    }

    /// Only the owner's username (or `admin`) may start a claim in the
    /// bootstrap phase; anything else is rejected once Mongo confirms no
    /// admin exists yet.
    ///
    /// Run with: cargo test -p tfs-api -- --ignored --test-threads=1
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn claim_start_rejects_non_owner_usernames() {
        let uri = test_mongo_uri();
        let client = connect(&uri).await.unwrap();
        get_users_collection(&client)
            .delete_many(doc! {})
            .await
            .unwrap();

        let state = test_state(&uri);
        let err = claim_start(
            State(state),
            Json(ClaimStartRequest {
                username: "mallory".to_string(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::Forbidden(_)));
    }

    #[tokio::test]
    async fn claim_start_rejects_invalid_usernames() {
        let state = test_state("mongodb://127.0.0.1:1");
        let err = claim_start(
            State(state),
            Json(ClaimStartRequest {
                username: "no".to_string(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::Validation(_)));
    }

    /// The availability gate answers malformed names without touching Mongo,
    /// so the create screen can grey out the button instantly.
    #[tokio::test]
    async fn claim_available_rejects_invalid_usernames_without_mongo() {
        let state = test_state("mongodb://127.0.0.1:1");
        let resp = claim_available(
            State(state),
            Query(ClaimAvailableQuery {
                username: "no".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(!resp.0.available);
        assert!(resp.0.reason.is_some());
    }

    /// Claim secrets are 32 hex chars — inside the `/start` payload limit.
    #[test]
    fn claim_secrets_fit_the_deep_link_payload_limit() {
        for _ in 0..16 {
            let secret = generate_claim_secret();
            assert_eq!(secret.len(), 32);
            assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
            // https://t.me/<bot>?start=<secret> — payload must stay <= 64.
            assert!(secret.len() <= 64);
        }
    }

    /// The catch-all routes answer an unauthenticated caller with 401 +
    /// `WWW-Authenticate` before a single Mongo or Telegram call happens.
    #[tokio::test]
    async fn media_routes_reject_unauthenticated_requests() {
        use tower::ServiceExt;

        let app = router("mongodb://127.0.0.1:1".to_string());

        for uri in [
            "/dl/movie.mp4",
            "/watch/movie.mp4",
            "/dl/Home%2FImages%2Fmovie.mp4",
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(uri)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
            assert!(
                response.headers().contains_key(WWW_AUTHENTICATE),
                "{uri} should tell the client how to authenticate"
            );
        }
    }

    /// `?inline=1` must reach the handler. serde's `bool` only parses
    /// `true`/`false`, so the short form the webui sends used to 400 in the
    /// extractor before auth ran — the client saw "provided string was not
    /// `true` or `false`" instead of a preview.
    #[tokio::test]
    async fn media_by_message_accepts_query_string_bool_spelling() {
        use tower::ServiceExt;

        let app = router("mongodb://127.0.0.1:1".to_string());

        // Auth runs before any Mongo call, so 401 means the query string
        // deserialized. A rejected query would answer 400 instead.
        for uri in [
            "/api/fs/media?message_id=17&inline=1&token=abc",
            "/api/fs/media?message_id=17&inline=0&token=abc",
            "/api/fs/media?message_id=17&inline=true&token=abc",
            "/api/fs/media?message_id=17&inline=false&token=abc",
            "/api/fs/media?message_id=17&token=abc",
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(uri)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
        }

        // Anything else is still a client error, not a silent default.
        let bogus = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/fs/media?message_id=17&inline=maybe&token=abc")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bogus.status(), StatusCode::BAD_REQUEST);
    }

    /// Routing only: unknown paths fall through to the 404 handler and
    /// `/api/files/upload` accepts POST alone — neither touches a database.
    #[tokio::test]
    async fn media_routes_are_reachable_and_unknown_paths_404() {
        use tower::ServiceExt;

        let app = router("mongodb://127.0.0.1:1".to_string());

        // Unknown paths never reach a handler.
        let missing = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/no/such/route")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        // /api/files/upload exists but only for POST.
        let wrong_method = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/files/upload")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    /// `require_session` challenges with 401 + `WWW-Authenticate` (not 400)
    /// for both a missing and an unknown token — clients rely on the status
    /// to decide between "log in again" and "you asked for something wrong".
    #[test]
    fn require_session_challenges_with_401() {
        let store = new_session_store();

        let missing = require_session(&HeaderMap::new(), &store).unwrap_err();
        assert!(matches!(missing, ApiError::Unauthorized(_)));
        let response = missing.into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response.headers().contains_key(WWW_AUTHENTICATE));

        let unknown = require_session(&bearer("deadbeef"), &store).unwrap_err();
        assert!(matches!(unknown, ApiError::Unauthorized(_)));
    }

    /// Unknown /api/* paths answer JSON 404 so the SPA's fetchJson keeps its
    /// "unexpected token '<'"-free error path; non-API paths stay on the
    /// server's SPA fallback (covered by the test above).
    #[tokio::test]
    async fn unknown_api_paths_answer_json_404() {
        use tower::ServiceExt;

        let app = router("mongodb://127.0.0.1:1".to_string());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/no/such/endpoint")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            value.get("error").and_then(|e| e.as_str()),
            Some("not found")
        );
    }

    /// /api/auth/me without a token is 401 with the Bearer challenge —
    /// the SPA treats 400/401/403 alike, but the status is now semantically
    /// correct for clients that distinguish them.
    #[tokio::test]
    async fn auth_me_without_token_challenges_with_401() {
        use tower::ServiceExt;

        let app = router("mongodb://127.0.0.1:1".to_string());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/auth/me")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response.headers().contains_key(WWW_AUTHENTICATE));
    }

    /// The session probes are public and always "ready" in the browser
    /// build — no Mongo, no Telegram, no session required.
    #[tokio::test]
    async fn session_probes_are_public_and_ready() {
        use tower::ServiceExt;

        let app = router("mongodb://127.0.0.1:1".to_string());
        for uri in ["/api/session/readiness", "/api/session/auth"] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(uri)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "uri: {uri}");
            let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if uri.ends_with("auth") {
                assert_eq!(
                    value.get("state").and_then(|s| s.as_str()),
                    Some("authorizationStateReady")
                );
            } else {
                assert_eq!(
                    value.pointer("/credentials/state").and_then(|s| s.as_str()),
                    Some("CredentialsReady")
                );
            }
        }
    }

    /// POST /api/logs accepts a well-formed line with 204 and rejects an
    /// unknown level with 400 (no Mongo needed — the handler only traces).
    #[tokio::test]
    async fn logs_ingest_validates_level_without_touching_mongo() {
        use tower::ServiceExt;

        let app = router("mongodb://127.0.0.1:1".to_string());

        let ok = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/logs")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "level": "info", "message": "hello" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::NO_CONTENT);

        let bad = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/logs")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "level": "verbose", "message": "nope" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    }

    // ===== Auth integration tests (require MongoDB) =====
    // Run with: cargo test -p tfs-api -- --ignored
    // These are marked #[ignore] per repo precedent (like test_connect_and_save_load in db tests)

    /// Mongo URI for integration tests: the configured encrypted config
    /// (appdata data.tfs + binary-dir config.tfs) — same source the
    /// server uses. `MONGODB_URI` env overrides when set.
    ///
    /// CAUTION: these tests reset the `tfs_v2.v2_users` collection.
    fn test_mongo_uri() -> String {
        if let Ok(uri) = std::env::var("MONGODB_URI")
            && !uri.is_empty()
        {
            return uri;
        }
        if std::env::var("TFS_BIN_DIR").is_err() {
            // Test exe lives in target/debug/deps — point config at the
            // binary dir where config.tfs actually sits.
            let bin = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("target")
                .join("debug");
            // SAFETY: tests only read this; value is identical whichever
            // thread sets it first (all three tests want the same dir).
            unsafe { std::env::set_var("TFS_BIN_DIR", bin) };
        }
        match load_connection() {
            Ok(Some(conn)) => conn.mongo_uri,
            Ok(None) => panic!(
                "no configured MongoDB connection — run the setup wizard \
                 (appdata data.tfs + target/debug/config.tfs) or set MONGODB_URI"
            ),
            Err(e) => panic!("failed to load configured connection: {e}"),
        }
    }

    /// Test state: fixed owner identity — no Telegram, no saved config.
    fn test_state(uri: &str) -> Arc<AppState> {
        Arc::new(
            AppState::new(uri.to_string()).with_owner_resolver(OwnerResolver::Fixed {
                username: "testuser".to_string(),
                user_id: Some(999999),
            }),
        )
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
        );
        headers
    }

    /// Media serving against a real database: credentials are checked
    /// first, then the account and its read permission, then the file
    /// lookup — all before any bot or Telegram call, so no bot token and
    /// no `v2_files` row are needed to run this.
    ///
    /// Run with: cargo test -p tfs-api -- --ignored --test-threads=1
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn media_serving_authenticates_before_it_touches_telegram() {
        let uri = test_mongo_uri();
        let client = connect(&uri).await.unwrap();
        get_users_collection(&client)
            .delete_many(doc! {})
            .await
            .unwrap();

        let state = test_state(&uri);
        let registered = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "testuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(registered.0.ok);

        // No credentials at all.
        let anonymous = serve_media(
            &state,
            "missing.mp4",
            false,
            Method::GET,
            &HeaderMap::new(),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(anonymous, ApiError::Unauthorized(_)),
            "expected Unauthorized, got {anonymous:?}"
        );

        // A token that is not a session.
        let bogus = serve_media(
            &state,
            "missing.mp4",
            false,
            Method::GET,
            &HeaderMap::new(),
            Some("not-a-real-session-token"),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(bogus, ApiError::Unauthorized(_)),
            "expected Unauthorized, got {bogus:?}"
        );

        // Authenticated owner, nobody stored that name — 404.
        let token = create_session(&state.sessions, "testuser".to_string());
        let missing = serve_media(
            &state,
            "missing.mp4",
            false,
            Method::GET,
            &HeaderMap::new(),
            Some(&token),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(missing, ApiError::NotFound(_)),
            "expected NotFound, got {missing:?}"
        );

        // An account without read permission stops before the file lookup.
        let mut restricted = sample_user(None);
        restricted.id = "readonly".to_string();
        restricted.username = "readonly".to_string();
        restricted.permissions.read = false;
        get_users_collection(&client)
            .insert_one(restricted)
            .await
            .unwrap();
        let ro_token = create_session(&state.sessions, "readonly".to_string());
        let denied = serve_media(
            &state,
            "missing.mp4",
            false,
            Method::GET,
            &HeaderMap::new(),
            Some(&ro_token),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(denied, ApiError::Forbidden(_)),
            "expected Forbidden, got {denied:?}"
        );
    }

    // Multi-thread flavor: blocking Argon2 hashing in handlers would starve the
    // mongodb driver's SDAM monitors and IO polling on a current-thread runtime,
    // producing spurious ConnectionPoolCleared / ServerSelection / Io(TimedOut)
    // failures against Atlas.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn test_auth_register_login_me_logout_flow() {
        let uri = test_mongo_uri();
        let client = connect(&uri).await.unwrap();

        // Clean up any existing users
        let collection = get_users_collection(&client);
        collection.delete_many(doc! {}).await.unwrap();

        let state = test_state(&uri);

        // 1. Status: owner bootstrap on an empty collection
        let status = auth_status(State(state.clone())).await.unwrap();
        assert!(status.0.needs_registration);
        assert_eq!(status.0.registration, "owner");

        // 2. Non-owner username → 403 before anything is written
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "intruder".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        match reg.unwrap_err() {
            ApiError::Forbidden(msg) => assert!(msg.contains("must match the Telegram owner")),
            e => panic!("expected Forbidden owner mismatch, got {e:?}"),
        }

        // 3. Register with the owner's username → admin account
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "TestUser".to_string(), // case-insensitive match
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(reg.0.ok);
        assert_eq!(reg.0.username, "testuser");

        // Owner doc: role, telegram identity from owner_id, no created_by
        let owner = find_user(&client, "testuser").await.unwrap().unwrap();
        assert_eq!(owner.role, "admin");
        assert!(owner.is_owner());
        assert_eq!(owner.telegram_user_id, Some(999999));
        assert_eq!(owner.telegram_username.as_deref(), Some("testuser"));
        assert!(owner.claimed());

        // 4. Status: admin exists → invite mode
        let status = auth_status(State(state.clone())).await.unwrap();
        assert!(!status.0.needs_registration);
        assert_eq!(status.0.registration, "invite");

        // 5. Unknown username → 403 registration closed
        let reg2 = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "another".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        match reg2.unwrap_err() {
            ApiError::Forbidden(msg) => assert!(msg.contains("registration closed")),
            e => panic!("expected Forbidden registration closed, got {e:?}"),
        }

        // 6. Login with correct password
        let login = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "testuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(!login.0.token.is_empty());
        assert_eq!(login.0.username, "testuser");
        let token = login.0.token;

        // 7. Login with wrong password → same error as wrong user
        let login_wrong = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "testuser".to_string(),
                password: "wrongpassword".to_string(),
            }),
        )
        .await;
        match login_wrong.unwrap_err() {
            ApiError::InvalidInput(msg) => assert_eq!(msg, "invalid username or password"),
            e => panic!("expected InvalidInput, got {e:?}"),
        }
        let login_no_user = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "nonexistent".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        assert!(login_no_user.is_err());

        // 8. /me → profile with role and permissions
        let me = auth_me(State(state.clone()), bearer(&token)).await.unwrap();
        assert_eq!(me.0.username, "testuser");
        assert_eq!(me.0.role, "admin");
        assert!(me.0.permissions.read && me.0.permissions.write);
        assert_eq!(me.0.telegram_username.as_deref(), Some("testuser"));
        assert_eq!(me.0.telegram_user_id, Some(999999));

        // 9. /me with invalid / missing token → error
        let mut bad = HeaderMap::new();
        bad.insert("authorization", HeaderValue::from_static("Bearer invalid"));
        assert!(auth_me(State(state.clone()), bad).await.is_err());
        assert!(
            auth_me(State(state.clone()), HeaderMap::new())
                .await
                .is_err()
        );

        // 10. Logout → 204, idempotent; /me afterwards → error
        let logout = auth_logout(State(state.clone()), bearer(&token))
            .await
            .unwrap();
        assert_eq!(logout.into_response().status(), StatusCode::NO_CONTENT);
        let logout2 = auth_logout(State(state.clone()), bearer(&token))
            .await
            .unwrap();
        assert_eq!(logout2.into_response().status(), StatusCode::NO_CONTENT);
        assert!(auth_me(State(state.clone()), bearer(&token)).await.is_err());
    }

    /// The confirm half of the claim flow: once the claim store says a secret
    /// is verified (the bot does that in production; here the test seeds it),
    /// confirm creates the owner account and hands back a working session.
    /// Unverified secrets are refused, and secrets are single-use.
    ///
    /// Run with: cargo test -p tfs-api -- --ignored --test-threads=1
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn claim_confirm_creates_the_owner_account_after_verification() {
        let uri = test_mongo_uri();
        let client = connect(&uri).await.unwrap();

        let collection = get_users_collection(&client);
        collection.delete_many(doc! {}).await.unwrap();

        let state = test_state(&uri);
        // Simulate the claim bot: a verified secret for the owner username,
        // plus an unverified one that must be refused.
        {
            let mut claims = state.claims.lock().unwrap();
            let mut verified = ClaimEntry::new("testuser".to_string(), None);
            verified.verified = true;
            claims.insert("verifiedsecret".to_string(), verified);
            claims.insert(
                "unverifiedsecret".to_string(),
                ClaimEntry::new("testuser".to_string(), None),
            );
        }

        // Unverified → refused, secret kept for the poller.
        let err = claim_confirm(
            State(state.clone()),
            Json(ClaimConfirmRequest {
                secret: "unverifiedsecret".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap_err();
        match err {
            ApiError::Forbidden(msg) => assert!(msg.contains("not verified")),
            e => panic!("expected Forbidden unverified, got {e:?}"),
        }
        assert!(
            state
                .claims
                .lock()
                .unwrap()
                .contains_key("unverifiedsecret")
        );

        // Verified → owner account created; token works without a login call.
        let resp = claim_confirm(
            State(state.clone()),
            Json(ClaimConfirmRequest {
                secret: "verifiedsecret".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.0.username, "testuser");
        assert!(!resp.0.token.is_empty());
        assert!(validate_session(&state.sessions, &resp.0.token).is_some());

        // Secret is single-use.
        assert!(!state.claims.lock().unwrap().contains_key("verifiedsecret"));

        // Account exists: admin role, password set, linked to the owner id.
        let owner = find_user(&client, "testuser").await.unwrap().unwrap();
        assert_eq!(owner.role, "admin");
        assert!(owner.is_owner());
        assert!(owner.claimed());
        assert_eq!(owner.telegram_user_id, Some(999999));

        // Signing in with the password the claim set also works.
        let login = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "testuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(login.0.username, "testuser");

        collection.delete_many(doc! {}).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn test_auth_validation_errors() {
        let uri = test_mongo_uri();
        let client = connect(&uri).await.unwrap();

        // Clean up
        let collection = get_users_collection(&client);
        collection.delete_many(doc! {}).await.unwrap();

        let state = test_state(&uri);

        // Username too short (validated before any Telegram/Mongo write)
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "ab".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        match reg.unwrap_err() {
            ApiError::Validation(msg) => assert!(msg.contains("3-32 characters")),
            e => panic!("expected Validation error, got {e:?}"),
        }

        // Username invalid chars
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "user@name".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        match reg.unwrap_err() {
            ApiError::Validation(msg) => assert!(msg.contains("letters, numbers")),
            e => panic!("expected Validation error, got {e:?}"),
        }

        // Password too short
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "validuser".to_string(),
                password: "short".to_string(),
            }),
        )
        .await;
        match reg.unwrap_err() {
            ApiError::Validation(msg) => assert!(msg.contains("at least 8 characters")),
            e => panic!("expected Validation error, got {e:?}"),
        }

        // Register owner, then again → conflict (already registered)
        let _ = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "testuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        let dup = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "testuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        match dup.unwrap_err() {
            ApiError::Conflict(msg) => assert!(msg.contains("already registered")),
            e => panic!("expected Conflict, got {e:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn test_admin_user_management_flow() {
        let uri = test_mongo_uri();
        let client = connect(&uri).await.unwrap();
        let collection = get_users_collection(&client);
        collection.delete_many(doc! {}).await.unwrap();

        let state = test_state(&uri);

        // Bootstrap owner + login
        let _ = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "testuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        let login = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "testuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        let owner_headers = bearer(&login.0.token);

        // Unauthenticated list → error
        assert!(
            admin_list_users(State(state.clone()), HeaderMap::new())
                .await
                .is_err()
        );

        // 1. Create username-only invite (offline telegram sync → unlinked)
        let (code, created) = admin_create_user(
            State(state.clone()),
            owner_headers.clone(),
            Json(AdminCreateUserRequest {
                username: "invited".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(code, StatusCode::CREATED);
        assert_eq!(created.0.username, "invited");
        assert!(!created.0.claimed);
        assert!(!created.0.is_owner);
        assert_eq!(created.0.created_by.as_deref(), Some("testuser"));
        assert_eq!(created.0.telegram_user_id, None);

        // Duplicate invite → conflict
        let dup = admin_create_user(
            State(state.clone()),
            owner_headers.clone(),
            Json(AdminCreateUserRequest {
                username: "invited".to_string(),
            }),
        )
        .await;
        let dup_err = dup.unwrap_err();
        assert!(
            matches!(dup_err, ApiError::Conflict(_)),
            "unexpected duplicate-create error: {dup_err:?}"
        );

        // 2. Invited account claims its password
        let claim = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "invited".to_string(),
                password: "invitedpass1".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(claim.0.ok);
        // Claim again → conflict
        let reclaim = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "invited".to_string(),
                password: "anotherpass1".to_string(),
            }),
        )
        .await;
        let reclaim_err = reclaim.unwrap_err();
        assert!(
            matches!(reclaim_err, ApiError::Conflict(_)),
            "unexpected re-register error: {reclaim_err:?}"
        );

        // 3. Invited user logs in but cannot reach admin APIs
        let invited_login = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "invited".to_string(),
                password: "invitedpass1".to_string(),
            }),
        )
        .await
        .unwrap();
        let invited_headers = bearer(&invited_login.0.token);
        let me = auth_me(State(state.clone()), invited_headers.clone())
            .await
            .unwrap();
        assert_eq!(me.0.role, "user");
        let denied = admin_list_users(State(state.clone()), invited_headers.clone()).await;
        match denied.unwrap_err() {
            ApiError::Forbidden(msg) => assert!(msg.contains("administrator")),
            e => panic!("expected Forbidden, got {e:?}"),
        }

        // 4. Owner patches invited permissions
        let updated = admin_update_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("invited".to_string()),
            Json(AdminUpdateUserRequest {
                permissions: Some(PermissionsPatch {
                    read: Some(true),
                    write: Some(false),
                }),
                role: None,
                storage_chat_id: None,
            }),
        )
        .await
        .unwrap();
        assert!(updated.0.permissions.read);
        assert!(!updated.0.permissions.write);

        // 4b. Storage chat: set it, refuse the invalid zero, then clear it.
        let chat_set = admin_update_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("invited".to_string()),
            Json(AdminUpdateUserRequest {
                permissions: None,
                role: None,
                storage_chat_id: Some(Some(-100500)),
            }),
        )
        .await
        .unwrap();
        assert_eq!(chat_set.0.storage_chat_id, Some(-100500));

        let zero_chat = admin_update_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("invited".to_string()),
            Json(AdminUpdateUserRequest {
                permissions: None,
                role: None,
                storage_chat_id: Some(Some(0)),
            }),
        )
        .await;
        assert!(matches!(zero_chat.unwrap_err(), ApiError::Validation(_)));

        let chat_cleared = admin_update_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("invited".to_string()),
            Json(AdminUpdateUserRequest {
                permissions: None,
                role: None,
                storage_chat_id: Some(None),
            }),
        )
        .await
        .unwrap();
        assert_eq!(chat_cleared.0.storage_chat_id, None);

        // 5. Guards: self role change, empty patch, unknown user, non-admin patch
        let self_role = admin_update_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("testuser".to_string()),
            Json(AdminUpdateUserRequest {
                permissions: None,
                role: Some("user".to_string()),
                storage_chat_id: None,
            }),
        )
        .await;
        match self_role.unwrap_err() {
            ApiError::Forbidden(_) => {}
            e => panic!("expected Forbidden self-role change, got {e:?}"),
        }
        let empty_patch = admin_update_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("invited".to_string()),
            Json(AdminUpdateUserRequest {
                permissions: None,
                role: None,
                storage_chat_id: None,
            }),
        )
        .await;
        match empty_patch.unwrap_err() {
            ApiError::Validation(_) => {}
            e => panic!("expected Validation empty patch, got {e:?}"),
        }
        let missing = admin_delete_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("ghost".to_string()),
        )
        .await;
        match missing.unwrap_err() {
            ApiError::NotFound(_) => {}
            e => panic!("expected NotFound unknown user, got {e:?}"),
        }
        let non_admin_patch = admin_update_user(
            State(state.clone()),
            invited_headers.clone(),
            Path("invited".to_string()),
            Json(AdminUpdateUserRequest {
                permissions: None,
                role: Some("admin".to_string()),
                storage_chat_id: None,
            }),
        )
        .await;
        assert!(matches!(
            non_admin_patch.unwrap_err(),
            ApiError::Forbidden(_)
        ));

        // 6. Owner cannot delete themselves
        let self_delete = admin_delete_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("testuser".to_string()),
        )
        .await;
        match self_delete.unwrap_err() {
            ApiError::Forbidden(_) => {}
            e => panic!("expected Forbidden self-delete, got {e:?}"),
        }

        // 7. Resync (Fixed resolver → offline, clears the link) → 200
        let resynced = admin_resync_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("invited".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(resynced.0.telegram_user_id, None);

        // 8. Delete invited → 204; list shows only the owner
        let deleted = admin_delete_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("invited".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(deleted, StatusCode::NO_CONTENT);
        let list = admin_list_users(State(state.clone()), owner_headers.clone())
            .await
            .unwrap();
        assert_eq!(list.0.users.len(), 1);
        assert_eq!(list.0.users[0].username, "testuser");
        assert!(list.0.users[0].is_owner);
    }

    /// Owner bootstrap under the reserved `admin` handle, the two-way owner
    /// sign-in alias, and the self-service availability / rename / re-password
    /// endpoints — the whole path a member walks without an admin in the loop.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn test_self_service_account_settings() {
        let uri = test_mongo_uri();
        let client = connect(&uri).await.unwrap();
        get_users_collection(&client)
            .delete_many(doc! {})
            .await
            .unwrap();

        let state = test_state(&uri);

        // 1. Owner opens the account under the reserved `admin` handle.
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "admin".to_string(),
                password: "owner-pass-123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(reg.0.ok);
        assert_eq!(reg.0.username, "admin");

        let owner = find_user(&client, "admin").await.unwrap().unwrap();
        assert!(owner.is_owner());
        // The Telegram link keeps the real owner identity — not the handle the
        // account happened to be opened under.
        assert_eq!(owner.telegram_username.as_deref(), Some("testuser"));
        assert_eq!(owner.telegram_user_id, Some(999999));

        // 2. Both handles sign in to the same account.
        let via_admin = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "admin".to_string(),
                password: "owner-pass-123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(via_admin.0.username, "admin");

        let via_tg = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "TestUser".to_string(),
                password: "owner-pass-123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(via_tg.0.username, "admin");

        // 3. An unknown username is indistinguishable from a bad password —
        //    the owner alias must not turn a miss into a different error.
        let bogus = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "nobody".to_string(),
                password: "owner-pass-123".to_string(),
            }),
        )
        .await;
        match bogus.unwrap_err() {
            ApiError::InvalidInput(msg) => assert_eq!(msg, INVALID_CREDENTIALS),
            e => panic!("expected InvalidInput, got {e:?}"),
        }

        // 4. The owner unlocks a username — the invite flow, unchanged.
        let owner_headers = bearer(&via_admin.0.token);
        let (code, created) = admin_create_user(
            State(state.clone()),
            owner_headers.clone(),
            Json(AdminCreateUserRequest {
                username: "alice".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(code, StatusCode::CREATED);
        assert_eq!(created.0.created_by.as_deref(), Some("admin"));

        // 5. Availability: taken by someone else, free, and malformed.
        let taken = auth_username_available(
            State(state.clone()),
            owner_headers.clone(),
            Query(UsernameAvailableQuery {
                username: "alice".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(!taken.0.available);
        assert_eq!(taken.0.reason.as_deref(), Some("username already taken"));

        let free = auth_username_available(
            State(state.clone()),
            owner_headers.clone(),
            Query(UsernameAvailableQuery {
                username: "bob".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(free.0.available);
        assert!(free.0.reason.is_none());

        let malformed = auth_username_available(
            State(state.clone()),
            owner_headers.clone(),
            Query(UsernameAvailableQuery {
                username: "x".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(!malformed.0.available);
        assert!(malformed.0.reason.is_some());

        // Asking requires a session.
        assert!(
            auth_username_available(
                State(state.clone()),
                HeaderMap::new(),
                Query(UsernameAvailableQuery {
                    username: "bob".to_string(),
                }),
            )
            .await
            .is_err()
        );

        // 6. Alice claims the unlocked username by setting her password.
        let _ = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "alice".to_string(),
                password: "alice-pass-123".to_string(),
            }),
        )
        .await
        .unwrap();
        let alice_login = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "alice".to_string(),
                password: "alice-pass-123".to_string(),
            }),
        )
        .await
        .unwrap();
        let alice_headers = bearer(&alice_login.0.token);

        // 7. Alice renames herself to a free username.
        let renamed = auth_change_username(
            State(state.clone()),
            alice_headers.clone(),
            Json(ChangeUsernameRequest {
                username: "alicia".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(renamed.0.username, "alicia");
        assert_ne!(renamed.0.token, alice_login.0.token);

        // The old token names an account that no longer lives under that
        // username, so it must have been dropped...
        assert!(
            auth_me(State(state.clone()), alice_headers.clone())
                .await
                .is_err()
        );
        // ...and the replacement carries the new name.
        let me = auth_me(State(state.clone()), bearer(&renamed.0.token))
            .await
            .unwrap();
        assert_eq!(me.0.username, "alicia");
        assert_eq!(me.0.role, "user");

        // The document moved: old id gone, new id present.
        assert!(find_user(&client, "alice").await.unwrap().is_none());
        assert!(find_user(&client, "alicia").await.unwrap().is_some());

        // 8. Renaming onto a taken username is refused and leaves the account
        //    exactly where it was.
        let clash = auth_change_username(
            State(state.clone()),
            bearer(&renamed.0.token),
            Json(ChangeUsernameRequest {
                username: "admin".to_string(),
            }),
        )
        .await;
        match clash.unwrap_err() {
            ApiError::Conflict(_) => {}
            e => panic!("expected Conflict, got {e:?}"),
        }
        assert!(find_user(&client, "alicia").await.unwrap().is_some());

        // 9. Re-password: wrong current refused, weak new refused, then the
        //    real swap — old password stops working, new one starts.
        let alicia_headers = bearer(&renamed.0.token);
        let wrong = auth_change_password(
            State(state.clone()),
            alicia_headers.clone(),
            Json(ChangePasswordRequest {
                current_password: "not-the-one".to_string(),
                new_password: "new-pass-456".to_string(),
            }),
        )
        .await;
        match wrong.unwrap_err() {
            ApiError::InvalidInput(_) => {}
            e => panic!("expected InvalidInput, got {e:?}"),
        }

        let weak = auth_change_password(
            State(state.clone()),
            alicia_headers.clone(),
            Json(ChangePasswordRequest {
                current_password: "alice-pass-123".to_string(),
                new_password: "short".to_string(),
            }),
        )
        .await;
        assert!(matches!(weak.unwrap_err(), ApiError::Validation(_)));

        let changed = auth_change_password(
            State(state.clone()),
            alicia_headers.clone(),
            Json(ChangePasswordRequest {
                current_password: "alice-pass-123".to_string(),
                new_password: "new-pass-456".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(changed, StatusCode::NO_CONTENT);

        assert!(
            auth_login(
                State(state.clone()),
                Json(LoginRequest {
                    username: "alicia".to_string(),
                    password: "alice-pass-123".to_string(),
                }),
            )
            .await
            .is_err()
        );
        let _ = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "alicia".to_string(),
                password: "new-pass-456".to_string(),
            }),
        )
        .await
        .unwrap();

        // 10. The owner renames too: the Telegram link survives, because the
        //     configured owner account — not the login name — owns it, and the
        //     `admin` alias still resolves to the renamed account.
        let owner_renamed = auth_change_username(
            State(state.clone()),
            owner_headers.clone(),
            Json(ChangeUsernameRequest {
                username: "boss".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(owner_renamed.0.username, "boss");
        assert_eq!(
            owner_renamed.0.telegram_username.as_deref(),
            Some("testuser")
        );
        assert_eq!(owner_renamed.0.telegram_user_id, Some(999999));

        let boss = find_user(&client, "boss").await.unwrap().unwrap();
        assert!(boss.is_owner());
        assert_eq!(boss.telegram_username.as_deref(), Some("testuser"));

        let still_admin = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "admin".to_string(),
                password: "owner-pass-123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(still_admin.0.username, "boss");
    }

    /// Media serving against a real database: the query token authenticates,
    /// the account must exist, and an unknown name is a 404 — every one of
    /// those decisions happens before any Telegram traffic, so no bot is
    /// needed to run it.
    ///
    /// Run with: `TFS_USER_DB=tfs_v2_local_dev cargo test -p tfs-api -- --ignored --test-threads=1`
    #[tokio::test]
    #[ignore]
    async fn media_serving_authenticates_before_it_reads_anything() {
        let uri = test_mongo_uri();
        let state = test_state(&uri);
        let token = create_session(&state.sessions, "testuser".to_string());

        let anonymous = serve_media(
            &state,
            "movie.mp4",
            false,
            Method::GET,
            &HeaderMap::new(),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(anonymous, ApiError::Unauthorized(_)),
            "expected Unauthorized, got {anonymous:?}"
        );

        let unknown = serve_media(
            &state,
            "definitely-not-here.mp4",
            false,
            Method::GET,
            &HeaderMap::new(),
            Some(&token),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(unknown, ApiError::NotFound(_) | ApiError::Forbidden(_)),
            "expected NotFound or Forbidden, got {unknown:?}"
        );

        let bogus_token = serve_media(
            &state,
            "movie.mp4",
            false,
            Method::GET,
            &HeaderMap::new(),
            Some("not-a-real-session-token"),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(bogus_token, ApiError::Unauthorized(_)),
            "expected Unauthorized, got {bogus_token:?}"
        );
    }

    /// Settings, favorites, and recents round-trip through a real database:
    /// every handler runs with a live session; a missing setting is a 404
    /// whose body has no `error` key (the SPA's null convention).
    ///
    /// Run with: cargo test -p tfs-api -- --ignored --test-threads=1
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn ui_settings_favorites_recents_roundtrip() {
        use http_body_util::BodyExt;

        let uri = test_mongo_uri();
        let client = connect(&uri).await.unwrap();
        let db = client.database(&data_database_name());
        for name in ["v2_settings", "v2_favorites", "v2_recents"] {
            db.collection::<mongodb::bson::Document>(name)
                .delete_many(doc! {})
                .await
                .unwrap();
        }

        let state = test_state(&uri);
        let token = create_session(&state.sessions, "testuser".to_string());
        let headers = bearer(&token);
        let state = State(state);

        // Missing setting: 200 with a JSON `null` body (not 404 — the SPA
        // treats a missing value as "use the default"), and no `error` field.
        let missing = ui::settings_get(
            state.clone(),
            headers.clone(),
            Path("explorer.view_mode".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(missing.status(), StatusCode::OK);
        let body = missing.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(
            value.is_null(),
            "missing setting must be JSON null: {value}"
        );
        assert!(
            value.get("error").is_none(),
            "missing-setting body must not carry an error key: {value}"
        );

        // Store then read back the same JSON value.
        ui::settings_put(
            state.clone(),
            headers.clone(),
            Path("explorer.view_mode".to_string()),
            Json(serde_json::json!("grid")),
        )
        .await
        .unwrap();
        let stored = ui::settings_get(
            state.clone(),
            headers.clone(),
            Path("explorer.view_mode".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(stored.status(), StatusCode::OK);
        let body = stored.into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value, serde_json::json!("grid"));

        // Favorites: add two, list, remove one.
        ui::favorites_add(
            state.clone(),
            headers.clone(),
            Json(ui::FavoriteAddRequest {
                path: "/Home/Images".to_string(),
                label: "Images".to_string(),
            }),
        )
        .await
        .unwrap();
        ui::favorites_add(
            state.clone(),
            headers.clone(),
            Json(ui::FavoriteAddRequest {
                path: "/Home/Videos".to_string(),
                label: "Videos".to_string(),
            }),
        )
        .await
        .unwrap();
        let listed = ui::favorites_list(state.clone(), headers.clone())
            .await
            .unwrap();
        assert_eq!(listed.0.len(), 2);
        let first = &listed.0[0];
        assert_eq!(first.path, "/Home/Images");
        ui::favorites_remove(state.clone(), headers.clone(), Path(first.id.to_string()))
            .await
            .unwrap();
        let after_remove = ui::favorites_list(state.clone(), headers.clone())
            .await
            .unwrap();
        assert_eq!(after_remove.0.len(), 1);
        assert_eq!(after_remove.0[0].path, "/Home/Videos");

        // Recents: one visit, then list returns it with an RFC3339 stamp.
        ui::recents_add(
            state.clone(),
            headers.clone(),
            Json(ui::RecentAddRequest {
                path: "/Home".to_string(),
            }),
        )
        .await
        .unwrap();
        // Re-visiting the same path must not duplicate the row.
        ui::recents_add(
            state.clone(),
            headers.clone(),
            Json(ui::RecentAddRequest {
                path: "/Home".to_string(),
            }),
        )
        .await
        .unwrap();
        let recents = ui::recents_list(
            state.clone(),
            headers.clone(),
            Query(ui::RecentsQuery { limit: None }),
        )
        .await
        .unwrap();
        assert_eq!(recents.0.len(), 1);
        assert_eq!(recents.0[0].path, "/Home");
        assert!(
            chrono::DateTime::parse_from_rfc3339(&recents.0[0].last_opened).is_ok(),
            "last_opened must be RFC3339: {}",
            recents.0[0].last_opened
        );

        // Favorites are owner-scoped: a second session (same store, other
        // user) sees none of the rows above.
        let other_headers = bearer(&create_session(&state.sessions, "other".to_string()));
        let other = ui::favorites_list(state.clone(), other_headers.clone())
            .await
            .unwrap();
        assert!(other.0.is_empty());
        let other_missing = ui::settings_get(
            state.clone(),
            other_headers,
            Path("explorer.view_mode".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(other_missing.status(), StatusCode::OK);
    }
}
