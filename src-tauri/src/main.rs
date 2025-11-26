// Always show console window for debugging - removed conditional compilation
#![windows_subsystem = "console"]

use std::io::Write;

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
  
  // Generate context and log information about it
  log::info!("Generating Tauri context...");
  let context = tauri::generate_context!();
  log::info!("Context generated successfully");
  log::info!("Package name: {}", context.package_info().name);
  log::info!("Package version: {}", context.package_info().version);
  
  let result = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![])
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