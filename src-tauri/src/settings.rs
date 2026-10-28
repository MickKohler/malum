//! User settings as JSON in the app config folder
//! (%APPDATA%\com.mickkohler.malum\settings.json). The API key is not in here,
//! it stays in the Credential Manager.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

/// In the format of the shortcut plugin, key names as in `KeyboardEvent.code`.
pub const DEFAULT_SHORTCUT: &str = "control+shift+Space";

/// Prebuilt Gemini TTS voices with their character, from
/// https://ai.google.dev/gemini-api/docs/speech-generation
pub const VOICES: [(&str, &str); 30] = [
    ("Zephyr", "Bright"),
    ("Puck", "Upbeat"),
    ("Charon", "Informative"),
    ("Kore", "Firm"),
    ("Fenrir", "Excitable"),
    ("Leda", "Youthful"),
    ("Orus", "Firm"),
    ("Aoede", "Breezy"),
    ("Callirrhoe", "Easy-going"),
    ("Autonoe", "Bright"),
    ("Enceladus", "Breathy"),
    ("Iapetus", "Clear"),
    ("Umbriel", "Easy-going"),
    ("Algieba", "Smooth"),
    ("Despina", "Smooth"),
    ("Erinome", "Clear"),
    ("Algenib", "Gravelly"),
    ("Rasalgethi", "Informative"),
    ("Laomedeia", "Upbeat"),
    ("Achernar", "Soft"),
    ("Alnilam", "Firm"),
    ("Schedar", "Even"),
    ("Gacrux", "Mature"),
    ("Pulcherrima", "Forward"),
    ("Achird", "Friendly"),
    ("Zubenelgenubi", "Casual"),
    ("Vindemiatrix", "Gentle"),
    ("Sadachbia", "Lively"),
    ("Sadaltager", "Knowledgeable"),
    ("Sulafat", "Warm"),
];

/// Must match `Settings` in src/Settings.tsx. Missing fields get their default,
/// so older settings files keep working.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub voice: String,
    /// Read every answer aloud right away (otherwise only via the speaker button).
    pub read_aloud: bool,
    /// Capture the window in front and send it with the first question.
    pub share_window: bool,
    /// Tap to type, hold to speak. See `parse_shortcut` for what is allowed.
    pub shortcut: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            voice: "Kore".into(),
            read_aloud: true,
            share_window: true,
            shortcut: DEFAULT_SHORTCUT.into(),
        }
    }
}

impl Settings {
    pub fn is_valid(&self) -> bool {
        VOICES.iter().any(|(name, _)| *name == self.voice) && parse_shortcut(&self.shortcut).is_ok()
    }

    /// Replace invalid values with their defaults.
    fn repaired(self) -> Self {
        let default = Settings::default();
        Self {
            voice: if VOICES.iter().any(|(name, _)| *name == self.voice) { self.voice } else { default.voice },
            shortcut: if parse_shortcut(&self.shortcut).is_ok() { self.shortcut } else { default.shortcut },
            ..self
        }
    }
}

/// A shortcut needs Ctrl, Alt or Win plus one other key. Shift alone is not
/// enough (Shift+M would block typing a capital M), and Esc closes the overlay.
pub fn parse_shortcut(text: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = text.parse().map_err(|_| format!("Unknown shortcut: {text}"))?;
    if !shortcut.mods.intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER) {
        return Err("Use Ctrl, Alt or Win together with another key.".into());
    }
    if shortcut.key == Code::Escape {
        return Err("Esc is reserved for closing the overlay.".into());
    }
    Ok(shortcut)
}

/// For people: "control+shift+Space" becomes "Ctrl+Shift+Space".
pub fn shortcut_label(text: &str) -> String {
    text.split('+')
        .map(|part| match part {
            "control" => "Ctrl".to_string(),
            "shift" => "Shift".to_string(),
            "alt" => "Alt".to_string(),
            "super" => "Win".to_string(),
            key => key
                .strip_prefix("Key")
                .or_else(|| key.strip_prefix("Digit"))
                .or_else(|| key.strip_prefix("Arrow"))
                .unwrap_or(key)
                .to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|e| format!("No settings folder: {e}"))
}

/// A missing or broken file gives the defaults.
pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = path(app) else { return Settings::default() };
    let Ok(text) = std::fs::read_to_string(&path) else { return Settings::default() };
    match serde_json::from_str::<Settings>(&text) {
        Ok(settings) => settings.repaired(),
        Err(err) => {
            eprintln!("Ignoring broken settings file: {err}");
            Settings::default()
        }
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the settings folder: {e}"))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Could not save the settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_get_defaults() {
        let settings: Settings = serde_json::from_str(r#"{ "readAloud": false }"#).unwrap();
        assert_eq!(settings, Settings { read_aloud: false, ..Settings::default() });
    }

    #[test]
    fn shortcut_rules() {
        assert!(parse_shortcut(DEFAULT_SHORTCUT).is_ok());
        assert!(parse_shortcut("control+alt+KeyM").is_ok());
        assert!(parse_shortcut("shift+KeyM").is_err());
        assert!(parse_shortcut("KeyM").is_err());
        assert!(parse_shortcut("control+Escape").is_err());
        assert!(parse_shortcut("control+Nonsense").is_err());
    }

    #[test]
    fn shortcut_labels() {
        assert_eq!(shortcut_label(DEFAULT_SHORTCUT), "Ctrl+Shift+Space");
        assert_eq!(shortcut_label("control+alt+KeyM"), "Ctrl+Alt+M");
        assert_eq!(shortcut_label("super+Digit1"), "Win+1");
    }

    #[test]
    fn default_voice_is_in_the_list() {
        assert!(Settings::default().is_valid());
        assert!(!Settings { voice: "Nobody".into(), ..Settings::default() }.is_valid());
    }
}
