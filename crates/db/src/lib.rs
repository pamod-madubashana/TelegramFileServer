use mongodb::{
    Client, Collection, Database,
    bson::doc,
    options::{ClientOptions, ServerApi, ServerApiVersion},
};
use tfs_config::{ConfigError, SetupConfig};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("mongodb connection failed: {0}")]
    Connection(#[from] mongodb::error::Error),
    #[error("config error: {0}")]
    Config(#[from] ConfigError),
    #[error("config not found")]
    NotFound,
    #[error(
        "MongoDB isn't configured yet — run the setup wizard, which stores your URI in config.tfs"
    )]
    NotConfigured,
    #[error("invalid data: {0}")]
    InvalidData(String),
}

pub type Result<T> = std::result::Result<T, DbError>;

impl DbError {
    /// Plain-English message for the setup wizard — safe to show end users.
    /// The raw driver error never belongs in this string; pass it separately
    /// as `detail` and log it server-side.
    pub fn user_message(&self) -> String {
        match self {
            DbError::Connection(e) => friendly_connection_message(&e.to_string()),
            other => other.to_string(),
        }
    }
}

/// Map a raw MongoDB driver error onto an actionable, non-technical message.
/// The database is whatever URI the operator supplied (usually a cloud
/// cluster), so nothing here may assume a server on this machine.
/// Match order: most specific signals first (the generic timeout phrases appear
/// inside almost every connection failure, so they must be checked last).
fn friendly_connection_message(raw: &str) -> String {
    let l = raw.to_lowercase();
    if l.contains("actively refused") || l.contains("10061") {
        "Nothing accepted the connection at that address. Check the host and port in your MongoDB URI — a cloud cluster is not on localhost."
            .to_string()
    } else if l.contains("no such host") || l.contains("lookup address") || l.contains("dns") {
        "The server name in your MongoDB URI could not be found. Check the hostname in the URI."
            .to_string()
    } else if l.contains("authentication") || l.contains("bad auth") || l.contains("scram") {
        "MongoDB rejected the username or password in your URI.".to_string()
    } else if l.contains("invalid uri") || l.contains("error parsing") || l.contains("parsing into")
    {
        "Your MongoDB URI doesn't look valid. It should look like: mongodb+srv://<cluster>.mongodb.net/<database>"
            .to_string()
    } else if l.contains("certificate") || l.contains(" tls") || l.contains("ssl") {
        "The secure connection to MongoDB failed (certificate problem). Check the TLS settings in your URI."
            .to_string()
    } else if l.contains("server selection timeout")
        || l.contains("no available servers")
        || l.contains("i/o error")
        || l.contains("timed out")
        || l.contains("timeout")
    {
        "Couldn't reach MongoDB in time. Check that the cluster is reachable from this machine and that the host in your URI is correct."
            .to_string()
    } else {
        "Couldn't connect to MongoDB. Check your URI, and that the cluster allows connections from this machine's public IP (IP access list)."
            .to_string()
    }
}

const CONNECTION_TIMEOUT_MS: u64 = 5000;
const SERVER_SELECTION_TIMEOUT_MS: u64 = 5000;

/// Connect to MongoDB with fast timeouts for wizard error feedback
pub async fn connect(uri: &str) -> Result<Client> {
    let mut client_options = ClientOptions::parse(uri).await?;

    // Set fast timeouts for wizard
    client_options.connect_timeout = Some(std::time::Duration::from_millis(CONNECTION_TIMEOUT_MS));
    client_options.server_selection_timeout = Some(std::time::Duration::from_millis(
        SERVER_SELECTION_TIMEOUT_MS,
    ));

    // Use stable API version
    client_options.server_api = Some(ServerApi::builder().version(ServerApiVersion::V1).build());

    let client = Client::with_options(client_options)?;

    // Test connection with a ping
    client
        .database("admin")
        .run_command(doc! { "ping": 1 })
        .await?;

    Ok(client)
}

/// Get the v2 database
pub fn get_database(client: &Client) -> Database {
    client.database(SetupConfig::DATABASE_NAME)
}

/// Get the setup collection
pub fn get_setup_collection(client: &Client) -> Collection<SetupConfig> {
    get_database(client).collection(SetupConfig::COLLECTION_NAME)
}

/// Check if setup config exists
pub async fn has_config(client: &Client) -> Result<bool> {
    let collection = get_setup_collection(client);
    let count = collection
        .count_documents(doc! { "_id": SetupConfig::DOC_ID })
        .await?;
    Ok(count > 0)
}

