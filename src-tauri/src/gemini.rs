//! Anfrage an die Gemini-API (Interactions-API, siehe spikes/api/spike.mjs).
//! Der Key bleibt auf der Rust-Seite und erscheint nie im Frontend oder in Logs.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";

/// Reihenfolge der Versuche bei Überlastung (503). Kommt später in die Einstellungen.
const MODELS: [&str; 3] = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.6-flash"];
const TTS_MODELS: [&str; 3] = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"];
const TTS_VOICE: &str = "Kore";
const RETRY_PAUSE: Duration = Duration::from_secs(2);
const TIMEOUT: Duration = Duration::from_secs(60);

const SYSTEM: &str = "You are a tutor for math exercise sheets. You usually get a screenshot of the window the user has open, plus a question. Answer in the language of the question (e.g. German or English).
Rules:
- \"spoken\" is the text that will be read aloud. Write formulas in words, never LaTeX.
- \"steps\" are short bullet points for the solution. Formulas in them go in $...$ (LaTeX).
- \"formulas\" are the key formulas as LaTeX (KaTeX-compatible).
- \"plot\" only if a plot is requested or clearly helps. \"expr\" must be parseable by mathjs and use x as the variable. You do not draw anything yourself.
- If it is unclear which exercise is meant, or something is unreadable, set \"needsClarification\" to a short follow-up question, otherwise null.
- The output is JSON: escape every LaTeX backslash, e.g. write \"\\\\frac{1}{2}\" and \"\\\\forall\", \
never a single backslash.";

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

/// Ohne getippte Frage steht sie in der Sprachaufnahme.
const AUDIO_QUESTION: &str = "The question is in the attached voice recording. Answer in the language that is spoken. If the recording is unintelligible or empty, set needsClarification.";

/// Eine Nutzer-Nachricht: getippte Frage oder Sprachaufnahme, beim ersten Mal mit Screenshot.
pub fn user_step(question: Option<&str>, audio: Option<(&[u8], &str)>, screenshot: Option<&[u8]>) -> Value {
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let mut content = vec![json!({ "type": "text", "text": question.unwrap_or(AUDIO_QUESTION) })];
    if let Some((bytes, mime)) = audio {
        content.push(json!({ "type": "audio", "data": b64(bytes), "mime_type": mime }));
    }
    if let Some(png) = screenshot {
        content.push(json!({ "type": "image", "data": b64(png), "mime_type": "image/png" }));
    }
    json!({ "type": "user_input", "content": content })
}

/// Die Antwort des Modells als Schritt für den Verlauf.
pub fn model_step(text: &str) -> Value {
    json!({ "type": "model_output", "content": [{ "type": "text", "text": text }] })
}

/// Frage stellen. Der Verlauf wird jedes Mal komplett mitgeschickt, Google speichert
/// nichts (`store: false`). Liefert die Antwort und ihren Rohtext für den Verlauf.
pub async fn ask(key: &str, history: &[Value], step: &Value) -> Result<(Answer, String), AskError> {
    let input: Vec<&Value> = history.iter().chain([step]).collect();
    let body = post(key, &MODELS, |model| {
        json!({
            "model": model,
            "system_instruction": SYSTEM,
            "input": input,
            "response_format": {
                "type": "text",
                "mime_type": "application/json",
                "schema": schema()
            },
            "store": false
        })
    })
    .await?;
    parse_answer(&body)
}

