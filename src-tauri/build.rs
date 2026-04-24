fn main() {
    // Ensure cargo reruns the build (and re-embeds bundle icons) whenever
    // anything in icons/ changes. Without this, regenerating icons via
    // `tauri icon` leaves the compiled binary with the old resources.
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
