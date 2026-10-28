//! User settings as JSON in the app config folder
//! (%APPDATA%\com.mickkohler.malum\settings.json). The API key is not in here,
//! it stays in the Credential Manager.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
}

impl Default for Settings {
    fn default() -> Self {
        Self { voice: "Kore".into(), read_aloud: true, share_window: true }
    }
}

impl Settings {
    pub fn is_valid(&self) -> bool {
        VOICES.iter().any(|(name, _)| *name == self.voice)
    }
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
        Ok(settings) if settings.is_valid() => settings,
        Ok(settings) => Settings { voice: Settings::default().voice, ..settings },
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
    fn default_voice_is_in_the_list() {
        assert!(Settings::default().is_valid());
        assert!(!Settings { voice: "Nobody".into(), ..Settings::default() }.is_valid());
    }
}
