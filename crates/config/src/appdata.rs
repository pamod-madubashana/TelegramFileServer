use crate::{
    EncryptedPayload, KdfParams, SensitiveData, SetupConfig, decrypt_value, encrypt_value,
    open_container_payload, seal_container_payload,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Connection information persisted locally to resume setup wizard
/// (in-memory type — also embedded in resume API responses).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStore {
    pub mongo_uri: String,
    pub password: String,
}

/// Binary-dir storage: the MongoDB URI encrypted under the wizard password
/// (cheap local KDF). One half of the `config.tfs` bundle — the wizard
/// password itself lives in appdata `data.tfs`, sealed under this binary's
/// container key (it cannot encrypt itself).
#[derive(Debug, Serialize, Deserialize)]
struct MongoStore {
    kdf: KdfParams,
    encrypted_uri: EncryptedPayload,
}

/// What the `config.tfs` setup section holds after a cheap local decrypt:
/// everything the server needs to come up (and the wizard needs to show the
/// final step) without touching MongoDB.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalConfig {
    pub owner_id: i64,
    pub default_chat_id: i64,
    pub created_at: DateTime<Utc>,
    pub sensitive: SensitiveData,
}

/// `config.tfs` setup section: `LocalConfig` re-encrypted under the cheap
/// local KDF so a resume answers in milliseconds instead of paying the
/// strong 64 MB Argon2 multiple times.
#[derive(Debug, Serialize, Deserialize)]
struct LocalConfigStore {
    kdf: KdfParams,
    encrypted_config: EncryptedPayload,
}

/// Everything the binary dir persists, in one opaque `config.tfs` file.
/// The sections are independent: the wizard writes them at different times
/// and deletes either one without disturbing the other.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigBundle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    connection: Option<MongoStore>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    setup: Option<LocalConfigStore>,
}

/// Get the data directory for storing data.tfs (user dir).
/// Uses TFS_DATA_DIR env var if set, otherwise uses platform-specific data dir
fn get_data_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("TFS_DATA_DIR") {
        return PathBuf::from(env_dir);
    }

    // Windows: %APPDATA%\TelegramFileServer (Roaming)
    // Linux: ~/.local/share/TelegramFileServer
    // macOS: ~/Library/Application Support/TelegramFileServer
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("TelegramFileServer")
}

/// On-disk cache of Telegram message thumbnails.
///
/// A thumbnail never changes once its message exists, so nothing here ever
/// expires: a miss is fetched from Telegram once and then served from disk
/// for the life of the installation. Lives next to `data.tfs` because it is
/// regenerable state, not configuration.
pub fn get_thumbnail_dir() -> PathBuf {
    get_data_dir().join("thumbnails")
}

/// Get the directory of the running binary — config.tfs lives here so the
/// whole config travels with the binary. TFS_BIN_DIR overrides
/// (used by tests).
pub fn get_bin_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("TFS_BIN_DIR") {
        return PathBuf::from(env_dir);
    }

    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// appdata/data.tfs — the wizard password (user dir). The root secret: it
/// cannot encrypt itself with its own password, so its payload is the raw
/// password bytes — sealed under the binary's container key instead.
fn password_file_path() -> PathBuf {
    get_data_dir().join("data.tfs")
}

/// binary-dir/config.tfs — the whole binary-dir config bundle (encrypted
/// MongoDB URI + encrypted setup-config mirror), next to the binary.
fn config_file_path() -> PathBuf {
    get_bin_dir().join("config.tfs")
}

/// Opaque container framing shared by `data.tfs` and `config.tfs`:
/// `magic | version | reserved | payload_len (u32 LE) | payload`.
///
/// v2 seals `payload` as `nonce || ciphertext` under this binary's key, so a
/// text editor shows random bytes and only this build can open the file. v1
/// carried the payload in the clear and is still readable, but any v1 file is
/// rewritten sealed the first time this build touches it.
const CONTAINER_MAGIC: &[u8; 4] = b"TFSC";
const CONTAINER_VERSION: u8 = 2;
const CONTAINER_VERSION_LEGACY: u8 = 1;
const CONTAINER_HEADER_LEN: usize = 12;

