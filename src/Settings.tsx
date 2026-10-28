import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, type AskError } from "./errors";
import "./Settings.css";

/** Must match `settings::Settings` in Rust. */
type Settings = { voice: string; readAloud: boolean; shareWindow: boolean; shortcut: string };

/** Must match `SettingsView` in lib.rs. */
type SettingsView = {
  settings: Settings;
  voices: { name: string; style: string }[];
  hasKey: boolean;
  startWithWindows: boolean;
  shortcutLabel: string;
  defaultShortcut: string;
};

type Sample = "off" | "loading" | "playing";

/** How long "Remove" waits for the confirming second click. */
const CONFIRM_MS = 4000;

/** Keys that only count together with another key. */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
]);

/** Held modifiers in the format of the shortcut plugin, e.g. ["control", "shift"]. */
function heldModifiers(e: KeyboardEvent): string[] {
  return [
    e.ctrlKey && "control",
    e.altKey && "alt",
    e.shiftKey && "shift",
    e.metaKey && "super",
  ].filter((m): m is string => !!m);
}

const MODIFIER_LABELS: Record<string, string> = { control: "Ctrl", alt: "Alt", shift: "Shift", super: "Win" };

/** Like `settings::shortcut_label` in Rust: "KeyM" becomes "M". */
function codeLabel(code: string): string {
  return code.replace(/^(Key|Digit|Arrow)/, "");
}

/** "control+alt+KeyM" becomes "Ctrl+Alt+M". */
function shortcutLabel(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => MODIFIER_LABELS[part] ?? codeLabel(part))
    .join("+");
}

/** Feedback right below the shortcut, so a rejected combination is never silent. */
type ShortcutMessage = { kind: "error" | "ok"; text: string };

