//! Anfrage an die Gemini-API (Interactions-API, siehe spikes/api/spike.mjs).
//! Der Key bleibt auf der Rust-Seite und erscheint nie im Frontend oder in Logs.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";

/// Reihenfolge der Versuche bei Überlastung (503). Kommt später in die Einstellungen.
const MODELS: [&str; 3] = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.6-flash"];
const RETRY_PAUSE: Duration = Duration::from_secs(2);
const TIMEOUT: Duration = Duration::from_secs(60);

const SYSTEM: &str = "Du bist ein Tutor für Mathe-Übungsblätter. Du bekommst meist einen \
Screenshot des Fensters, das der Nutzer gerade offen hat, und eine Frage. Antworte in der \
Sprache der Frage (Deutsch oder Englisch).
Regeln:
- \"spoken\" ist der Text, der vorgelesen wird. Formeln darin in Worten, nie LaTeX.
- \"steps\" sind kurze Stichpunkte zum Lösungsweg. Formeln darin in $...$ (LaTeX).
- \"formulas\" sind die wichtigsten Formeln als LaTeX (KaTeX-kompatibel).
- \"plot\" nur, wenn ein Plot gewünscht ist oder klar hilft. \"expr\" muss mathjs-parsebar \
sein und x als Variable nutzen. Du zeichnest nicht selbst.
- Ist unklar, welche Aufgabe gemeint ist, oder ist etwas nicht lesbar, setze \
\"needsClarification\" auf eine kurze Rückfrage, sonst null.";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub spoken: String,
    pub steps: Vec<String>,
    pub formulas: Vec<String>,
    pub plot: Option<Plot>,
    pub needs_clarification: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plot {
    pub expr: String,
    pub x_min: f64,
    pub x_max: f64,
    pub label: String,
}

/// Fehlerarten, die das Frontend jeweils mit eigener Meldung anzeigt.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AskError {
    KeyMissing,
    KeyInvalid,
    RateLimited,
    Overloaded,
    Offline,
    Cancelled,
    Failed(String),
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "spoken": { "type": "string" },
            "steps": { "type": "array", "items": { "type": "string" } },
            "formulas": { "type": "array", "items": { "type": "string" } },
            "plot": {
                "type": ["object", "null"],
                "properties": {
                    "expr": { "type": "string" },
                    "xMin": { "type": "number" },
                    "xMax": { "type": "number" },
                    "label": { "type": "string" }
                },
                "required": ["expr", "xMin", "xMax", "label"]
            },
            "needsClarification": { "type": ["string", "null"] }
        },
        "required": ["spoken", "steps", "formulas", "plot", "needsClarification"]
    })
}

pub async fn ask(key: &str, question: &str, screenshot: Option<&[u8]>) -> Result<Answer, AskError> {
    let mut input = vec![json!({ "type": "text", "text": question })];
    if let Some(png) = screenshot {
        let data = base64::engine::general_purpose::STANDARD.encode(png);
        input.push(json!({ "type": "image", "data": data, "mime_type": "image/png" }));
    }

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| AskError::Failed(e.to_string()))?;

    for (attempt, model) in MODELS.iter().enumerate() {
        if attempt > 0 {
            // Kurze Pause, ohne den Async-Thread zu blockieren.
            let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(RETRY_PAUSE)).await;
        }
        let body = json!({
            "model": model,
            "system_instruction": SYSTEM,
            "input": input,
            "response_format": {
                "type": "text",
                "mime_type": "application/json",
                "schema": schema()
            },
            "store": false
        });
        let res = client
            .post(ENDPOINT)
            .header("x-goog-api-key", key)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    AskError::Offline
                } else {
                    AskError::Failed(e.without_url().to_string())
                }
            })?;

        let status = res.status().as_u16();
        let text = res.text().await.map_err(|_| AskError::Offline)?;
        match status {
            200 => return parse_answer(&text),
            503 => continue,
            429 => return Err(AskError::RateLimited),
            401 | 403 => return Err(AskError::KeyInvalid),
            400 if text.contains("API key") || text.contains("API_KEY") => {
                return Err(AskError::KeyInvalid);
            }
            _ => {
                let short: String = text.chars().take(300).collect();
                return Err(AskError::Failed(format!("HTTP {status}: {short}")));
            }
        }
    }
    Err(AskError::Overloaded)
}

fn parse_answer(body: &str) -> Result<Answer, AskError> {
    let interaction: Value =
        serde_json::from_str(body).map_err(|e| AskError::Failed(format!("Antwort unlesbar: {e}")))?;
    let text: String = interaction["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|step| step["type"] == "model_output")
        .flat_map(|step| step["content"].as_array().into_iter().flatten())
        .filter(|c| c["type"] == "text")
        .filter_map(|c| c["text"].as_str())
        .collect();
    serde_json::from_str(&text).map_err(|e| AskError::Failed(format!("Antwort hat falsches Format: {e}")))
}
