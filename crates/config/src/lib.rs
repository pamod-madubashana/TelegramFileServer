use aead::{Aead, KeyInit, OsRng as AeadOsRng};
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{Key as XChaChaKey, XChaCha20Poly1305, XNonce as XChaChaNonce};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const KDF_ALGORITHM: &str = "argon2id";
pub const ENCRYPTION_ALGORITHM: &str = "xchacha20poly1305";
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24; // XChaCha20-Poly1305 uses 24-byte nonce
pub const KEY_LEN: usize = 32;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("encryption failed: {0}")]
    Encryption(String),
    #[error("decryption failed: {0}")]
    Decryption(String),
    #[error("invalid password: {0}")]
    InvalidPassword(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("base64 decode error: {0}")]
    Base64Decode(#[from] base64::DecodeError),
    #[error("argon2 error: {0}")]
    Argon2(String),
}

pub type Result<T> = std::result::Result<T, ConfigError>;

/// Argon2id KDF parameters stored alongside the encrypted data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParams {
    pub salt: String, // base64 encoded
    pub algorithm: String,
    pub version: u32,
    pub memory: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            salt: String::new(),
            algorithm: KDF_ALGORITHM.to_string(),
            version: 19,   // Argon2 version 19 (0x13)
            memory: 65536, // 64 MB
            iterations: 3,
            parallelism: 4,
        }
    }
}

impl KdfParams {
    pub fn new() -> Self {
        let mut salt_bytes = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt_bytes);
        Self {
            salt: BASE64.encode(salt_bytes),
            ..Default::default()
        }
    }

    /// Cheap params for the encrypted halves of the local store
    /// (binary-dir `config.tfs`): the plaintext wizard password sits in
    /// appdata `data.tfs` on the same machine by design, so brute-force
    /// resistance of these local files comes from that layout — not from
    /// expensive hashing. Using the
    /// strong 64 MB × 3 params here made every resume pay seconds of
    /// Argon2 before responding; these params hash in ~10 ms.
    pub fn local() -> Self {
        Self {
            memory: 8_192, // 8 MB
            iterations: 1,
            parallelism: 1,
            ..Self::new()
        }
    }

    pub fn from_salt(salt: &[u8]) -> Self {
        Self {
            salt: BASE64.encode(salt),
            ..Default::default()
        }
    }

    pub fn salt_bytes(&self) -> Result<Vec<u8>> {
        BASE64.decode(&self.salt).map_err(ConfigError::Base64Decode)
    }

    pub fn argon2(&self) -> Argon2<'_> {
        Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            argon2::Params::new(
                self.memory,
                self.iterations,
                self.parallelism,
                Some(KEY_LEN),
            )
            .expect("valid argon2 params"),
        )
    }
}

/// Encrypted payload containing the sensitive configuration fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub nonce: String,      // base64 encoded
    pub ciphertext: String, // base64 encoded
}

impl EncryptedPayload {
    pub fn new(nonce: &[u8], ciphertext: &[u8]) -> Self {
        Self {
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        }
    }

    pub fn nonce_bytes(&self) -> Result<Vec<u8>> {
        BASE64
            .decode(&self.nonce)
            .map_err(ConfigError::Base64Decode)
    }

    pub fn ciphertext_bytes(&self) -> Result<Vec<u8>> {
        BASE64
            .decode(&self.ciphertext)
            .map_err(ConfigError::Base64Decode)
    }
}

/// Sensitive data that gets encrypted
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensitiveData {
    pub api_hash: String,
    pub bot_tokens: Vec<String>,
    /// Encrypted alongside api_hash — Telegram API credentials are useless
    /// without both. Legacy docs (written before api_id was encrypted)
    /// deserialize as 0 and get upgraded on the next wizard save.
    #[serde(default)]
    pub api_id: i64,
}

/// Complete setup configuration stored in MongoDB
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupConfig {
    #[serde(rename = "_id")]
    pub id: String, // always "setup"
    pub kdf: KdfParams,
    pub password_hash: String, // Argon2 hash (PHC string format)
    pub encrypted: EncryptedPayload,
    // NOTE: api_id is NOT stored here — it lives inside `encrypted`
    // (SensitiveData) so it is protected by the wizard password.
    pub owner_id: i64,
    /// Fallback storage chat for uploads when none is configured elsewhere.
    pub default_chat_id: i64,
    pub created_at: DateTime<Utc>,
}

impl SetupConfig {
    pub const COLLECTION_NAME: &'static str = "v2_setup";
    pub const DATABASE_NAME: &'static str = "tfs_v2";
    pub const DOC_ID: &'static str = "setup";
}

