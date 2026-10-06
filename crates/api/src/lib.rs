use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Router,
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mongodb::{Collection, bson::doc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tfs_config::{
    CheckResponse, ConfigError, KdfParams, SaveResponse, Step1Input, Step2Input,
    appdata::{
        ConnectionStore, delete_connection, delete_local_config, load_connection,
        load_local_config, save_connection, save_local_config,
    },
    create_setup_config, verify_and_decrypt,
};
use tfs_db::{DbError, connect, has_config, load_config, save_config};
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

/// User document in MongoDB (collection: v2_users)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserDoc {
    #[serde(rename = "_id")]
    id: String, // lowercased username
    username: String,
    password_hash: String, // Argon2 PHC string
    created_at: chrono::DateTime<chrono::Utc>,
}

impl UserDoc {
    const COLLECTION_NAME: &'static str = "v2_users";
    const DATABASE_NAME: &'static str = "tfs_v2";
}

fn get_users_collection(client: &mongodb::Client) -> Collection<UserDoc> {
    client
        .database(UserDoc::DATABASE_NAME)
        .collection(UserDoc::COLLECTION_NAME)
}

/// Check if any user exists (for registration gate)
async fn any_user_exists(client: &mongodb::Client) -> Result<bool, DbError> {
    let collection = get_users_collection(client);
    let count = collection.count_documents(doc! {}).await?;
    Ok(count > 0)
}

/// Create a new user
async fn create_user(
    client: &mongodb::Client,
    username: &str,
    password: &str,
) -> Result<UserDoc, DbError> {
    let collection = get_users_collection(client);
    let id = username.to_lowercase();
    let kdf = KdfParams::new(); // strong params, unique salt per user
    let password_hash =
        hash_password_phc(password, &kdf).map_err(|e| DbError::InvalidData(e.to_string()))?;
    let user = UserDoc {
        id: id.clone(),
        username: username.to_string(),
        password_hash,
        created_at: chrono::Utc::now(),
    };
    collection.insert_one(&user).await?;
    Ok(user)
}

/// Find user by username (case-insensitive via lowercased _id)
async fn find_user(client: &mongodb::Client, username: &str) -> Result<Option<UserDoc>, DbError> {
    let collection = get_users_collection(client);
    let id = username.to_lowercase();
    let user = collection.find_one(doc! { "_id": &id }).await?;
    Ok(user)
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
}

#[derive(Debug, Serialize)]
struct AuthStatusResponse {
    needs_registration: bool,
}

/// GET /api/auth/status — true iff users collection is empty (or Mongo unreachable → 502)
async fn auth_status(State(state): State<Arc<AppState>>) -> ApiResult<Json<AuthStatusResponse>> {
    let client = connect(&state.mongo_uri).await?;
    let needs_registration = !any_user_exists(&client).await?;
    Ok(Json(AuthStatusResponse { needs_registration }))
}

