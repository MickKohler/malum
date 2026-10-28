mod capture;
mod credentials;
mod gemini;
mod settings;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use gemini::{Answer, AskError};
use settings::Settings;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

/// Logical size of the overlay (must match tauri.conf.json).
const OVERLAY_WIDTH: f64 = 440.0;
const OVERLAY_MIN_HEIGHT: f64 = 72.0;
/// The window never gets taller; longer answers scroll in the frontend.
const OVERLAY_MAX_HEIGHT: f64 = 640.0;

/// Logical distance of the window from the right and top edge of the work area.
/// Visually it is 16 and 24 px, because `.stage` in App.css adds 10 and 8 px
/// of padding for the shadow.
const MARGIN_RIGHT: f64 = 6.0;
const MARGIN_TOP: f64 = 16.0;

/// Ignore focus loss right after showing (Windows sometimes briefly reports
/// "unfocused" while showing, before focus arrives).
const FOCUS_GRACE: Duration = Duration::from_millis(200);

/// A shorter press counts as a tap (overlay for typing), a longer one as speaking.
const HOLD_THRESHOLD: Duration = Duration::from_millis(300);

#[derive(Default)]
struct OverlayState {
    /// Logically open. Turns `false` as soon as hiding starts; the window itself
    /// stays visible until the frontend has finished its exit animation.
    open: bool,
    shown_at: Option<Instant>,
    startup_error: Option<String>,
    /// An answer is visible: clicking elsewhere no longer closes the overlay,
    /// so you can look at the exercise sheet.
    sticky: bool,
    /// The shortcut is being held (since when).
    pressed_at: Option<Instant>,
    /// The overlay was already open and in front on press: a short tap closes it.
    tap_dismisses: bool,
    /// Capturing the window that was in front before the overlay.
    capturing: bool,
    /// Finished screenshot of the session. In memory only.
    screenshot: Option<Arc<Vec<u8>>>,
    /// Questions and answers of the session so far, for follow-ups with context.
    history: Vec<serde_json::Value>,
    /// Counts sessions, so a late answer doesn't land in a new session.
    session: u64,
    /// Cancel running Gemini requests (answer, speech).
    cancel: Vec<Box<dyn Fn() + Send>>,
}

impl OverlayState {
    /// End the session: cancel requests, discard the screenshot.
    fn end_session(&mut self) {
        for cancel in self.cancel.drain(..) {
            cancel();
        }
        self.capturing = false;
        self.screenshot = None;
        self.history.clear();
        self.session += 1;
    }
}

type SharedState = Mutex<OverlayState>;
type SharedSettings = Mutex<Settings>;

/// Tray menu items that change with the settings.
struct TrayItems {
    /// Shows the shortcut.
    open: MenuItem<tauri::Wry>,
    /// "Start with Windows", kept in sync with the settings window.
    autostart: CheckMenuItem<tauri::Wry>,
}

fn open_item_text(shortcut: &str) -> String {
    format!("Open\t{}", settings::shortcut_label(shortcut))
}

fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn escape() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// While the overlay is open, Esc is taken system-wide, so it also closes the
/// overlay after you clicked into another window. Released again on close.
fn grab_escape(app: &AppHandle, grab: bool) {
    let shortcuts = app.global_shortcut();
    let result = match (grab, shortcuts.is_registered(escape())) {
        (true, false) => shortcuts.register(escape()),
        (false, true) => shortcuts.unregister(escape()),
        _ => Ok(()),
    };
    // If another app holds Esc, Esc still works while the overlay has focus.
    if let Err(err) = result {
        eprintln!("Could not change the Esc shortcut: {err}");
    }
}

/// Dock at the top right of the monitor the mouse cursor is on.
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

    // Convert to physical pixels of this monitor, so it also sits right
    // with different scaling per monitor.
    let scale = monitor.scale_factor();
    let px = |logical: f64| (logical * scale).round() as i32;

    let area = monitor.work_area();
    let x = area.position.x + area.size.width as i32 - px(OVERLAY_WIDTH) - px(MARGIN_RIGHT);
    let y = area.position.y + px(MARGIN_TOP);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// `target` is the window to capture (only for the shortcut; on a tray click
