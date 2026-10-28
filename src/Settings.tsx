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
      setHeld(heldModifiers(e).map((m) => MODIFIER_LABELS[m]).join("+"));
    };
    // Leaving the window while recording keeps the old shortcut.
    const onBlur = () => cancelRecording();
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
  }

  async function startRecording() {
    stopSample();
    setError(null);
    // Otherwise Space would also click the focused button.
    (document.activeElement as HTMLElement | null)?.blur();
    await invoke("pause_shortcut");
    setRecordingBoth(true);
  }

  function cancelRecording() {
    if (!recordingRef.current) return;
    setRecordingBoth(false);
    invoke("resume_shortcut").catch((e) => setError(String(e)));
  }

  function recordKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      cancelRecording();
      return;
    }
    const modifiers = heldModifiers(e);
    if (MODIFIER_CODES.has(e.code)) {
      setHeld(modifiers.map((m) => MODIFIER_LABELS[m]).join("+"));
      return;
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      setError("Use Ctrl, Alt or Win together with another key.");
      return;
    }
    setRecordingBoth(false);
    void applyShortcut([...modifiers, e.code].join("+"));
  }

  /** On failure Rust keeps (and re-registers) the old shortcut. */
  async function applyShortcut(shortcut: string) {
    setError(null);
    try {
      await invoke("set_shortcut", { shortcut });
    } catch (e) {
      setError(String(e));
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
          <span className="keys" data-recording={recording ? "" : undefined}>
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
          Tap it to type a question, hold it to ask by voice. {recording && "Esc cancels."}
        </p>
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