/// Input for step 1: MongoDB URI and password
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step1Input {
    pub mongo_uri: String,
    pub password: String,
}

/// Input for step 2: Telegram configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step2Input {
    pub api_id: i64,
    pub api_hash: String,
    pub bot_token_1: String,
    pub owner_id: i64,
    /// Chat that receives files when no chat is configured per file/user.
    /// Required —0 is invalid, negatives are valid (groups/channels).
    #[serde(default)]
    pub default_chat_id: i64,
    pub bot_token_2: Option<String>,
    pub bot_token_3: Option<String>,
}

/// Response for /api/setup/check
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResponse {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Response for /api/setup/save
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Derive encryption key from password using Argon2id
fn derive_key(password: &str, kdf: &KdfParams) -> Result<[u8; KEY_LEN]> {
    let salt = kdf.salt_bytes()?;
    let argon2 = kdf.argon2();
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|e| ConfigError::Encryption(e.to_string()))?;
    Ok(key)
}

/// Hash password for storage (Argon2id PHC format)
fn hash_password(password: &str, kdf: &KdfParams) -> Result<String> {
    let argon2 = kdf.argon2();
    // Dedicated PHC-format salt: kdf.salt is standard base64 *with* padding,
    // which SaltString::from_b64 rejects ('=' is invalid in the PHC alphabet).
    // Verification reads the salt back from the stored PHC string, so the
    // password-hash salt and the encryption salt do not need to match.
    let salt_str = SaltString::generate(&mut OsRng);
    let password_hash = argon2
        .hash_password(password.as_bytes(), &salt_str)
        .map_err(|e| ConfigError::Encryption(e.to_string()))?;
    Ok(password_hash.to_string())
}

/// Verify password against stored hash
fn verify_password(password: &str, password_hash: &str) -> Result<bool> {
    let parsed_hash =
        PasswordHash::new(password_hash).map_err(|e| ConfigError::Argon2(e.to_string()))?;
    let argon2 = Argon2::default();
    Ok(argon2
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

/// Encrypt an arbitrary JSON-serializable value using XChaCha20-Poly1305
/// with a key derived from the wizard password (Argon2id).
pub fn encrypt_value<T: Serialize>(
    data: &T,
    password: &str,
    kdf: &KdfParams,
) -> Result<EncryptedPayload> {
    let key = derive_key(password, kdf)?;
    let cipher = XChaCha20Poly1305::new(XChaChaKey::from_slice(&key));

    let mut nonce_bytes = [0u8; NONCE_LEN];
    AeadOsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XChaChaNonce::from_slice(&nonce_bytes);

    let plaintext = serde_json::to_vec(data).map_err(ConfigError::Serialization)?;
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| ConfigError::Encryption(e.to_string()))?;

    Ok(EncryptedPayload::new(&nonce_bytes, &ciphertext))
}

/// Decrypt a value encrypted by [`encrypt_value`] using the wizard password.
pub fn decrypt_value<T: serde::de::DeserializeOwned>(
    encrypted: &EncryptedPayload,
    password: &str,
    kdf: &KdfParams,
) -> Result<T> {
    let key = derive_key(password, kdf)?;
    let cipher = XChaCha20Poly1305::new(XChaChaKey::from_slice(&key));

    let nonce_bytes = encrypted.nonce_bytes()?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(ConfigError::Decryption("invalid nonce length".to_string()));
    }
    let nonce = XChaChaNonce::from_slice(&nonce_bytes);

    let ciphertext = encrypted.ciphertext_bytes()?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| ConfigError::Decryption(e.to_string()))?;

    serde_json::from_slice(&plaintext).map_err(ConfigError::Serialization)
}

/// Encrypt sensitive data using XChaCha20-Poly1305
pub fn encrypt_sensitive(
    data: &SensitiveData,
    password: &str,
    kdf: &KdfParams,
) -> Result<EncryptedPayload> {
    encrypt_value(data, password, kdf)
}

/// Decrypt sensitive data using XChaCha20-Poly1305
pub fn decrypt_sensitive(
    encrypted: &EncryptedPayload,
    password: &str,
    kdf: &KdfParams,
) -> Result<SensitiveData> {
    decrypt_value(encrypted, password, kdf)
}

