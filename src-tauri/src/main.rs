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
    "./dist",                    // Bundled path
    "../src/Frontend/dist",      // Development path
    "./src/Frontend/dist",       // Alternative bundled path
    "../Frontend/dist"          // Alternative development path
  ];
  
  let mut frontend_dist_path = String::new();
  for path in &possible_paths {
    if Path::new(path).exists() {
      log::info!("Found frontend dist directory: {}", path);
      frontend_dist_path = path.to_string();
      break;
    }
  }
  
  if frontend_dist_path.is_empty() {
    log::error!("Frontend dist directory not found in any expected location");
    log::info!("Checked paths: {:?}", possible_paths);
    
    // Try to find the executable directory and look for assets there
    if let Ok(exe_path) = std::env::current_exe() {
      if let Some(parent) = exe_path.parent() {
        let bundled_dist_path = parent.join("dist");
        if bundled_dist_path.exists() {
          log::info!("Found bundled frontend dist directory: {:?}", bundled_dist_path);
          // Convert PathBuf to String to avoid lifetime issues
          if let Some(path_str) = bundled_dist_path.to_str() {
            frontend_dist_path = path_str.to_string();
          }
        } else {
          log::info!("Bundled frontend dist directory not found at: {:?}", bundled_dist_path);
        }
      }
    }
  }
  
  // Check if we found a frontend dist directory
  if !frontend_dist_path.is_empty() {
    // Check if the frontend index.html exists
    let index_html_path = format!("{}/index.html", frontend_dist_path);
    if Path::new(&index_html_path).exists() {
      log::info!("Frontend index.html exists: {}", index_html_path);
    } else {
      log::error!("Frontend index.html does not exist: {}", index_html_path);
    }
  } else {
    log::error!("Frontend dist directory not found in any expected location");
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