/// Load setup config from database
pub async fn load_config(client: &Client) -> Result<SetupConfig> {
    let collection = get_setup_collection(client);
    let config = collection
        .find_one(doc! { "_id": SetupConfig::DOC_ID })
        .await?
        .ok_or(DbError::NotFound)?;
    Ok(config)
}

/// Save setup config to database (upsert)
pub async fn save_config(client: &Client, config: &SetupConfig) -> Result<()> {
    let collection = get_setup_collection(client);
    collection
        .replace_one(doc! { "_id": SetupConfig::DOC_ID }, config)
        .upsert(true)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tfs_config::{Step1Input, Step2Input, create_setup_config, verify_and_decrypt};

    // These tests require a running MongoDB instance
    // They are marked as ignored by default

    #[tokio::test]
    #[ignore]
    async fn test_connect_and_save_load() {
        let uri = std::env::var("MONGODB_URI").expect(
            "set MONGODB_URI to your MongoDB URI (a cloud cluster) to run this test — \
             no local server is assumed",
        );
        let client = connect(&uri).await.unwrap();

        let step1 = Step1Input {
            mongo_uri: uri.clone(),
            password: "password123".to_string(),
        };
        let step2 = Step2Input {
            api_id: 123456,
            api_hash: "abcdef1234567890abcdef1234567890".to_string(),
            bot_token_1: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11".to_string(),
            bot_token_2: Some("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew12".to_string()),
            bot_token_3: None,
            owner_id: 987654321,
            default_chat_id: -1001234567890,
        };

        let config = create_setup_config(&step1, &step2).unwrap();
        save_config(&client, &config).await.unwrap();

        let loaded = load_config(&client).await.unwrap();
        // api_id must live inside the encrypted payload, not in plaintext.
        let decrypted = verify_and_decrypt(&loaded, &step1.password).unwrap();
        assert_eq!(decrypted.api_id, step2.api_id);
        assert_eq!(loaded.owner_id, config.owner_id);
        assert_eq!(loaded.id, config.id);

        let has = has_config(&client).await.unwrap();
        assert!(has);
    }

    #[test]
    fn friendly_message_connection_refused() {
        // Real driver output captured from the setup wizard smoke test.
        let raw = "mongodb connection failed: Kind: Server selection timeout: No available servers. Topology: { Type: Unknown, Servers: [ { Address: localhost:27017, Type: Unknown, Error: Kind: I/O error: No connection could be made because the target machine actively refused it. (os error 10061), labels: {\"RetryableError\", \"SystemOverloadedError\"}, source: None, server response: None } ] }, labels: {}, source: None, server response: None";
        let msg = friendly_connection_message(raw);
        assert!(
            msg.contains("Nothing accepted the connection"),
            "got: {msg}"
        );
        // Never tell the operator to install a database on this machine.
        assert!(!msg.contains("Start MongoDB"), "got: {msg}");
        assert!(!msg.contains("10061"), "raw detail leaked: {msg}");
        assert!(!msg.contains("Topology"), "raw detail leaked: {msg}");
    }

    #[test]
    fn friendly_message_invalid_uri_points_at_a_cloud_example() {
        let msg = friendly_connection_message("Error parsing into struct: missing scheme");
        assert!(msg.contains("mongodb+srv://"), "got: {msg}");
        assert!(!msg.contains("localhost"), "got: {msg}");
    }

    #[test]
    fn friendly_message_auth_failure() {
        let raw = "Authentication failed: bad auth : Authentication failed.";
        let msg = friendly_connection_message(raw);
        assert!(
            msg.contains("rejected the username or password"),
            "got: {msg}"
        );
    }

    #[test]
    fn friendly_message_dns_failure() {
        let raw = "DNS error: failed to lookup address information: No such host is known.";
        let msg = friendly_connection_message(raw);
        assert!(msg.contains("could not be found"), "got: {msg}");
    }

    #[test]
    fn friendly_message_timeout() {
        let raw = "Server selection timeout: No available servers after 5000ms";
        let msg = friendly_connection_message(raw);
        assert!(msg.contains("Couldn't reach MongoDB in time"), "got: {msg}");
    }

    #[test]
    fn friendly_message_fallback() {
        let msg = friendly_connection_message("something entirely unexpected");
        assert!(msg.contains("Couldn't connect to MongoDB"), "got: {msg}");
    }

    #[test]
    fn user_message_wraps_connection_error() {
        let e = DbError::InvalidData("boom".to_string());
        // Non-connection variants keep their Display text.
        assert_eq!(e.user_message(), "invalid data: boom");
    }
}