function Settings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [keyText, setKeyText] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmTimer = useRef<number | undefined>(undefined);
  const [sample, setSample] = useState<Sample>("off");
  const audio = useRef<HTMLAudioElement | null>(null);
  /** Incremented per sample, so a late one is not played anymore. */
  const sampleId = useRef(0);
  /** Waiting for the new shortcut. The current one is paused meanwhile. */
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  /** Modifiers held so far while recording, e.g. "Ctrl+Alt". */
  const [held, setHeld] = useState("");
  const [shortcutMessage, setShortcutMessage] = useState<ShortcutMessage | null>(null);
  /** Counts rejected attempts, restarts the shake animation. */
  const [rejected, setRejected] = useState(0);
  /** Keys whose keydown arrived while recording. A keyup without one means
   * another app or Windows took the combination before it reached us. */
  const pressed = useRef(new Set<string>());

  function reload() {
    invoke<SettingsView>("get_settings")
      .then(setView)
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    reload();
    // Also changed from elsewhere: tray menu, key pasted in the overlay.
    const unlisten = listen("settings-changed", reload);
    const onKeyDown = (e: KeyboardEvent) => {
      if (recordingRef.current) {
        e.preventDefault();
        recordKey(e);
        return;
      }
      // Esc stops the sample and cancels editing the key.
      if (e.key !== "Escape") return;
      stopSample();
      setEditingKey(false);
      setKeyText("");
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!recordingRef.current) return;
      e.preventDefault();
      const modifiers = heldModifiers(e);
      setHeld(modifiers.map((m) => MODIFIER_LABELS[m]).join("+"));
      // Only with Ctrl, Alt or Win held: a plain keyup can also be left over
      // from the click on "Change".
      const swallowed = !MODIFIER_CODES.has(e.code) && !pressed.current.has(e.code);
      if (swallowed && (e.ctrlKey || e.altKey || e.metaKey)) {
        reject(
          `${shortcutLabel([...modifiers, e.code].join("+"))} is already used by Windows or another app. Try a different one.`,
        );
      }
    };
    // Leaving the window while recording keeps the old shortcut.
    const onBlur = () => {
      if (!recordingRef.current) return;
      cancelRecording();
      setShortcutMessage({
        kind: "error",
        text: "Recording stopped because the window lost focus. Combinations Windows uses itself, like Win+D or Alt+Tab, can't be recorded.",
      });
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      void unlisten.then((off) => off());
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      cancelRecording();
      window.clearTimeout(confirmTimer.current);
      stopSample();
    };
  }, []);

  /** Saved right away, there is no Save button. */
  async function update(patch: Partial<Settings>) {
    if (!view) return;
    const settings = { ...view.settings, ...patch };
    setView({ ...view, settings });
    setError(null);
    try {
      await invoke("set_settings", { settings });
    } catch (e) {
      setError(String(e));
      reload();
    }
  }

  async function setStartWithWindows(enabled: boolean) {
    setError(null);
    try {
      await invoke("set_start_with_windows", { enabled });
    } catch (e) {
      setError(String(e));
    }
    reload();
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    if (!keyText.trim()) return;
    setError(null);
    try {
      await invoke("save_api_key", { key: keyText });
      setEditingKey(false);
      setKeyText("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeKey() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      confirmTimer.current = window.setTimeout(() => setConfirmRemove(false), CONFIRM_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirmRemove(false);
    setError(null);
    try {
      await invoke("delete_api_key");
    } catch (e) {
      setError(String(e));
    }
  }

  function setRecordingBoth(value: boolean) {
    recordingRef.current = value;
    setRecording(value);
    setHeld("");
    pressed.current.clear();
  }

  /** `keepMessage`: after a rejection, recording goes on and the reason stays visible. */
  async function startRecording(keepMessage = false) {
    stopSample();
    setError(null);
    if (!keepMessage) setShortcutMessage(null);
    // Otherwise Space would also click the focused button.
    (document.activeElement as HTMLElement | null)?.blur();
    await invoke("pause_shortcut");
    setRecordingBoth(true);
  }

  /** Show why a combination doesn't work and keep listening for the next one. */
  function reject(text: string) {
    setShortcutMessage({ kind: "error", text });
    setRejected((n) => n + 1);
    setHeld("");
  }

  function cancelRecording() {
    if (!recordingRef.current) return;
    setRecordingBoth(false);
    invoke("resume_shortcut").catch((e) => setError(String(e)));
  }

  function recordKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      cancelRecording();
      setShortcutMessage(null);
      return;
    }
    const modifiers = heldModifiers(e);
    if (MODIFIER_CODES.has(e.code)) {
      setHeld(modifiers.map((m) => MODIFIER_LABELS[m]).join("+"));
      return;
    }
    pressed.current.add(e.code);
    const shortcut = [...modifiers, e.code].join("+");
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      reject(`${shortcutLabel(shortcut)} doesn't work: hold Ctrl, Alt or Win too.`);
      return;
    }
    setRecordingBoth(false);
    void applyShortcut(shortcut, true);
  }

  /** On failure Rust keeps (and re-registers) the old shortcut. `recorded`: try
   * again right away instead of making the user click "Change" again. */
  async function applyShortcut(shortcut: string, recorded = false) {
    setError(null);
    try {
      await invoke("set_shortcut", { shortcut });
      setShortcutMessage({ kind: "ok", text: `Saved. ${shortcutLabel(shortcut)} now opens malum.` });
    } catch (e) {
      if (!recorded) {
        setShortcutMessage({ kind: "error", text: String(e) });
        return;
      }
      reject(String(e));
      void startRecording(true);
    }
  }

  function stopSample() {
    sampleId.current++;
    if (audio.current) {
      audio.current.pause();
      URL.revokeObjectURL(audio.current.src);
      audio.current = null;
    }
    setSample("off");
  }

  async function trySample(voice: string) {
    stopSample();
    const id = sampleId.current;
    setSample("loading");
    setError(null);
    try {
      const wav = await invoke<ArrayBuffer>("try_voice", { voice });
      if (id !== sampleId.current) return;
      const player = new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
      player.onended = () => {
        if (audio.current === player) stopSample();
      };
      audio.current = player;
      setSample("playing");
      await player.play();
    } catch (e) {
      if (id !== sampleId.current) return;
      setSample("off");
      setError(errorMessage(e as AskError));
    }
  }

  if (!view) {
    return <main className="settings">{error && <p className="settings-error">{error}</p>}</main>;
  }

  const { settings } = view;

  return (
    <main className="settings">
      <section>
        <h2>Gemini API key</h2>
        {editingKey ? (
          <form className="row" onSubmit={saveKey}>
            <input
              className="field"
              type="password"
              value={keyText}
              onChange={(e) => setKeyText(e.currentTarget.value)}
              placeholder="Paste your key"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            <button type="submit" className="primary" disabled={!keyText.trim()}>
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingKey(false);
                setKeyText("");
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="row">
            <span className="key-state" data-ok={view.hasKey ? "" : undefined}>
              {view.hasKey ? "A key is saved" : "No key saved"}
            </span>
            <button type="button" onClick={() => setEditingKey(true)}>
              {view.hasKey ? "Replace" : "Add key"}
            </button>
            {view.hasKey && (
              <button type="button" className={confirmRemove ? "danger" : undefined} onClick={removeKey}>
                {confirmRemove ? "Really remove?" : "Remove"}
              </button>
            )}
          </div>
        )}
        <p className="hint">
          Stored in the Windows Credential Manager, never shown again. Get a free key at{" "}
          <button type="button" className="link" onClick={() => void openUrl("https://aistudio.google.com")}>
            aistudio.google.com
          </button>
          .
        </p>
      </section>

      <section>
        <h2>Shortcut</h2>
        <div className="row">
          <span
            key={rejected}
            className="keys"
            data-recording={recording ? "" : undefined}
            data-rejected={recording && shortcutMessage?.kind === "error" ? "" : undefined}
          >
            {recording ? (held ? `${held}+ …` : "Press your shortcut …") : view.shortcutLabel}
          </span>
          {recording ? (
            <button type="button" onClick={cancelRecording}>
              Cancel
            </button>
          ) : (
            <button type="button" onClick={() => void startRecording()}>
              Change
            </button>
          )}
          <button
            type="button"
            disabled={recording || settings.shortcut === view.defaultShortcut}
            onClick={() => void applyShortcut(view.defaultShortcut)}
          >
            Reset
          </button>
        </div>
        <p className="hint">
          {recording
            ? "Hold Ctrl, Alt or Win and press a letter, number or F-key. Esc cancels."
            : "Tap it to type a question, hold it to ask by voice."}
        </p>
        {shortcutMessage && (
          <p
            className="shortcut-message"
            data-kind={shortcutMessage.kind}
            role={shortcutMessage.kind === "error" ? "alert" : "status"}
          >
            {shortcutMessage.text}
          </p>
        )}
      </section>

      <section>
        <h2>Voice</h2>
        <div className="row">
          <select
            className="field"
            value={settings.voice}
            onChange={(e) => {
              stopSample();
              void update({ voice: e.currentTarget.value });
            }}
          >
            {view.voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} · {v.style}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => (sample === "off" ? void trySample(settings.voice) : stopSample())}
          >
            {sample === "off" ? "Try" : sample === "loading" ? "Loading …" : "Stop"}
          </button>
        </div>
      </section>

      <section>
        <h2>Behaviour</h2>
        <Toggle
          checked={settings.readAloud}
          onChange={(readAloud) => void update({ readAloud })}
          label="Read answers aloud automatically"
          hint="Otherwise only when you click the speaker button."
        />
        <Toggle
          checked={settings.shareWindow}
          onChange={(shareWindow) => void update({ shareWindow })}
          label="Share the window in front"
          hint="Sends a screenshot of it with your first question. Off: nothing is captured."
        />
        <Toggle
          checked={view.startWithWindows}
          onChange={(enabled) => void setStartWithWindows(enabled)}
          label="Start with Windows"
          hint="malum waits in the system tray for the shortcut."
        />
      </section>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span>
        {props.label}
        <small>{props.hint}</small>
      </span>
    </label>
  );
}

export default Settings;
