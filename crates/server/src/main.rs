// Link as a no-console app so a bare `tfs` starts with no window at all:
// Windows creates a console window during process creation, before any of our
// code can hide it. `tfs --showlogs` asks for a console back in
// `cli::ensure_console`.
#![windows_subsystem = "windows"]

use axum::{
    Router,
    extract::{Path, Request},
    middleware::{self, Next},
    response::{IntoResponse, Json, Redirect},
    routing::get,
};
use mongodb::bson::Document;
use std::{net::SocketAddr, path::PathBuf};
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use tfs_api::router as api_router;

mod cli;
mod logging;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // A bare invocation (or only the redundant --headless flag) is the
    // default headless serve, and it must never ask for a console.
    // Everything else (--showlogs, --stop, --wipe-users, --help, a typo)
    // needs somewhere to write, so get a console first — before parse()
    // has anything to print.
    let background = args.iter().all(|a| a == cli::HEADLESS_FLAG);
    if background {
        cli::point_stdio_at(&logging::log_path())?;
    } else {
        cli::ensure_console();
    }

    let command = cli::parse(args)?;

    let headless = match command {
        cli::Command::Stop => {
            cli::stop(configured_port())?;
            return Ok(());
        }
        cli::Command::WipeUsers => {
            wipe_users().await?;
            return Ok(());
        }
        cli::Command::Serve { headless } => headless,
    };

    // The MongoDB URI lives in config.tfs, written by the setup wizard —
    // no environment variable and no local-server default. Requests resolve
    // it through tfs_config::load_connection, so a wizard finished while
    // this process is already serving works without a restart.
    let port = configured_port();

    init_tracing(headless)?;

    let static_dir = bundled_static_dir()?;
    let webui_dir = static_dir.join("webui");

    // The whole UI — setup wizard included — is the SPA at the origin root:
    // /setup, /login, /explorer, /settings/… Lookup order for everything the
    // API did not claim: static files (icon.png) → webui files (assets) →
    // the SPA index itself (history routing for unknown paths).
    let serve_dir = ServeDir::new(&static_dir)
        .append_index_html_on_directories(true)
        .fallback(
            ServeDir::new(&webui_dir)
                .append_index_html_on_directories(true)
                .fallback(ServeFile::new(webui_dir.join("index.html"))),
        );

    // tfs_api::router already registers absolute paths (/api/setup/*),
    // so merge it directly — do not nest it under another /api prefix.
    // Old /webui/… URLs (bookmarks, pages cached from earlier builds) get a
    // redirect to their new home at the origin root.
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/webui", get(redirect_from_legacy_webui_root))
        .route("/webui/*rest", get(redirect_from_legacy_webui))
        .route("/setup.html", get(redirect_from_legacy_setup_html))
        .merge(api_router(String::new()))
        .fallback_service(serve_dir)
        .layer(middleware::from_fn(log_requests));

    let addr = configured_addr(port)?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("Server listening on http://{}", addr);

    // Record the pid only once the port is actually held, so a failed bind
    // never leaves a pid file pointing at a process that never served.
    if headless {
        cli::write_pid(port)?;
        tracing::info!(
            "Headless: no window, log at {}",
            logging::log_path().display()
        );
    }

    let serve_result = axum::serve(listener, app).await;
    if headless {
        cli::remove_pid(port);
    }
    serve_result?;

    Ok(())
}

fn bundled_static_dir() -> anyhow::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    if let Some(dir) = executable.parent() {
        let bundled = dir.join("static");
        if bundled.is_dir() {
            return Ok(bundled);
        }
    }

    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("static"))
}

fn configured_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8090)
}

/// Loopback by default: this is a personal server bound to the operator's
/// machine. Container hosts (Heroku & friends) route external traffic to a
/// dyno-private interface, so they set HOST=0.0.0.0 to make the port
/// reachable from outside the process.
fn configured_addr(port: u16) -> anyhow::Result<SocketAddr> {
    let host = std::env::var("HOST")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let ip: std::net::IpAddr = host
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("HOST is not a valid IP address: {host}"))?;
    Ok(SocketAddr::from((ip, port)))
}

/// `tfs --wipe-users --yes` — delete every account in `v2_users`.
///
/// The Mongo URI comes from the same saved connection the server uses
/// (`config.tfs` + appdata `data.tfs`), so the operator never has to spell
/// out credentials. Accounts only: sessions are in-memory and die with the
/// process, files are untouched.
async fn wipe_users() -> anyhow::Result<()> {
    let Some(connection) = tfs_config::appdata::load_connection()? else {
        anyhow::bail!(
            "no saved connection — finish the setup wizard first \
             (config.tfs or data.tfs is missing/unreadable)"
        );
    };

    let client = tfs_db::connect(&connection.mongo_uri).await?;
    let deleted = tfs_db::get_database(&client)
        .collection::<Document>("v2_users")
        .delete_many(mongodb::bson::doc! {})
        .await?;

    println!("removed {} user account(s)", deleted.deleted_count);
    Ok(())
}

/// Console mode logs to stdout exactly as before; headless logs to
/// `tfs.log` beside the binary, because there is no console to read. The
/// file gets no colour codes — an operator `Get-Content`s it raw.
fn init_tracing(headless: bool) -> anyhow::Result<()> {
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());

    if headless {
        tracing_subscriber::registry()
            .with(filter)
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(logging::SharedLog::open()?),
            )
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer())
            .init();
    }
    Ok(())
}

async fn healthz() -> impl IntoResponse {
    let version = env!("CARGO_PKG_VERSION");
    Json(serde_json::json!({ "status": "ok", "version": version }))
}

/// One line per request: method, path, status, duration. Failures (>= 400)
/// at warn, everything else at debug so the normal console stays quiet.
async fn log_requests(req: Request, next: Next) -> impl IntoResponse {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let started = std::time::Instant::now();
    let response = next.run(req).await;
    let status = response.status();
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if status.is_client_error() || status.is_server_error() {
        tracing::warn!(%method, %path, %status, elapsed_ms, "request failed");
    } else {
        tracing::debug!(%method, %path, %status, elapsed_ms, "request");
    }
    response
}

/// The app moved from `/webui/…` to the origin root; keep old links working.
async fn redirect_from_legacy_webui_root() -> Redirect {
    Redirect::temporary("/")
}

async fn redirect_from_legacy_webui(Path(rest): Path<String>) -> Redirect {
    if rest.is_empty() {
        Redirect::temporary("/")
    } else {
        Redirect::temporary(&format!("/{rest}"))
    }
}

/// The setup wizard moved into the SPA at /setup.
async fn redirect_from_legacy_setup_html() -> Redirect {
    Redirect::temporary("/setup")
}