/// Create a new SetupConfig from step inputs
pub fn create_setup_config(step1: &Step1Input, step2: &Step2Input) -> Result<SetupConfig> {
    // Manual validation (replaces validator::Validate derive)
    if step1.mongo_uri.is_empty() {
        return Err(ConfigError::Validation(
            "MongoDB URI is required".to_string(),
        ));
    }
    if step1.password.len() < 8 {
        return Err(ConfigError::Validation(
            "Password must be at least 8 characters".to_string(),
        ));
    }
    if step2.api_id <= 0 {
        return Err(ConfigError::Validation(
            "API ID must be a positive integer".to_string(),
        ));
    }
    if step2.api_hash.is_empty() {
        return Err(ConfigError::Validation("API hash is required".to_string()));
    }
    if step2.bot_token_1.is_empty() {
        return Err(ConfigError::Validation(
            "Bot token 1 is required".to_string(),
        ));
    }
    if step2.owner_id <= 0 {
        return Err(ConfigError::Validation(
            "Owner ID must be a positive integer".to_string(),
        ));
    }
    if step2.default_chat_id == 0 {
        return Err(ConfigError::Validation(
            "Default chat ID is required".to_string(),
        ));
    }

    let kdf = KdfParams::new();
    let password_hash = hash_password(&step1.password, &kdf)?;

    let bot_tokens = vec![
        step2.bot_token_1.clone(),
        step2.bot_token_2.clone().unwrap_or_default(),
        step2.bot_token_3.clone().unwrap_or_default(),
    ]
    .into_iter()
    .filter(|t| !t.is_empty())
    .collect();

    let sensitive = SensitiveData {
        api_id: step2.api_id,
        api_hash: step2.api_hash.clone(),
        bot_tokens,
    };

    let encrypted = encrypt_sensitive(&sensitive, &step1.password, &kdf)?;

    Ok(SetupConfig {
        id: SetupConfig::DOC_ID.to_string(),
        kdf,
        password_hash,
        encrypted,
        owner_id: step2.owner_id,
        default_chat_id: step2.default_chat_id,
        created_at: Utc::now(),
    })
}

