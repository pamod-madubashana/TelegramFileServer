// Link as a no-console app so `tfs --headless` starts with no window at all:
// Windows creates a console window during process creation, before any of our
// code can hide it. Default mode asks for a console back in `cli::ensure_console`.
#![windows_subsystem = "windows"]

use axum::{
    Router,
    response::{IntoResponse, Json},
    routing::get,
};
use std::net::SocketAddr;
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use tfs_api::router as api_router;

mod cli;
mod logging;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Only a bare `--headless` is a background serve, and it is the one path
    // that must never ask for a console. Everything else (default, --stop,
    // --help, a typo) needs somewhere to write, so get a console first —
    // before parse() has anything to print.
    let background = args.len() == 1 && args[0] == cli::HEADLESS_FLAG;
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
        cli::Command::Serve { headless } => headless,
    };

    let mongo_uri =
        std::env::var("MONGO_URI").unwrap_or_else(|_| "mongodb://localhost:27017".to_string());
    let port = configured_port();

    init_tracing(headless)?;

    let static_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    let webui_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static/webui");
    let webui_index = format!("{}/index.html", webui_dir);

    // Serve /webui/ with SPA fallback: unknown paths → index.html (history routing).
    // - Existing files (assets/*, index.html) served normally
    // - Unknown subpaths (/webui/explorer, /webui/settings/...) → index.html
    // - If index.html missing → 404 (ServeFile returns 404 on absent file)
    // - /webui (no trailing slash) → redirect to /webui/ via append_index_html_on_directories
    let webui_service = ServeDir::new(webui_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(webui_index));

    // Main static files (icon.png, etc.) with fallback to setup.html for the wizard.
    let serve_dir = ServeDir::new(static_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(format!("{}/setup.html", static_dir)));

    // tfs_api::router already registers absolute paths (/api/setup/*),
    // so merge it directly — do not nest it under another /api prefix.
    let app = Router::new()
        .route("/healthz", get(healthz))
        .merge(api_router(mongo_uri))
        .nest_service("/webui", webui_service)
        .fallback_service(serve_dir);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
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

fn configured_port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8090)
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
