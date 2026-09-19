fn main() {
    // tauri-build only watches tauri.conf.json, so without this a regenerated
    // icons/ (e.g. from `tauri icon`) would not be re-embedded into the exe.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