/// POST /api/auth/register
async fn auth_register(
    State(state): State<Arc<AppState>>,
    Json(input): Json<RegisterRequest>,
) -> ApiResult<Json<RegisterResponse>> {
    // Validate username
    validate_username(&input.username).map_err(ApiError::Validation)?;
    // Validate password
    validate_password(&input.password).map_err(ApiError::Validation)?;

    let client = connect(&state.mongo_uri).await?;

    // Registration gate: reject if any user already exists
    if any_user_exists(&client).await? {
        return Err(ApiError::InvalidInput("registration closed".to_string()));
    }

    // Create user (duplicate username → 409 via MongoDB duplicate key error)
    match create_user(&client, &input.username, &input.password).await {
        Ok(user) => Ok(Json(RegisterResponse {
            ok: true,
            username: user.username,
        })),
        Err(DbError::Connection(e)) if e.to_string().contains("E11000") => {
            // Duplicate key error (username already exists)
            Err(ApiError::InvalidInput(
                "username already exists".to_string(),
            ))
        }
        Err(e) => Err(e.into()),
    }
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

    // Verify password
    if !verify_password_phc(&input.password, &user.password_hash)
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

/// GET /api/auth/me — requires Bearer token, returns username, refreshes sliding TTL
async fn auth_me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<MeResponse>> {
    let username = require_session(&headers, &state.sessions)?;
    Ok(Json(MeResponse { username }))
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
}

impl AppState {
    pub fn new(mongo_uri: String) -> Self {
        Self {
            mongo_uri,
            sessions: new_session_store(),
        }
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
    // Run with: cargo test --test auth_integration -- --ignored
    // These are marked #[ignore] per repo precedent (like test_connect_and_save_load in db tests)

    #[tokio::test]
    #[ignore]
    async fn test_auth_register_login_me_logout_flow() {
        let uri = std::env::var("MONGODB_URI")
            .unwrap_or_else(|_| "mongodb://localhost:27017".to_string());
        let client = connect(&uri).await.unwrap();

        // Clean up any existing users
        let collection = get_users_collection(&client);
        collection.delete_many(doc! {}).await.unwrap();

        let state = Arc::new(AppState::new(uri.clone()));

        // 1. Status: needs_registration = true (empty collection)
        let status = auth_status(State(state.clone())).await.unwrap();
        assert!(status.0.needs_registration);

        // 2. Register first user
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "testuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(reg.0.ok);
        assert_eq!(reg.0.username, "testuser");

        // 3. Status: needs_registration = false (user exists)
        let status = auth_status(State(state.clone())).await.unwrap();
        assert!(!status.0.needs_registration);

        // 4. Register again → 403 registration closed
        let reg2 = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "another".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        assert!(reg2.is_err());
        match reg2.unwrap_err() {
            ApiError::InvalidInput(msg) => assert_eq!(msg, "registration closed"),
            _ => panic!("expected InvalidInput registration closed"),
        }

        // 5. Login with correct password
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

        // 6. Login with wrong password → 401 (same message as wrong user)
        let login_wrong = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "testuser".to_string(),
                password: "wrongpassword".to_string(),
            }),
        )
        .await;
        assert!(login_wrong.is_err());
        match login_wrong.unwrap_err() {
            ApiError::InvalidInput(msg) => assert_eq!(msg, "invalid username or password"),
            _ => panic!("expected InvalidInput invalid username or password"),
        }

        // 7. Login with non-existent user → 401 (same message, no user enumeration)
        let login_no_user = auth_login(
            State(state.clone()),
            Json(LoginRequest {
                username: "nonexistent".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        assert!(login_no_user.is_err());
        match login_no_user.unwrap_err() {
            ApiError::InvalidInput(msg) => assert_eq!(msg, "invalid username or password"),
            _ => panic!("expected InvalidInput invalid username or password"),
        }

        // 8. /me with valid token → 200 {username}
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
        );
        let me = auth_me(State(state.clone()), headers).await.unwrap();
        assert_eq!(me.0.username, "testuser");

        // 9. /me with invalid token → 401
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer invalid"));
        let me_invalid = auth_me(State(state.clone()), headers).await;
        assert!(me_invalid.is_err());

        // 10. /me without token → 401
        let headers = HeaderMap::new();
        let me_no_token = auth_me(State(state.clone()), headers).await;
        assert!(me_no_token.is_err());

        // 11. Logout → 204
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
        );
        let logout = auth_logout(State(state.clone()), headers).await.unwrap();
        assert_eq!(logout.into_response().status(), StatusCode::NO_CONTENT);

        // 12. Logout again (idempotent) → 204
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
        );
        let logout2 = auth_logout(State(state.clone()), headers).await.unwrap();
        assert_eq!(logout2.into_response().status(), StatusCode::NO_CONTENT);

        // 13. /me after logout → 401
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {}", token)).unwrap(),
        );
        let me_after_logout = auth_me(State(state.clone()), headers).await;
        assert!(me_after_logout.is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn test_auth_validation_errors() {
        let uri = std::env::var("MONGODB_URI")
            .unwrap_or_else(|_| "mongodb://localhost:27017".to_string());
        let client = connect(&uri).await.unwrap();

        // Clean up
        let collection = get_users_collection(&client);
        collection.delete_many(doc! {}).await.unwrap();

        let state = Arc::new(AppState::new(uri));

        // Username too short
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "ab".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        assert!(reg.is_err());
        match reg.unwrap_err() {
            ApiError::Validation(msg) => assert!(msg.contains("3-32 characters")),
            _ => panic!("expected Validation error"),
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
        assert!(reg.is_err());
        match reg.unwrap_err() {
            ApiError::Validation(msg) => assert!(msg.contains("letters, numbers")),
            _ => panic!("expected Validation error"),
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
        assert!(reg.is_err());
        match reg.unwrap_err() {
            ApiError::Validation(msg) => assert!(msg.contains("at least 8 characters")),
            _ => panic!("expected Validation error"),
        }

        // Duplicate username → 409
        let _ = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "dupuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await
        .unwrap();
        let reg = auth_register(
            State(state.clone()),
            Json(RegisterRequest {
                username: "dupuser".to_string(),
                password: "password123".to_string(),
            }),
        )
        .await;
        assert!(reg.is_err());
        match reg.unwrap_err() {
            ApiError::InvalidInput(msg) => assert_eq!(msg, "username already exists"),
            _ => panic!("expected InvalidInput username already exists"),
        }
    }
}