/// the window in front is the taskbar).
fn show_overlay(app: &AppHandle, target: Option<isize>) {
    let Some(window) = overlay(app) else { return };
    {
        let state = app.state::<SharedState>();
        let mut state = state.lock().unwrap();
        state.end_session();
        state.open = true;
        state.sticky = false;
        state.shown_at = Some(Instant::now());
        let share = app.state::<SharedSettings>().lock().unwrap().share_window;
        if let Some(hwnd) = target.filter(|_| share) {
            state.capturing = true;
            let session = state.session;
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let png = capture::capture_png(hwnd)
                    .inspect_err(|err| eprintln!("Screenshot failed: {err}"))
                    .ok();
                let state = app.state::<SharedState>();
                let mut state = state.lock().unwrap();
                // A new session started meanwhile: drop the image.
                if state.session == session {
                    state.screenshot = png.map(Arc::new);
                    state.capturing = false;
                }
            });
        }
    }
    let _ = window.set_size(LogicalSize::new(OVERLAY_WIDTH, OVERLAY_MIN_HEIGHT));
    dock_on_cursor_monitor(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
    grab_escape(app, true);
    let _ = app.emit("overlay-show", ());
}

/// Start hiding. The frontend plays the animation and then calls
/// `hide_overlay`.
fn dismiss_overlay(app: &AppHandle) {
    let state = app.state::<SharedState>();
    let mut state = state.lock().unwrap();
    if !state.open {
        return;
    }
    state.open = false;
    state.end_session();
    drop(state);
    grab_escape(app, false);
    let _ = app.emit("overlay-dismiss", ());
}

/// Shortcut pressed: start recording. If the overlay is closed or not in front,
/// a new question about the window in front begins. What happens to the
/// recording is decided on release.
fn shortcut_pressed(app: &AppHandle) {
    let open = {
        let state = app.state::<SharedState>();
        let state = state.lock().unwrap();
        if state.pressed_at.is_some() {
            return; // already pressed
        }
        state.open
    };
    let active = open && overlay(app).is_some_and(|w| w.is_focused().unwrap_or(false));
    if !active {
        // Remember which window is in front before showing.
        show_overlay(app, capture::foreground_window());
    }
    {
        let state = app.state::<SharedState>();
        let mut state = state.lock().unwrap();
        state.pressed_at = Some(Instant::now());
        state.tap_dismisses = active;
    }
    let _ = app.emit("ptt-start", ());
}

/// Shortcut released: held long = send the recording, short = discard it
/// (and close if the overlay was already open before).
fn shortcut_released(app: &AppHandle) {
    let (pressed_at, tap_dismisses) = {
        let state = app.state::<SharedState>();
        let mut state = state.lock().unwrap();
        (state.pressed_at.take(), state.tap_dismisses)
    };
    let Some(pressed_at) = pressed_at else { return };
    let held = pressed_at.elapsed() >= HOLD_THRESHOLD;
    let _ = app.emit("ptt-end", held);
    if !held && tap_dismisses {
        dismiss_overlay(app);
    }
}

