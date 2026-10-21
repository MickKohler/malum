mod capture;
mod credentials;
mod gemini;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::async_runtime::JoinHandle;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent,
};

use gemini::{Answer, AskError};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

/// Logische Größe des Overlays (muss zu tauri.conf.json passen).
const OVERLAY_WIDTH: f64 = 440.0;
const OVERLAY_MIN_HEIGHT: f64 = 72.0;
/// Höher wird das Fenster nie, längere Antworten scrollen im Frontend.
const OVERLAY_MAX_HEIGHT: f64 = 640.0;

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
    /// Läuft gerade: Screenshot des Fensters, das vor dem Overlay vorne war.
    capture: Option<JoinHandle<Option<Vec<u8>>>>,
    /// Fertiger Screenshot für weitere Fragen in derselben Sitzung. Nur im Speicher.
    screenshot: Option<Arc<Vec<u8>>>,
    /// Brechen laufende Gemini-Anfragen (Antwort, Vorlesen) ab.
    cancel: Vec<Box<dyn Fn() + Send>>,
}

impl OverlayState {
    /// Sitzung beenden: Anfrage abbrechen, Screenshot verwerfen.
    fn end_session(&mut self) {
        for cancel in self.cancel.drain(..) {
            cancel();
        }
        if let Some(task) = self.capture.take() {
            task.abort();
        }
        self.screenshot = None;
    }
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

/// `target` ist das Fenster, das aufgenommen werden soll (nur beim Shortcut,
/// beim Tray-Klick ist das vordere Fenster die Taskleiste).
fn show_overlay(app: &AppHandle, target: Option<isize>) {
    let Some(window) = overlay(app) else { return };
    {
        let state = app.state::<SharedState>();
        let mut state = state.lock().unwrap();
        state.end_session();
        state.open = true;
        state.shown_at = Some(Instant::now());
        state.capture = target.map(|hwnd| {
            tauri::async_runtime::spawn_blocking(move || {
                capture::capture_png(hwnd)
                    .inspect_err(|err| eprintln!("Screenshot fehlgeschlagen: {err}"))
                    .ok()
            })
        });
    }
    let _ = window.set_size(LogicalSize::new(OVERLAY_WIDTH, OVERLAY_MIN_HEIGHT));
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
    state.end_session();
    drop(state);
    let _ = app.emit("overlay-dismiss", ());
}

fn toggle_overlay(app: &AppHandle) {
    let open = app.state::<SharedState>().lock().unwrap().open;
    if open {
        dismiss_overlay(app);
    } else {
        // Vor dem Einblenden merken, welches Fenster vorne ist.
        show_overlay(app, capture::foreground_window());
    }
}

/// Tray-Icon mit Menü. Linksklick blendet das Overlay ein, Rechtsklick zeigt das Menü.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Öffnen\tStrg+Umschalt+Leertaste", true, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Mit Windows starten",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &separator, &autostart, &separator, &quit])?;

    let autostart_item = autostart.clone();

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("malum")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_overlay(app, None),
            "autostart" => set_autostart(app, &autostart_item),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Immer einblenden statt umschalten: Der Klick aufs Tray nimmt dem
            // Overlay ohnehin den Fokus, das würde es sonst gleich wieder schließen.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_overlay(tray.app_handle(), None);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Windows schaltet den Haken beim Klick schon um. Den neuen Zustand übernehmen
/// und bei einem Fehler den Haken auf den echten Zustand zurücksetzen.
fn set_autostart(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let want = item.is_checked().unwrap_or(false);
    let autolaunch = app.autolaunch();
    let result = if want { autolaunch.enable() } else { autolaunch.disable() };
    if let Err(err) = result {
        eprintln!("Autostart konnte nicht geändert werden: {err}");
        let _ = item.set_checked(autolaunch.is_enabled().unwrap_or(false));
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

/// Das Frontend meldet seine Inhaltshöhe, das Fenster wächst nach unten mit.
#[tauri::command]
fn set_overlay_height(app: AppHandle, height: f64) {
    if let Some(window) = overlay(&app) {
        let height = height.clamp(OVERLAY_MIN_HEIGHT, OVERLAY_MAX_HEIGHT);
        let _ = window.set_size(LogicalSize::new(OVERLAY_WIDTH, height));
    }
}

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Bitte einen Key einfügen".into());
    }
    credentials::save_api_key(key)
}

/// Frage plus Screenshot an Gemini. Esc oder Schließen bricht die Anfrage ab.
#[tauri::command]
async fn ask(app: AppHandle, question: String) -> Result<Answer, AskError> {
    let key = credentials::load_api_key()
        .map_err(AskError::Failed)?
        .ok_or(AskError::KeyMissing)?;

    let pending = app.state::<SharedState>().lock().unwrap().capture.take();
    if let Some(task) = pending {
        let png = task.await.ok().flatten();
        app.state::<SharedState>().lock().unwrap().screenshot = png.map(Arc::new);
    }
    let screenshot = app.state::<SharedState>().lock().unwrap().screenshot.clone();

    cancellable(&app, async move {
        gemini::ask(&key, &question, screenshot.as_deref().map(Vec::as_slice)).await
    })
    .await
}

/// Text vorlesen. Gibt die WAV-Datei als rohe Bytes ans Frontend.
#[tauri::command]
async fn speak(app: AppHandle, text: String) -> Result<tauri::ipc::Response, AskError> {
    let key = credentials::load_api_key()
        .map_err(AskError::Failed)?
        .ok_or(AskError::KeyMissing)?;
    let wav = cancellable(&app, async move { gemini::speak(&key, &text).await }).await?;
    Ok(tauri::ipc::Response::new(wav))
}

/// Anfrage als eigene Aufgabe starten, die beim Schließen des Overlays abbricht.
async fn cancellable<T: Send + 'static>(
    app: &AppHandle,
    future: impl Future<Output = Result<T, AskError>> + Send + 'static,
) -> Result<T, AskError> {
    let task = tauri::async_runtime::spawn(future);
    let abort = task.inner().abort_handle();
    app.state::<SharedState>().lock().unwrap().cancel.push(Box::new(move || abort.abort()));
    task.await.unwrap_or(Err(AskError::Cancelled))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Muss als erstes Plugin registriert werden. Ein zweiter Start (z. B. übers
    // Startmenü) blendet nur das Overlay der laufenden App ein.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_overlay(app, None);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .manage(SharedState::default())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                ))?;
                build_tray(app.handle())?;

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
                    show_overlay(app.handle(), None);
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
        .invoke_handler(tauri::generate_handler![
            request_dismiss,
            hide_overlay,
            startup_error,
            set_overlay_height,
            save_api_key,
            ask,
            speak
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
