// Enable console window for debugging logs in Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
  
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_http::init())
    .setup(|app| {
      log::info!("Application setup completed");
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}