/// Tray icon with menu. Left click shows the overlay, right click shows the menu.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let shortcut = app.state::<SharedSettings>().lock().unwrap().shortcut.clone();
    let open = MenuItem::with_id(app, "open", open_item_text(&shortcut), true, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start with Windows",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&open, &separator, &settings, &autostart, &separator, &quit],
    )?;
    app.manage(TrayItems { open: open.clone(), autostart: autostart.clone() });

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("malum")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_overlay(app, None),
            "settings" => open_settings_window(app),
            "autostart" => {
                // Windows already toggled the check mark.
                let want = app.state::<TrayItems>().autostart.is_checked().unwrap_or(false);
                if let Err(err) = apply_autostart(app, want) {
                    eprintln!("{err}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Always show instead of toggling: clicking the tray takes focus from
            // the overlay anyway, which would close it again right away.
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

/// Turn "Start with Windows" on or off. The tray check mark and the settings
/// window then show the real state, also on failure.
fn apply_autostart(app: &AppHandle, want: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let result = if want { autolaunch.enable() } else { autolaunch.disable() };
    let _ = app.state::<TrayItems>().autostart.set_checked(autolaunch.is_enabled().unwrap_or(false));
    let _ = app.emit("settings-changed", ());
    result.map_err(|err| format!("Could not change autostart: {err}"))
}

/// Show the settings window, or bring it to the front if it is already open.
fn open_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    // Creating a window from an event handler or a sync command deadlocks on
    // Windows (see WebviewWindowBuilder::new), so do it on its own thread.
    let app = app.clone();
    std::thread::spawn(move || {
        let result = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html".into()))
            .title("malum settings")
            .inner_size(440.0, 680.0)
            .resizable(false)
            .maximizable(false)
            .theme(Some(Theme::Dark))
            .center()
            .build();
        if let Err(err) = result {
            eprintln!("Could not open the settings: {err}");
        }
    });
}

#[tauri::command]
fn request_dismiss(app: AppHandle) {
    dismiss_overlay(&app);
}

/// Called after the exit animation. If the overlay was reopened meanwhile,
/// the window stays visible.
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

/// The frontend reports its content height; the window grows downward with it.
#[tauri::command]
fn set_overlay_height(app: AppHandle, height: f64) {
    if let Some(window) = overlay(&app) {
        let height = height.clamp(OVERLAY_MIN_HEIGHT, OVERLAY_MAX_HEIGHT);
        let _ = window.set_size(LogicalSize::new(OVERLAY_WIDTH, height));
    }
}

#[tauri::command]
fn set_sticky(state: State<'_, SharedState>, sticky: bool) {
    state.lock().unwrap().sticky = sticky;
}

#[tauri::command]
fn save_api_key(app: AppHandle, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Please paste a key".into());
    }
    credentials::save_api_key(key)?;
    let _ = app.emit("settings-changed", ());
    Ok(())
}

#[tauri::command]
fn delete_api_key(app: AppHandle) -> Result<(), String> {
    credentials::delete_api_key()?;
    let _ = app.emit("settings-changed", ());
    Ok(())
}

/// Everything the settings window shows. The key itself never leaves Rust.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    settings: Settings,
    voices: Vec<Voice>,
    has_key: bool,
    start_with_windows: bool,
    shortcut_label: String,
    default_shortcut: &'static str,
}

#[derive(serde::Serialize)]
struct Voice {
    name: &'static str,
    style: &'static str,
}

