use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Router,
    extract::{Json, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use futures::TryStreamExt;
use mongodb::{
    Collection,
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
use tfs_telegram::{GrammersClient, TelegramClient, lookup as tg_lookup};
use thiserror::Error;

/// Validate Step1Input manually (mirrors tfs-config validation)
fn validate_step1(input: &Step1Input) -> Result<(), String> {
    if input.mongo_uri.is_empty() {
        return Err("MongoDB URI is required".to_string());
    }
    if input.password.len() < 8 {
        return Err("Password must be at least 8 characters".to_string());
    }
    Ok(())
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
pub fn require_session(headers: &HeaderMap, store: &SessionStore) -> Result<String, ApiError> {
    let token = extract_bearer_token(headers).ok_or_else(|| {
        ApiError::InvalidInput("missing or invalid Authorization header".to_string())
    })?;
    validate_session(store, &token)
        .ok_or_else(|| ApiError::InvalidInput("invalid or expired session".to_string()))
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
    #[serde(default = "default_permissions")]
    permissions: Permissions,
    created_at: chrono::DateTime<chrono::Utc>,
    /// Username of the admin who created this account.
    /// `None` marks the owner account (bootstrap admin from config owner_id).
    #[serde(default)]
    created_by: Option<String>,
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

/// Database holding user documents.
///
/// Defaults to the canonical `tfs_v2` database. `TFS_USER_DB` redirects it so
/// an integration suite — which resets `v2_users` at the start of every test —
/// can claim a private database. Without this, two concurrent runs (e.g. a
/// `pull_request` run overlapping a `push` run) delete each other's fixtures
/// mid-test and fail spuriously. Unset in production, so behaviour there is
/// unchanged.
fn users_database_name() -> String {
    std::env::var("TFS_USER_DB")
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| UserDoc::DATABASE_NAME.to_string())
}

fn get_users_collection(client: &mongodb::Client) -> Collection<UserDoc> {
    client
        .database(&users_database_name())
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
}

#[derive(Debug, Serialize)]
struct AuthStatusResponse {
    needs_registration: bool,
    /// `"owner"` — bootstrap: register with the owner's Telegram username
    /// (becomes the admin account). `"invite"` — admin exists; invited
    /// accounts claim their password here, everyone else signs in.
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
    bot_token: String,
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
    let bot_token = local
        .sensitive
        .bot_tokens
        .iter()
        .find(|t| !t.is_empty())
        .cloned()
        .ok_or_else(|| {
            ApiError::Telegram("no bot token in local config — re-run the setup wizard".to_string())
        })?;
    Ok(TelegramCreds {
        api_id,
        api_hash: local.sensitive.api_hash,
        bot_token,
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
    let client = connect(&state.mongo_uri).await?;
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

    let client = connect(&state.mongo_uri).await?;

    if count_role(&client, "admin").await? == 0 {
        // ===== Owner bootstrap =====
        let (owner_id, owner_name) = resolve_owner_identity(&state).await?;
        if !input.username.eq_ignore_ascii_case(&owner_name) {
            return Err(ApiError::Forbidden(format!(
                "username must match the Telegram owner account \"{owner_name}\""
            )));
        }
        let kdf = KdfParams::new();
        let password_hash = hash_password_phc(&input.password, &kdf)
            .map_err(|e| ApiError::Internal(e.to_string()))?;

        return match find_user(&client, &input.username).await? {
            None => {
                let user = UserDoc {
                    id: owner_name.to_lowercase(),
                    username: owner_name.clone(),
                    password_hash: Some(password_hash),
                    role: "admin".to_string(),
                    telegram_user_id: owner_id,
                    telegram_username: Some(owner_name.clone()),
                    permissions: default_permissions(),
                    created_at: chrono::Utc::now(),
                    created_by: None,
                };
                match insert_user(&client, &user).await {
                    Ok(()) => {}
                    Err(DbError::Connection(e)) if e.to_string().contains("E11000") => {
                        return Err(ApiError::Conflict(
                            "username already exists — sign in instead".to_string(),
                        ));
                    }
                    Err(e) => return Err(e.into()),
                }
                Ok(Json(RegisterResponse {
                    ok: true,
                    username: user.username,
                }))
            }
            Some(existing) if existing.claimed() => {
                // Account already registered under the owner's name (legacy
                // test data): promote it to owner and ask them to sign in.
                promote_to_owner(&client, &existing.id, owner_id, &owner_name).await?;
                Err(ApiError::Conflict(
                    "account already registered — sign in instead".to_string(),
                ))
            }
            Some(existing) => {
                // Owner invite sitting unclaimed: set password + promote.
                set_password(&client, &existing.id, password_hash).await?;
                promote_to_owner(&client, &existing.id, owner_id, &owner_name).await?;
                Ok(Json(RegisterResponse {
                    ok: true,
                    username: existing.username,
                }))
            }
        };
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

/// POST /api/auth/login
async fn auth_login(
    State(state): State<Arc<AppState>>,
    Json(input): Json<LoginRequest>,
) -> ApiResult<Json<LoginResponse>> {
    let client = connect(&state.mongo_uri).await?;

    let user = match find_user(&client, &input.username).await? {
        Some(u) => u,
        None => {
            // User not found — same error as wrong password (no user enumeration)
            return Err(ApiError::InvalidInput(
                "invalid username or password".to_string(),
            ));
        }
    };

    // Unclaimed invites have no password yet — indistinguishable from a
    // wrong password (no user enumeration).
    let Some(ref stored_hash) = user.password_hash else {
        return Err(ApiError::InvalidInput(
            "invalid username or password".to_string(),
        ));
    };

    // Verify password
    if !verify_password_phc(&input.password, stored_hash)
        .map_err(|e| ApiError::Internal(e.to_string()))?
    {
        return Err(ApiError::InvalidInput(
            "invalid username or password".to_string(),
        ));
    }

    // Create session
    let token = create_session(&state.sessions, user.username.clone());

    Ok(Json(LoginResponse {
        token,
        username: user.username,
    }))
}

/// GET /api/auth/me — requires Bearer token, returns profile + role,
/// refreshes sliding TTL.
async fn auth_me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<MeResponse>> {
    let username = require_session(&headers, &state.sessions)?;
    let client = connect(&state.mongo_uri).await?;
    let user = find_user(&client, &username)
        .await?
        .ok_or_else(|| ApiError::Forbidden("account no longer exists".to_string()))?;
    Ok(Json(MeResponse {
        username: user.username,
        role: user.role,
        permissions: user.permissions,
        telegram_username: user.telegram_username,
        telegram_user_id: user.telegram_user_id,
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
        (status, body).into_response()
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
}

impl AppState {
    pub fn new(mongo_uri: String) -> Self {
        Self {
            mongo_uri,
            sessions: new_session_store(),
            owner_resolver: OwnerResolver::from_env(),
            tg: Arc::new(tokio::sync::Mutex::new(None)),
        }
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

    // The URI typed in the wizard is authoritative — do NOT use the server's
    // configured MONGO_URI here (that is only a launch default).
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
}

/// Require a valid session AND the admin role; returns the acting user.
async fn require_admin(headers: &HeaderMap, state: &AppState) -> Result<UserDoc, ApiError> {
    let username = require_session(headers, &state.sessions)?;
    let client = connect(&state.mongo_uri).await?;
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
    let client = connect(&state.mongo_uri).await?;
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
    let client = connect(&state.mongo_uri).await?;
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
        permissions: default_permissions(),
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
    let client = connect(&state.mongo_uri).await?;
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

    if fields.is_empty() {
        return Err(ApiError::Validation(
            "nothing to update — provide role and/or permissions".to_string(),
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
    let client = connect(&state.mongo_uri).await?;
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
    let client = connect(&state.mongo_uri).await?;
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

pub fn router(mongo_uri: String) -> Router {
    let state = Arc::new(AppState::new(mongo_uri));
    Router::new()
        .route("/api/setup/check", post(check_setup))
        .route("/api/setup/save", post(save_setup))
        .route("/api/setup/resume", get(resume_setup))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/register", post(auth_register))
        .route("/api/auth/login", post(auth_login))
        .route("/api/auth/me", get(auth_me))
        .route("/api/auth/logout", post(auth_logout))
        .route(
            "/api/admin/users",
            get(admin_list_users).post(admin_create_user),
        )
        .route(
            "/api/admin/users/:username",
            patch(admin_update_user).delete(admin_delete_user),
        )
        .route("/api/admin/users/:username/resync", post(admin_resync_user))
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
            }),
        )
        .await
        .unwrap();
        assert!(updated.0.permissions.read);
        assert!(!updated.0.permissions.write);

        // 5. Guards: self role change, empty patch, unknown user, non-admin patch
        let self_role = admin_update_user(
            State(state.clone()),
            owner_headers.clone(),
            Path("testuser".to_string()),
            Json(AdminUpdateUserRequest {
                permissions: None,
                role: Some("user".to_string()),
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
}
