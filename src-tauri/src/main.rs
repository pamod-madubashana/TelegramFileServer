// Always show console window for debugging - removed conditional compilation
#![windows_subsystem = "console"]

use std::io::Write;
use std::path::Path;

fn main() {
  // Initialize logging with custom format
  env_logger::builder()
    .format(|buf, record| {
      writeln!(buf,
        "{} [{}] - {}",
        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S"),
        record.level(),
        record.args()
      )
    })
    .init();
  
  log::info!("Starting Telegram File Server application");
  log::info!("Current working directory: {:?}", std::env::current_dir());
  
  // Log environment variables that might be relevant
  if let Ok(rust_log) = std::env::var("RUST_LOG") {
    log::info!("RUST_LOG environment variable: {}", rust_log);
  }
  
  // Check for frontend dist directory - try multiple possible locations
  let possible_paths = vec![
    "../Frontend/dist",           // Development path
    "../src/Frontend/dist",      // Alternative development path
    "./frontend-dist",           // Bundled path
    "./dist"                     // Alternative bundled path
  ];
  
  let mut frontend_dist_path = "";
  for path in &possible_paths {
    if Path::new(path).exists() {
      log::info!("Found frontend dist directory: {}", path);
      frontend_dist_path = path;
      break;
    }
  }
  
  if frontend_dist_path.is_empty() {
    log::error!("Frontend dist directory not found in any expected location");
    log::info!("Checked paths: {:?}", possible_paths);
  } else {
    // Check if the frontend index.html exists
    let index_html_path = format!("{}/index.html", frontend_dist_path);
    if Path::new(&index_html_path).exists() {
      log::info!("Frontend index.html exists: {}", index_html_path);
    } else {
      log::error!("Frontend index.html does not exist: {}", index_html_path);
    }
  }
  
  // Generate context and log information about it
  log::info!("Generating Tauri context...");
  let context = tauri::generate_context!();
  log::info!("Context generated successfully");
  log::info!("Package name: {}", context.package_info().name);
  log::info!("Package version: {}", context.package_info().version);
  
  let result = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_http::init())
    .setup(|_app| {
      log::info!("Application setup completed successfully");
      Ok(())
    })
    .run(context);
    
  match result {
    Ok(_) => {
      log::info!("Application exited successfully");
    },
    Err(e) => {
      log::error!("Application exited with error: {}", e);
      log::error!("Error details: {:?}", e);
      std::process::exit(1);
    }
  }
}