#[tauri::command]
fn get_settings(app: AppHandle) -> SettingsView {
    // Lock once: a guard taken inside the struct literal would live until its end,
    // and a second lock there would wait forever.
    let current = app.state::<SharedSettings>().lock().unwrap().clone();
    SettingsView {
        shortcut_label: settings::shortcut_label(&current.shortcut),
        default_shortcut: settings::DEFAULT_SHORTCUT,
        settings: current,
        voices: settings::VOICES.iter().map(|&(name, style)| Voice { name, style }).collect(),
        has_key: matches!(credentials::load_api_key(), Ok(Some(_))),
        start_with_windows: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
fn set_settings(app: AppHandle, mut settings: Settings) -> Result<(), String> {
    // The shortcut only changes through `set_shortcut`, which also registers it.
    settings.shortcut = app.state::<SharedSettings>().lock().unwrap().shortcut.clone();
    if !settings.is_valid() {
        return Err(format!("Unknown voice: {}", settings.voice));
    }
    settings::save(&app, &settings)?;
    *app.state::<SharedSettings>().lock().unwrap() = settings;
    let _ = app.emit("settings-changed", ());
    Ok(())
}

/// Register the shortcut from the settings, unless it already is.
fn register_shortcut(app: &AppHandle) -> Result<(), String> {
    let text = app.state::<SharedSettings>().lock().unwrap().shortcut.clone();
    let shortcut = settings::parse_shortcut(&text)?;
    let shortcuts = app.global_shortcut();
    if shortcuts.is_registered(shortcut) {
        return Ok(());
    }
    shortcuts.register(shortcut).map_err(|err| {
        format!("Could not register the shortcut {}: {err}", settings::shortcut_label(&text))
    })
}

/// While the settings window records a new shortcut, the current one must not
/// open the overlay.
#[tauri::command]
fn pause_shortcut(app: AppHandle) {
    let text = app.state::<SharedSettings>().lock().unwrap().shortcut.clone();
    if let Ok(shortcut) = settings::parse_shortcut(&text) {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

#[tauri::command]
fn resume_shortcut(app: AppHandle) -> Result<(), String> {
    register_shortcut(&app)
}

/// Switch to a new shortcut. If it is invalid or Windows refuses it (taken by
/// another app), the old one stays and is active again.
#[tauri::command]
fn set_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    let new = match settings::parse_shortcut(&shortcut) {
        Ok(new) => new,
        Err(err) => {
            // The old one may be paused for recording.
            let _ = register_shortcut(&app);
            return Err(err);
        }
    };
    let old_text = app.state::<SharedSettings>().lock().unwrap().shortcut.clone();
    let shortcuts = app.global_shortcut();
    if let Ok(old) = settings::parse_shortcut(&old_text) {
        if old != new && shortcuts.is_registered(old) {
            let _ = shortcuts.unregister(old);
        }
    }
    if !shortcuts.is_registered(new) {
        if let Err(err) = shortcuts.register(new) {
            eprintln!("Could not register {shortcut}: {err}");
            let _ = register_shortcut(&app);
            let label = settings::shortcut_label(&shortcut);
            return Err(if err.to_string().contains("Unknown VKCode") {
                format!("{label} can't be used as a shortcut. Try a letter, number or F-key.")
            } else {
                format!("{label} is already used by Windows or another app. Try a different one.")
            });
        }
    }
    let settings = {
        let state = app.state::<SharedSettings>();
        let mut settings = state.lock().unwrap();
        settings.shortcut = shortcut;
        settings.clone()
    };
    let _ = app.state::<TrayItems>().open.set_text(open_item_text(&settings.shortcut));
    let _ = app.emit("settings-changed", ());
    settings::save(&app, &settings)
}

#[tauri::command]
fn set_start_with_windows(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_autostart(&app, enabled)
}

#[tauri::command]
async fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

/// Sample of a voice for the settings window. Not tied to the overlay, so
/// closing the overlay doesn't cancel it.
#[tauri::command]
async fn try_voice(voice: String) -> Result<tauri::ipc::Response, AskError> {
    let key = credentials::load_api_key()
        .map_err(AskError::Failed)?
        .ok_or(AskError::KeyMissing)?;
    let text = format!("Hi, I'm {voice}. This is how I will read your answers.");
    let wav = gemini::speak(&key, &text, &voice).await?;
    Ok(tauri::ipc::Response::new(wav))
}

/// Send a question (typed or as a voice recording) plus screenshot to Gemini.
/// Esc or closing cancels the request.
#[tauri::command]
async fn ask(
    app: AppHandle,
    question: Option<String>,
    audio: Option<Vec<u8>>,
    audio_mime: Option<String>,
) -> Result<Answer, AskError> {
    let key = credentials::load_api_key()
        .map_err(AskError::Failed)?
        .ok_or(AskError::KeyMissing)?;

    wait_for_capture(&app).await;
    let (screenshot, history, session) = {
        let state = app.state::<SharedState>();
        let state = state.lock().unwrap();
        (state.screenshot.clone(), state.history.clone(), state.session)
    };

    // The screenshot goes with the first question only; after that it is in the history.
    let screenshot = screenshot.filter(|_| history.is_empty());
    let audio = audio.as_deref().zip(audio_mime.as_deref());
    let step = gemini::user_step(question.as_deref(), audio, screenshot.as_deref().map(Vec::as_slice));

    let (answer, step) = cancellable(&app, async move {
        let (answer, raw) = gemini::ask(&key, &history, &step).await?;
        Ok((answer, [step, gemini::model_step(&raw)]))
    })
    .await?;
    let state = app.state::<SharedState>();
    let mut state = state.lock().unwrap();
    if state.session == session {
        state.history.extend(step);
    }
    Ok(answer)
}

/// Wait until the screenshot taken on show is done (usually under 200 ms).
async fn wait_for_capture(app: &AppHandle) {
    for _ in 0..100 {
        if !app.state::<SharedState>().lock().unwrap().capturing {
            return;
        }
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(20))).await;
    }
}

/// Preview of the screenshot sent with the first question. Empty if there is none.
#[tauri::command]
async fn screenshot_preview(app: AppHandle) -> tauri::ipc::Response {
    wait_for_capture(&app).await;
    let png = app.state::<SharedState>().lock().unwrap().screenshot.clone();
    tauri::ipc::Response::new(png.map(|p| p.to_vec()).unwrap_or_default())
}

/// Don't send the screenshot.
#[tauri::command]
fn discard_screenshot(state: State<'_, SharedState>) {
    state.lock().unwrap().screenshot = None;
}

/// Read text aloud. Passes the WAV file to the frontend as raw bytes.
#[tauri::command]
async fn speak(app: AppHandle, text: String) -> Result<tauri::ipc::Response, AskError> {
    let key = credentials::load_api_key()
        .map_err(AskError::Failed)?
        .ok_or(AskError::KeyMissing)?;
    let voice = app.state::<SharedSettings>().lock().unwrap().voice.clone();
    let wav = cancellable(&app, async move { gemini::speak(&key, &text, &voice).await }).await?;
    Ok(tauri::ipc::Response::new(wav))
}

/// Run a request as its own task, cancelled when the overlay closes.
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
    // Must be registered as the first plugin. A second launch (e.g. from the
    // Start menu) only shows the overlay of the running app.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_overlay(app, None);
        }));
    }

    builder
        // Allow the microphone for push-to-talk without a WebView prompt. The
        // Windows privacy setting for desktop apps still applies.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .plugin(tauri_plugin_opener::init())
        .manage(SharedState::default())
        .setup(|app| {
            app.manage(SharedSettings::new(settings::load(app.handle())));
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                ))?;
                build_tray(app.handle())?;

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &escape() {
                                if event.state() == ShortcutState::Pressed {
                                    dismiss_overlay(app);
                                }
                                return;
                            }
                            // Only Esc and the shortcut from the settings are registered.
                            match event.state() {
                                ShortcutState::Pressed => shortcut_pressed(app),
                                ShortcutState::Released => shortcut_released(app),
                            }
                        })
                        .build(),
                )?;

                if let Err(err) = register_shortcut(app.handle()) {
                    // Make it visible instead of failing silently (e.g. shortcut already taken).
                    let message = format!("{err}. Choose another one in the settings (tray icon).");
                    eprintln!("{message}");
                    app.state::<SharedState>().lock().unwrap().startup_error = Some(message);
                    show_overlay(app.handle(), None);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closed while recording a new shortcut: turn the current one back on.
            if let WindowEvent::Destroyed = event {
                if window.label() == "settings" {
                    let _ = register_shortcut(window.app_handle());
                }
            }
            if let WindowEvent::Focused(false) = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                let keep_open = {
                    let state = app.state::<SharedState>();
                    let state = state.lock().unwrap();
                    state.sticky || state.shown_at.is_some_and(|t| t.elapsed() < FOCUS_GRACE)
                };
                if !keep_open {
                    dismiss_overlay(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            request_dismiss,
            hide_overlay,
            startup_error,
            set_overlay_height,
            set_sticky,
            screenshot_preview,
            discard_screenshot,
            save_api_key,
            delete_api_key,
            get_settings,
            set_settings,
            set_start_with_windows,
            pause_shortcut,
            resume_shortcut,
            set_shortcut,
            open_settings,
            try_voice,
            ask,
            speak
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
