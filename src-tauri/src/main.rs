// Suppresses the extra console window that Windows would otherwise open
// alongside the GUI window in release builds. Has no effect on other platforms.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    easymd_lib::run()
}
