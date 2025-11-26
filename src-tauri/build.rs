fn main() {
  tauri_build::build();
  
  // Enable console in debug builds
  #[cfg(debug_assertions)]
  println!("cargo:rustc-link-arg=/SUBSYSTEM:CONSOLE");
}