/// Text vorlesen lassen. Liefert eine WAV-Datei (24 kHz, mono) als Bytes.
pub async fn speak(key: &str, text: &str) -> Result<Vec<u8>, AskError> {
    let body = post(key, &TTS_MODELS, |model| {
        json!({
            "model": model,
            "input": [{ "type": "user_input", "content": [{ "type": "text", "text": text }] }],
            "response_format": { "type": "audio" },
            "generation_config": { "speech_config": [{ "voice": TTS_VOICE }] },
            "store": false
        })
    })
    .await?;
    let audio = output_blocks(&body, "audio")?
        .last()
        .and_then(|c| c["data"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| AskError::Failed("No audio in the response".into()))?;
    base64::engine::general_purpose::STANDARD
        .decode(audio)
        .map_err(|e| AskError::Failed(format!("Unreadable audio: {e}")))
}

/// Anfrage senden, bei Überlastung (503) mit dem nächsten Modell der Liste.
async fn post(key: &str, models: &[&str], body: impl Fn(&str) -> Value) -> Result<String, AskError> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| AskError::Failed(e.to_string()))?;

    for (attempt, model) in models.iter().enumerate() {
        if attempt > 0 {
            // Kurze Pause, ohne den Async-Thread zu blockieren.
            let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(RETRY_PAUSE)).await;
        }
        let res = client
            .post(ENDPOINT)
            .header("x-goog-api-key", key)
            .json(&body(model))
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
            200 => return Ok(text),
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

/// Inhaltsblöcke eines Typs ("text", "audio") aus den Ausgabeschritten.
fn output_blocks(body: &str, kind: &str) -> Result<Vec<Value>, AskError> {
    let interaction: Value =
        serde_json::from_str(body).map_err(|e| AskError::Failed(format!("Unreadable response: {e}")))?;
    Ok(interaction["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|step| step["type"] == "model_output")
        .flat_map(|step| step["content"].as_array().into_iter().flatten())
        .filter(|c| c["type"] == kind)
        .cloned()
        .collect())
}

fn parse_answer(body: &str) -> Result<(Answer, String), AskError> {
    let text: String = output_blocks(body, "text")?
        .iter()
        .filter_map(|c| c["text"].as_str())
        .collect();
    let mut answer: Answer = serde_json::from_str(&text)
        .map_err(|e| AskError::Failed(format!("Response has the wrong format: {e}")))?;
    answer.formulas = answer.formulas.iter().map(|f| repair_latex(f)).collect();
    answer.steps = answer.steps.iter().map(|s| repair_inline_latex(s)).collect();
    Ok((answer, text))
}

/// Das Modell schreibt LaTeX manchmal mit einfachem Backslash ins JSON. Dann wird
/// z. B. `\frac` als Seitenvorschub plus "rac" gelesen und `\text` als Tab plus "ext".
/// Diese Steuerzeichen kommen in Formeln nie gewollt vor, also zurückverwandeln.
fn repair_latex(tex: &str) -> String {
    let mut out = String::with_capacity(tex.len());
    for c in tex.chars() {
        match c {
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out
}

/// Wie `repair_latex`, aber nur innerhalb von `$...$`, der Text drumherum bleibt.
fn repair_inline_latex(text: &str) -> String {
    text.split('$')
        .enumerate()
        .map(|(i, part)| if i % 2 == 1 { repair_latex(part) } else { part.to_owned() })
        .collect::<Vec<_>>()
        .join("$")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_json_escaped_latex() {
        // So kommt "\forall \varepsilon > 0: \frac{1}{n} \text{ für } n" an, wenn das
        // Modell die Backslashes im JSON nicht verdoppelt.
        let broken = "\u{c}orall \\varepsilon > 0: \u{c}rac{1}{n} \text{ für } \nabla";
        assert_eq!(
            repair_latex(broken),
            "\\forall \\varepsilon > 0: \\frac{1}{n} \\text{ für } \\nabla"
        );
    }

    #[test]
    fn repairs_only_inside_dollars() {
        let step = "Line\tone: $\u{c}rac{a}{b}$ and $\text{x}$";
        assert_eq!(
            repair_inline_latex(step),
            "Line\tone: $\\frac{a}{b}$ and $\\text{x}$"
        );
    }

    #[test]
    fn leaves_correct_latex_alone() {
        assert_eq!(repair_latex("\\frac{1}{2}"), "\\frac{1}{2}");
    }
}