/// Read a container file. `Ok(None)` when the file is missing, truncated,
/// tampered with, or not a container this build understands — callers treat
/// that as "not saved" so the wizard restarts instead of failing hard.
///
/// A legacy (v1) file is re-sealed in place as a side effect, so a plaintext
/// `.tfs` stops being readable the first time this build reads it.
fn read_container(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(path)?;
    if raw.len() < CONTAINER_HEADER_LEN {
        eprintln!("tfs storage: {} is truncated, ignoring", path.display());
        return Ok(None);
    }
    if &raw[0..4] != CONTAINER_MAGIC {
        eprintln!(
            "tfs storage: {} has an unrecognized format, ignoring",
            path.display()
        );
        return Ok(None);
    }
    let version = raw[4];
    if version != CONTAINER_VERSION && version != CONTAINER_VERSION_LEGACY {
        eprintln!(
            "tfs storage: {} has an unrecognized format, ignoring",
            path.display()
        );
        return Ok(None);
    }
    let len = u32::from_le_bytes(raw[8..12].try_into().expect("slice is 4 bytes")) as usize;
    if raw.len() < CONTAINER_HEADER_LEN + len {
        eprintln!(
            "tfs storage: {} payload is truncated, ignoring",
            path.display()
        );
        return Ok(None);
    }
    let payload = &raw[CONTAINER_HEADER_LEN..CONTAINER_HEADER_LEN + len];

    if version == CONTAINER_VERSION_LEGACY {
        let payload = payload.to_vec();
        if let Err(e) = write_container(path, &payload) {
            eprintln!("tfs storage: could not re-seal {}: {e}", path.display());
        }
        return Ok(Some(payload));
    }

    match open_container_payload(payload) {
        Ok(plaintext) => Ok(Some(plaintext)),
        Err(e) => {
            eprintln!(
                "tfs storage: {} could not be opened ({e}); ignoring",
                path.display()
            );
            Ok(None)
        }
    }
}

