// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// if you are actually reading the code, kudos to you :)
fn main() {
    malum_lib::run()
}