/// Verify password and decrypt config
pub fn verify_and_decrypt(config: &SetupConfig, password: &str) -> Result<SensitiveData> {
    if !verify_password(password, &config.password_hash)? {
        return Err(ConfigError::InvalidPassword(
            "password doesn't match existing config".to_string(),
        ));
    }
    decrypt_sensitive(&config.encrypted, password, &config.kdf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn valid_step1() -> Step1Input {
        Step1Input {
            mongo_uri: "mongodb://localhost:27017".to_string(),
            password: "password123".to_string(),
        }
    }

    fn valid_step2() -> Step2Input {
        Step2Input {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            bot_token_2: Some("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew12".to_string()),
            bot_token_3: None,
            owner_id: 987654321,
            // Negative IDs are valid: storage targets are often groups/channels.
            default_chat_id: -1001234567890,
        }
    }

    #[test]
    fn test_roundtrip_encryption() {
        let step1 = valid_step1();
        let step2 = valid_step2();
        let config = create_setup_config(&step1, &step2).unwrap();

        let decrypted = verify_and_decrypt(&config, &step1.password).unwrap();

        assert_eq!(decrypted.api_id, step2.api_id);
        assert_eq!(decrypted.api_hash, step2.api_hash);
        assert_eq!(decrypted.bot_tokens.len(), 2);
        assert_eq!(decrypted.bot_tokens[0], step2.bot_token_1);
        assert_eq!(decrypted.bot_tokens[1], step2.bot_token_2.unwrap());
    }

    #[test]
    fn test_wrong_password_fails() {
        let step1 = valid_step1();
        let step2 = valid_step2();
        let config = create_setup_config(&step1, &step2).unwrap();

        let result = verify_and_decrypt(&config, "wrongpassword123");
        assert!(result.is_err());
        match result.unwrap_err() {
            ConfigError::InvalidPassword(msg) => {
                assert_eq!(msg, "password doesn't match existing config");
            }
            _ => panic!("expected InvalidPassword error"),
        }
    }

    #[test]
    fn test_7_char_password_rejected() {
        let mut step1 = valid_step1();
        step1.password = "passwor".to_string(); // 7 chars
        let step2 = valid_step2();

        let result = create_setup_config(&step1, &step2);
        assert!(result.is_err());
        match result.unwrap_err() {
            ConfigError::Validation(msg) => {
                assert!(msg.contains("Password must be at least 8 characters"));
            }
            _ => panic!("expected Validation error"),
        }
    }

    #[test]
    fn test_empty_required_fields_rejected() {
        let mut step2 = valid_step2();
        step2.api_hash = "".to_string();

        let step1 = valid_step1();
        let result = create_setup_config(&step1, &step2);
        assert!(result.is_err());
        match result.unwrap_err() {
            ConfigError::Validation(msg) => {
                assert!(msg.contains("API hash is required"));
            }
            _ => panic!("expected Validation error"),
        }
    }

    #[test]
    fn test_zero_api_id_rejected() {
        let mut step2 = valid_step2();
        step2.api_id = 0;

        let step1 = valid_step1();
        let result = create_setup_config(&step1, &step2);
        assert!(result.is_err());
        match result.unwrap_err() {
            ConfigError::Validation(msg) => {
                assert!(msg.contains("API ID must be a positive integer"));
            }
            _ => panic!("expected Validation error"),
        }
    }

    #[test]
    fn test_zero_default_chat_id_rejected() {
        let mut step2 = valid_step2();
        step2.default_chat_id = 0;

        let step1 = valid_step1();
        let result = create_setup_config(&step1, &step2);
        assert!(result.is_err());
        match result.unwrap_err() {
            ConfigError::Validation(msg) => {
                assert!(msg.contains("Default chat ID is required"));
            }
            _ => panic!("expected Validation error"),
        }
    }

    #[test]
    fn test_negative_default_chat_id_accepted() {
        let mut step2 = valid_step2();
        step2.default_chat_id = -1009876543210; // groups/channels are negative

        let step1 = valid_step1();
        let config = create_setup_config(&step1, &step2).unwrap();
        assert_eq!(config.default_chat_id, -1009876543210);
    }

    #[test]
    fn test_optional_bot_tokens() {
        let mut step2 = valid_step2();
        step2.bot_token_2 = None;
        step2.bot_token_3 = None;

        let step1 = valid_step1();
        let config = create_setup_config(&step1, &step2).unwrap();

        let decrypted = verify_and_decrypt(&config, &step1.password).unwrap();
        assert_eq!(decrypted.bot_tokens.len(), 1);
        assert_eq!(decrypted.bot_tokens[0], step2.bot_token_1);
    }

    #[test]
    fn test_kdf_params_default() {
        let kdf = KdfParams::default();
        assert_eq!(kdf.algorithm, KDF_ALGORITHM);
        assert_eq!(kdf.version, 19);
        assert_eq!(kdf.memory, 65536);
        assert_eq!(kdf.iterations, 3);
        assert_eq!(kdf.parallelism, 4);
    }

    #[test]
    fn test_kdf_params_local_is_cheap() {
        let kdf = KdfParams::local();
        assert_eq!(kdf.memory, 8_192);
        assert_eq!(kdf.iterations, 1);
        assert_eq!(kdf.parallelism, 1);
        // Fresh random salt per call (distinct derived keys).
        assert_ne!(KdfParams::local().salt, kdf.salt);
        assert!(!kdf.salt.is_empty());
    }

    #[test]
    fn test_kdf_params_new_generates_salt() {
        let kdf1 = KdfParams::new();
        let kdf2 = KdfParams::new();
        assert_ne!(kdf1.salt, kdf2.salt);
        assert!(!kdf1.salt.is_empty());
    }

    proptest! {
        #[test]
        fn test_encrypt_decrypt_roundtrip_prop(
            api_id in 1i64..i64::MAX,
            api_hash in "[a-f0-9]{32}",
            bot_token_1 in "[0-9]{6}:[A-Za-z0-9_-]{35}",
            bot_token_2 in proptest::option::of("[0-9]{6}:[A-Za-z0-9_-]{35}"),
            bot_token_3 in proptest::option::of("[0-9]{6}:[A-Za-z0-9_-]{35}"),
            password in "[a-zA-Z0-9!@#$%^&*]{8,32}",
        ) {
            // Cheap KDF params: this property test only exercises the
            // encrypt/decrypt roundtrip — default params (64 MB × 3 iters ×
            // 256 cases) take minutes to run.
            let kdf = KdfParams {
                memory: 8_192,
                iterations: 1,
                parallelism: 1,
                ..KdfParams::new()
            };
            let bot_tokens = vec![
                bot_token_1,
                bot_token_2.unwrap_or_default(),
                bot_token_3.unwrap_or_default(),
            ].into_iter().filter(|t| !t.is_empty()).collect();

            let sensitive = SensitiveData { api_id, api_hash, bot_tokens };
            let encrypted = encrypt_sensitive(&sensitive, &password, &kdf).unwrap();
            let decrypted = decrypt_sensitive(&encrypted, &password, &kdf).unwrap();

            prop_assert_eq!(decrypted.api_id, sensitive.api_id);
            prop_assert_eq!(decrypted.api_hash, sensitive.api_hash);
            prop_assert_eq!(decrypted.bot_tokens, sensitive.bot_tokens);
        }
    }
}

pub mod appdata;
pub use appdata::{ConnectionStore, delete_connection, load_connection, save_connection};