/// Write a container file atomically: seal the payload, build the framed
/// buffer, write it to a sibling temp file (mode 0600 on Unix), then rename
/// over the target so readers never observe a half-written file. `rename`
/// replaces the target on both POSIX and Windows.
fn write_container(path: &Path, payload: &[u8]) -> anyhow::Result<()> {
    let sealed = seal_container_payload(payload)?;
    let payload_len = u32::try_from(sealed.len())
        .map_err(|_| anyhow::anyhow!("container payload exceeds 4 GiB"))?;
    let mut buf = Vec::with_capacity(CONTAINER_HEADER_LEN + sealed.len());
    buf.extend_from_slice(CONTAINER_MAGIC);
    buf.push(CONTAINER_VERSION);
    buf.extend_from_slice(&[0u8; 3]);
    buf.extend_from_slice(&payload_len.to_le_bytes());
    buf.extend_from_slice(&sealed);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);

    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    {
        let mut file = opts.open(&tmp)?;
        file.write_all(&buf)?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // OpenOptions::mode only applies on creation; a leftover tmp file
        // from a crashed run could carry looser permissions.
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Read the config bundle; missing or corrupt file reads as empty (the
/// wizard restarts from step 1 rather than hard-failing).
fn load_bundle() -> anyhow::Result<ConfigBundle> {
    let Some(payload) = read_container(&config_file_path())? else {
        return Ok(ConfigBundle::default());
    };
    Ok(serde_json::from_slice(&payload).unwrap_or_else(|e| {
        eprintln!(
            "tfs storage: {} is corrupt ({e}); treating as empty",
            config_file_path().display()
        );
        ConfigBundle::default()
    }))
}

/// Persist the config bundle; an empty bundle removes the file entirely.
fn save_bundle(bundle: &ConfigBundle) -> anyhow::Result<()> {
    if bundle.connection.is_none() && bundle.setup.is_none() {
        return remove_file_if_exists(&config_file_path());
    }
    write_container(&config_file_path(), &serde_json::to_vec(bundle)?)
}

fn remove_file_if_exists(path: &Path) -> anyhow::Result<()> {
    // Windows reports a missing *parent* directory as os error 3 (path not
    // found) rather than NotFound — short-circuit before touching the FS.
    if !path.exists() {
        return Ok(());
    }

    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Connection from the environment, for hosts with an ephemeral filesystem
/// (Heroku-style containers) where `config.tfs`/`data.tfs` are wiped on every
/// restart. Both vars must be set — the values are exactly what the wizard's
/// step 1 persists: `TFS_MONGO_URI` (the URI) and `TFS_WIZARD_PASSWORD` (the
/// password that decrypts the setup config in MongoDB).
fn connection_from_env() -> Option<ConnectionStore> {
    let mongo_uri = std::env::var("TFS_MONGO_URI").ok()?;
    let password = std::env::var("TFS_WIZARD_PASSWORD").ok()?;
    if mongo_uri.trim().is_empty() || password.is_empty() {
        return None;
    }
    Some(ConnectionStore {
        mongo_uri,
        password,
    })
}

/// Load the connection: the wizard password from appdata `data.tfs`, the
/// encrypted MongoDB URI from the binary-dir `config.tfs` bundle.
/// Returns `Ok(None)` if either file is missing/corrupt, or if the stored
/// URI no longer decrypts (password changed — the wizard restarts at step 1).
///
/// The environment pair above takes precedence over disk: on an ephemeral
/// host the files may be absent or stale at any moment, so an explicit
/// operator-provided connection is always the authoritative one.
pub fn load_connection() -> anyhow::Result<Option<ConnectionStore>> {
    if let Some(store) = connection_from_env() {
        return Ok(Some(store));
    }

    let Some(password_bytes) = read_container(&password_file_path())? else {
        return Ok(None);
    };
    let Ok(password) = String::from_utf8(password_bytes) else {
        return Ok(None);
    };

    let bundle = load_bundle()?;
    let Some(stored) = bundle.connection else {
        return Ok(None);
    };
    let Some(mongo_uri) =
        decrypt_value::<String>(&stored.encrypted_uri, &password, &stored.kdf).ok()
    else {
        return Ok(None);
    };
    Ok(Some(ConnectionStore {
        mongo_uri,
        password,
    }))
}

/// Save the connection: password → appdata `data.tfs` (sealed under the
/// binary's container key — the root secret), MongoDB URI → `config.tfs`
/// additionally encrypted with that password (cheap local KDF).
/// Creates parent directories as needed.
pub fn save_connection(store: &ConnectionStore) -> anyhow::Result<()> {
    let kdf = KdfParams::local();
    let encrypted_uri = encrypt_value(&store.mongo_uri, &store.password, &kdf)?;

    write_container(&password_file_path(), store.password.as_bytes())?;
    let mut bundle = load_bundle()?;
    bundle.connection = Some(MongoStore { kdf, encrypted_uri });
    save_bundle(&bundle)?;
    Ok(())
}

/// Delete the connection (root secret + the bundle's connection section).
/// The setup section, if any, survives.
/// Idempotent: returns Ok(()) if nothing exists
pub fn delete_connection() -> anyhow::Result<()> {
    remove_file_if_exists(&password_file_path())?;
    let mut bundle = load_bundle()?;
    if bundle.connection.take().is_some() {
        save_bundle(&bundle)?;
    }
    Ok(())
}

/// Load the local mirror of the setup config from the `config.tfs` bundle,
/// opened with the wizard password in ~10 ms (cheap local KDF — no PHC
/// verify: the AEAD tag authenticates the password).
/// Returns Ok(None) if the section doesn't exist or the password doesn't
/// open it.
pub fn load_local_config(password: &str) -> anyhow::Result<Option<LocalConfig>> {
    let bundle = load_bundle()?;
    let Some(stored) = bundle.setup else {
        return Ok(None);
    };
    Ok(decrypt_value::<LocalConfig>(&stored.encrypted_config, password, &stored.kdf).ok())
}

fn local_from(config: &SetupConfig, sensitive: SensitiveData) -> LocalConfig {
    LocalConfig {
        owner_id: config.owner_id,
        default_chat_id: config.default_chat_id,
        created_at: config.created_at,
        sensitive,
    }
}

/// Save a local mirror of the setup config into the `config.tfs` bundle,
/// re-encrypted under the cheap local KDF so resumes stay fast. `sensitive`
/// must already be decrypted by the caller (every call site has it in hand
/// from its own verify step).
pub fn save_local_config(
    config: &SetupConfig,
    sensitive: &SensitiveData,
    password: &str,
) -> anyhow::Result<()> {
    let kdf = KdfParams::local();
    let local = local_from(config, sensitive.clone());
    let encrypted_config = encrypt_value(&local, password, &kdf)?;

    let mut bundle = load_bundle()?;
    bundle.setup = Some(LocalConfigStore {
        kdf,
        encrypted_config,
    });
    save_bundle(&bundle)?;
    Ok(())
}

/// Delete the local config mirror (the bundle's setup section; the
/// connection section survives).
/// Idempotent: returns Ok(()) if nothing exists
pub fn delete_local_config() -> anyhow::Result<()> {
    let mut bundle = load_bundle()?;
    if bundle.setup.take().is_some() {
        save_bundle(&bundle)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;
    use tempfile::tempdir;

    /// TFS_DATA_DIR/TFS_BIN_DIR are process-wide; serialize tests so
    /// parallel runs don't clobber each other's env vars (same pattern as
    /// the tfs-api test lock).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Point appdata and binary-dir storage at isolated temp folders, and
    /// scrub the connection env vars so a shell that has them exported
    /// cannot leak a connection into every test.
    fn set_test_dirs(base: &std::path::Path) -> (PathBuf, PathBuf) {
        let data = base.join("appdata");
        let bin = base.join("bindir");
        unsafe {
            env::set_var("TFS_DATA_DIR", &data);
            env::set_var("TFS_BIN_DIR", &bin);
            env::remove_var("TFS_MONGO_URI");
            env::remove_var("TFS_WIZARD_PASSWORD");
        }
        (data, bin)
    }

    fn clear_test_dirs() {
        unsafe {
            env::remove_var("TFS_DATA_DIR");
            env::remove_var("TFS_BIN_DIR");
            env::remove_var("TFS_MONGO_URI");
            env::remove_var("TFS_WIZARD_PASSWORD");
        }
    }

    fn test_store() -> ConnectionStore {
        ConnectionStore {
            mongo_uri: "mongodb://localhost:27017".to_string(),
            password: "password123".to_string(),
        }
    }

    fn test_config() -> SetupConfig {
        use crate::{Step1Input, Step2Input, create_setup_config};

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
        create_setup_config(&step1, &step2).unwrap()
    }

    fn test_sensitive() -> SensitiveData {
        SensitiveData {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_tokens: vec!["123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string()],
        }
    }

    #[test]
    fn test_save_load_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        let (data, bin) = set_test_dirs(temp_dir.path());

        let store = test_store();
        save_connection(&store).unwrap();

        let loaded = load_connection().unwrap().unwrap();
        assert_eq!(loaded.mongo_uri, store.mongo_uri);
        assert_eq!(loaded.password, store.password);

        // Layout: opaque .tfs containers — root secret in appdata,
        // encrypted bundle next to the binary; nothing else on disk.
        assert!(password_file_path().exists());
        assert!(config_file_path().exists());
        assert_no_json_files(&data);
        assert_no_json_files(&bin);

        // Container framing in front of both payloads.
        let raw_password = fs::read(password_file_path()).unwrap();
        assert_eq!(&raw_password[0..4], CONTAINER_MAGIC);

        // The root secret reads back out of the sealed container.
        let payload = read_container(&password_file_path()).unwrap().unwrap();
        assert_eq!(payload, store.password.as_bytes());

        // The URI must never sit on disk in plaintext.
        let raw_bundle = fs::read(config_file_path()).unwrap();
        assert!(!String::from_utf8_lossy(&raw_bundle).contains("mongodb://"));

        clear_test_dirs();
    }

    #[test]
    fn test_delete_connection() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        let store = test_store();
        save_connection(&store).unwrap();
        assert!(load_connection().unwrap().is_some());

        delete_connection().unwrap();
        assert!(load_connection().unwrap().is_none());
        assert!(!password_file_path().exists());
        // No setup section either → the bundle file goes away entirely.
        assert!(!config_file_path().exists());

        // Idempotent on a missing file.
        delete_connection().unwrap();

        clear_test_dirs();
    }

    /// The env connection needs both halves: a lone TFS_MONGO_URI reads as
    /// not-set so a stray URI in the shell cannot half-configure a machine.
    #[test]
    fn test_env_connection_requires_both_vars() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        assert!(load_connection().unwrap().is_none());
        unsafe {
            env::set_var("TFS_MONGO_URI", "mongodb://localhost:27017");
        }
        // Password var missing → disk path, which is empty here.
        assert!(load_connection().unwrap().is_none());
        unsafe {
            env::remove_var("TFS_MONGO_URI");
        }
    }

    /// Both vars set → the env connection wins over whatever is on disk,
    /// which is what keeps an ephemeral-filesystem host configured.
    #[test]
    fn test_env_connection_overrides_disk() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        save_connection(&test_store()).unwrap();

        unsafe {
            env::set_var("TFS_MONGO_URI", "mongodb://env-host:27017");
            env::set_var("TFS_WIZARD_PASSWORD", "env-password");
        }
        let loaded = load_connection().unwrap().unwrap();
        assert_eq!(loaded.mongo_uri, "mongodb://env-host:27017");
        assert_eq!(loaded.password, "env-password");
        unsafe {
            env::remove_var("TFS_MONGO_URI");
            env::remove_var("TFS_WIZARD_PASSWORD");
        }

        clear_test_dirs();
    }

    #[test]
    fn test_load_none_when_missing() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        let result = load_connection().unwrap();
        assert!(result.is_none());

        clear_test_dirs();
    }

    #[test]
    fn test_save_creates_parent_dirs() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        let data = temp_dir.path().join("subdir-data");
        let bin = temp_dir.path().join("subdir-bin");
        unsafe {
            env::set_var("TFS_DATA_DIR", &data);
            env::set_var("TFS_BIN_DIR", &bin);
        }

        let store = test_store();
        save_connection(&store).unwrap();

        let loaded = load_connection().unwrap().unwrap();
        assert_eq!(loaded.mongo_uri, store.mongo_uri);
        assert!(data.join("data.tfs").exists());
        assert!(bin.join("config.tfs").exists());

        clear_test_dirs();
    }

    #[test]
    fn test_load_none_when_password_cannot_decrypt_uri() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        save_connection(&test_store()).unwrap();

        // Replace the root secret — the encrypted URI can no longer be
        // opened, so the connection reads back as "not saved" and the
        // wizard restarts from step 1.
        write_container(&password_file_path(), b"different-password").unwrap();

        assert!(load_connection().unwrap().is_none());

        clear_test_dirs();
    }

    #[test]
    fn test_corrupt_container_reads_as_missing() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        save_connection(&test_store()).unwrap();
        save_local_config(&test_config(), &test_sensitive(), "password123").unwrap();

        // Corrupt root secret → no panic, reads as "not saved".
        fs::write(password_file_path(), b"garbage").unwrap();
        assert!(load_connection().unwrap().is_none());

        // Restore the secret, corrupt the bundle → same graceful behavior
        // for both readers of config.tfs.
        write_container(&password_file_path(), b"password123").unwrap();
        fs::write(config_file_path(), b"garbage").unwrap();
        assert!(load_connection().unwrap().is_none());
        assert!(load_local_config("password123").unwrap().is_none());

        clear_test_dirs();
    }

    #[test]
    fn test_local_config_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        assert!(load_local_config("password123").unwrap().is_none());

        let config = test_config();
        // Real call sites pass the sensitive data their own verify step just
        // decrypted — mirror it the same way.
        let sensitive = crate::verify_and_decrypt(&config, "password123").unwrap();
        save_local_config(&config, &sensitive, "password123").unwrap();

        let loaded = load_local_config("password123").unwrap().unwrap();
        assert_eq!(loaded.owner_id, config.owner_id);
        assert_eq!(loaded.default_chat_id, config.default_chat_id);
        assert_eq!(loaded.sensitive.api_id, sensitive.api_id);
        assert_eq!(loaded.sensitive.api_hash, sensitive.api_hash);
        assert_eq!(loaded.sensitive.bot_tokens, sensitive.bot_tokens);

        // Opaque bundle on disk: section present, api_hash never in
        // plaintext.
        let raw = fs::read(config_file_path()).unwrap();
        let lossy = String::from_utf8_lossy(&raw);
        // Fully opaque: no section names, no field names, no JSON structure —
        // a text editor sees random bytes and nothing else.
        assert!(!lossy.contains("encrypted_config"));
        assert!(!lossy.contains("connection"));
        assert!(!lossy.contains("api_hash"));
        // And the secret itself is gone from the file.
        assert!(!lossy.contains("abcdef1234567890"));
        // Mirror lives next to the binary, not in appdata.
        assert!(config_file_path().exists());
        assert_no_json_files(&get_data_dir());

        // Wrong password must not open it.
        assert!(load_local_config("wrong-password").unwrap().is_none());

        clear_test_dirs();
    }

    #[test]
    fn test_bundle_sections_are_independent() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        save_connection(&test_store()).unwrap();
        save_local_config(&test_config(), &test_sensitive(), "password123").unwrap();

        // Deleting one section leaves the other intact.
        delete_connection().unwrap();
        assert!(load_connection().unwrap().is_none());
        assert!(load_local_config("password123").unwrap().is_some());

        delete_local_config().unwrap();
        assert!(load_local_config("password123").unwrap().is_none());
        assert!(!config_file_path().exists());

        clear_test_dirs();
    }

    #[test]
    fn test_delete_local_config() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        save_local_config(&test_config(), &test_sensitive(), "password123").unwrap();
        assert!(load_local_config("password123").unwrap().is_some());

        delete_local_config().unwrap();
        assert!(load_local_config("password123").unwrap().is_none());

        // Idempotent on a missing file.
        delete_local_config().unwrap();

        clear_test_dirs();
    }

    /// A v1 container (plaintext payload, as older builds wrote it) is read
    /// correctly and rewritten sealed, so the file stops being readable by a
    /// text editor the first time this build touches it.
    #[test]
    fn test_legacy_container_is_resealed_on_read() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let temp_dir = tempdir().unwrap();
        set_test_dirs(temp_dir.path());

        let payload = b"secret-password";
        let mut buf = Vec::new();
        buf.extend_from_slice(CONTAINER_MAGIC);
        buf.push(CONTAINER_VERSION_LEGACY);
        buf.extend_from_slice(&[0u8; 3]);
        buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        buf.extend_from_slice(payload);
        if let Some(parent) = password_file_path().parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(password_file_path(), &buf).unwrap();

        // Reading hands back the plaintext ...
        let read = read_container(&password_file_path()).unwrap().unwrap();
        assert_eq!(read, payload);

        // ... and the file on disk is now sealed.
        let raw = fs::read(password_file_path()).unwrap();
        assert_eq!(raw[4], CONTAINER_VERSION);
        assert!(!String::from_utf8_lossy(&raw).contains("secret-password"));

        // Still opens on subsequent reads.
        let again = read_container(&password_file_path()).unwrap().unwrap();
        assert_eq!(again, payload);

        clear_test_dirs();
    }

    /// The store is `.tfs`-only: no JSON files may exist in either dir.
    fn assert_no_json_files(dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            assert_ne!(
                entry.path().extension().and_then(|e| e.to_str()),
                Some("json"),
                "unexpected JSON file in {}",
                dir.display()
            );
        }
    }
}
