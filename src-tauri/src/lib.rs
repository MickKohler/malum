use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

/// Logische Größe des Overlays (muss zu tauri.conf.json passen).
const OVERLAY_WIDTH: f64 = 440.0;

/// Logischer Abstand des Fensters zum rechten und oberen Rand des Arbeitsbereichs.
/// Sichtbar sind 16 bzw. 24 px, weil `.stage` in App.css noch 10 bzw. 8 px
/// Innenabstand für den Schatten hat.
const MARGIN_RIGHT: f64 = 6.0;
const MARGIN_TOP: f64 = 16.0;

/// Fokusverlust direkt nach dem Einblenden ignorieren (Windows meldet beim
/// Anzeigen manchmal kurz "unfokussiert", bevor der Fokus ankommt).
const FOCUS_GRACE: Duration = Duration::from_millis(200);

#[derive(Default)]
struct OverlayState {
    /// Logisch geöffnet. Beim Ausblenden wird das sofort `false`, das Fenster
    /// selbst bleibt sichtbar, bis das Frontend seine Ausblend-Animation fertig hat.
    open: bool,
    shown_at: Option<Instant>,
    startup_error: Option<String>,
}

type SharedState = Mutex<OverlayState>;

fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Oben rechts an den Monitor andocken, auf dem gerade der Mauszeiger ist.
fn dock_on_cursor_monitor(app: &AppHandle, window: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };

    // In physische Pixel dieses Monitors umrechnen, damit es auch bei
    // unterschiedlicher Skalierung pro Monitor richtig sitzt.
    let scale = monitor.scale_factor();
    let px = |logical: f64| (logical * scale).round() as i32;

    let area = monitor.work_area();
    let x = area.position.x + area.size.width as i32 - px(OVERLAY_WIDTH) - px(MARGIN_RIGHT);
    let y = area.position.y + px(MARGIN_TOP);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn show_overlay(app: &AppHandle) {
    let Some(window) = overlay(app) else { return };
    {
        let state = app.state::<SharedState>();
        let mut state = state.lock().unwrap();
        state.open = true;
        state.shown_at = Some(Instant::now());
    }
    dock_on_cursor_monitor(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit("overlay-show", ());
}

/// Ausblenden anstoßen. Das Frontend spielt die Animation und ruft danach
/// `hide_overlay` auf.
fn dismiss_overlay(app: &AppHandle) {
    let state = app.state::<SharedState>();
    let mut state = state.lock().unwrap();
    if !state.open {
        return;
    }
    state.open = false;
    drop(state);
    let _ = app.emit("overlay-dismiss", ());
}

fn toggle_overlay(app: &AppHandle) {
    let open = app.state::<SharedState>().lock().unwrap().open;
    if open {
        dismiss_overlay(app);
    } else {
        show_overlay(app);
    }
}

#[tauri::command]
fn request_dismiss(app: AppHandle) {
    dismiss_overlay(&app);
}

/// Wird nach der Ausblend-Animation aufgerufen. Wurde inzwischen wieder
/// geöffnet, bleibt das Fenster sichtbar.
#[tauri::command]
fn hide_overlay(app: AppHandle, state: State<'_, SharedState>) {
    if state.lock().unwrap().open {
        return;
    }
    if let Some(window) = overlay(&app) {
        let _ = window.hide();
    }
}

#[tauri::command]
fn startup_error(state: State<'_, SharedState>) -> Option<String> {
    state.lock().unwrap().startup_error.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SharedState::default())
        .setup(|app| {
            #[cfg(desktop)]
            {
                let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            // Nur "gedrückt" auswerten. "Losgelassen" kommt später für Push-to-talk.
                            if shortcut == &toggle && event.state() == ShortcutState::Pressed {
                                toggle_overlay(app);
                            }
                        })
                        .build(),
                )?;

                if let Err(err) = app.global_shortcut().register(toggle) {
                    // Sichtbar machen statt still zu scheitern (z. B. Shortcut schon belegt).
                    let message = format!(
                        "Shortcut Strg+Umschalt+Leertaste konnte nicht registriert werden: {err}"
                    );
                    eprintln!("{message}");
                    app.state::<SharedState>().lock().unwrap().startup_error = Some(message);
                    show_overlay(app.handle());
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                let app = window.app_handle();
                let in_grace = app
                    .state::<SharedState>()
                    .lock()
                    .unwrap()
                    .shown_at
                    .is_some_and(|t| t.elapsed() < FOCUS_GRACE);
                if !in_grace {
                    dismiss_overlay(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![request_dismiss, hide_overlay, startup_error])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
