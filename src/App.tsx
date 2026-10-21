import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Formula, MathText } from "./Math";
import { Plot } from "./Plot";
import { MicError, Recorder, type Recording } from "./recorder";
import "./App.css";

/** Muss zur Dauer der Ausblend-Transition in App.css passen. */
const EXIT_MS = 120;

type Phase = "in" | "out";

/** Muss zu `gemini::Answer` in Rust passen. */
type Answer = {
  spoken: string;
  steps: string[];
  formulas: string[];
  plot: { expr: string; xMin: number; xMax: number; label: string } | null;
  needsClarification: string | null;
};

/** Muss zu `gemini::AskError` in Rust passen. */
type AskError =
  | { kind: "keyMissing" | "keyInvalid" | "rateLimited" | "overloaded" | "offline" | "cancelled" }
  | { kind: "failed"; message: string };

type Voice = "off" | "loading" | "playing";

/** Getippte Frage oder Sprachaufnahme. */
type Question = { text: string } | { audio: Recording };

type View =
  | { kind: "input" }
  | { kind: "key"; invalid: boolean }
  | { kind: "loading" }
  | { kind: "answer"; answer: Answer }
  | { kind: "error"; message: string };

function errorMessage(error: AskError): string {
  switch (error.kind) {
    case "rateLimited":
      return "Gratis-Limit erreicht. Warte eine Minute und versuch es dann nochmal.";
    case "overloaded":
      return "Gemini ist gerade überlastet. Versuch es gleich nochmal.";
    case "offline":
      return "Keine Verbindung zu Gemini. Ist das Internet an?";
    case "failed":
      return `Etwas ist schiefgegangen: ${error.message}`;
    default:
      return "Etwas ist schiefgegangen.";
  }
}

function App() {
  const [phase, setPhase] = useState<Phase>("out");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [view, setView] = useState<View>({ kind: "input" });
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  /** Frage, die nach dem Speichern des Keys gestellt wird. */
  const pendingQuestion = useRef<Question | null>(null);
  const recorder = useRef(new Recorder());
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  const [voice, setVoice] = useState<Voice>("off");
  const audio = useRef<HTMLAudioElement | null>(null);
  /** Zählt Fragen hoch, damit eine verspätete Sprachausgabe nicht mehr abgespielt wird. */
  const session = useRef(0);

  useEffect(() => {
    const focusInput = () => {
      // Ein Frame warten, bis das Fenster wirklich sichtbar ist.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };

    const enter = () => {
      // Eine laufende Ausblend-Animation abbrechen.
      window.clearTimeout(hideTimer.current);
      stopVoice();
      setView({ kind: "input" });
      setPhase("in");
      focusInput();
    };

    const exit = () => {
      stopVoice();
      stopListening();
      setPhase("out");
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        void invoke("hide_overlay");
      }, EXIT_MS);
    };

    const unlistenShow = listen("overlay-show", enter);
    const unlistenDismiss = listen("overlay-dismiss", exit);
    const unlistenPttStart = listen("ptt-start", startListening);
    const unlistenPttEnd = listen<boolean>("ptt-end", (e) => void endListening(e.payload));

    invoke<string | null>("startup_error").then((message) => {
      if (message) {
        setError(message);
        enter();
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void invoke("request_dismiss");
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(hideTimer.current);
      void unlistenShow.then((off) => off());
      void unlistenDismiss.then((off) => off());
      void unlistenPttStart.then((off) => off());
      void unlistenPttEnd.then((off) => off());
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Fensterhöhe dem Inhalt anpassen (Rust begrenzt nach oben).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const report = () => void invoke("set_overlay_height", { height: stage.offsetHeight });
    const observer = new ResizeObserver(report);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Solange eine Antwort oder Meldung sichtbar ist, schließt ein Klick daneben nicht.
  useEffect(() => {
    void invoke("set_sticky", { sticky: view.kind === "answer" || view.kind === "error" });
  }, [view.kind]);

  // Nach jedem Wechsel zurück zur Eingabe den Fokus ins Feld setzen.
  useEffect(() => {
    if (view.kind === "input" || view.kind === "key") inputRef.current?.focus();
  }, [view.kind]);

  function setListeningBoth(value: boolean) {
    listeningRef.current = value;
    setListening(value);
  }

  function startListening() {
    stopVoice();
    setListeningBoth(true);
    recorder.current.start().catch((e) => {
      // Nur melden, wenn noch jemand zuhört (nicht nach kurzem Tippen).
      if (!listeningRef.current) return;
      setListeningBoth(false);
      setView({ kind: "error", message: e instanceof MicError ? e.message : String(e) });
    });
  }

  function stopListening() {
    recorder.current.cancel();
    setListeningBoth(false);
  }

  /** `send`: lang gehalten, Aufnahme abschicken. Sonst nur verwerfen. */
  async function endListening(send: boolean) {
    if (!listeningRef.current) return;
    if (!send) {
      stopListening();
      inputRef.current?.focus();
      return;
    }
    setListeningBoth(false);
    const recording = await recorder.current.stop();
    if (recording) void ask({ audio: recording });
    else setView({ kind: "error", message: "Es wurde nichts aufgenommen." });
  }

  function stopVoice() {
    session.current++;
    if (audio.current) {
      audio.current.pause();
      URL.revokeObjectURL(audio.current.src);
      audio.current = null;
    }
    setVoice("off");
  }

  async function speak(text: string) {
    stopVoice();
    const id = session.current;
    setVoice("loading");
    try {
      const wav = await invoke<ArrayBuffer>("speak", { text });
      if (id !== session.current) return;
      const player = new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
      player.onended = () => {
        if (audio.current === player) stopVoice();
      };
      audio.current = player;
      setVoice("playing");
      await player.play();
    } catch (e) {
      if (id !== session.current) return;
      // Vorlesen ist Zusatz: Fehler leise anzeigen, die Antwort bleibt stehen.
      console.error("Vorlesen fehlgeschlagen", e);
      setVoice("off");
    }
  }

  async function ask(question: Question) {
    stopVoice();
    const id = session.current;
    setView({ kind: "loading" });
    try {
      const answer = await invoke<Answer>(
        "ask",
        "text" in question
          ? { question: question.text, audio: null, audioMime: null }
          : { question: null, audio: Array.from(question.audio.bytes), audioMime: question.audio.mime },
      );
      if (id !== session.current) return;
      setView({ kind: "answer", answer });
      void speak(answer.needsClarification ?? answer.spoken);
    } catch (e) {
      if (id !== session.current) return;
      const err = e as AskError;
      if (err.kind === "cancelled") return;
      if (err.kind === "keyMissing" || err.kind === "keyInvalid") {
        pendingQuestion.current = question;
        setKeyText("");
        setView({ kind: "key", invalid: err.kind === "keyInvalid" });
        return;
      }
      setView({ kind: "error", message: errorMessage(err) });
    }
  }

  async function saveKey() {
    try {
      await invoke("save_api_key", { key: keyText });
    } catch (e) {
      setView({ kind: "error", message: String(e) });
      return;
    }
    setKeyText("");
    const question = pendingQuestion.current;
    pendingQuestion.current = null;
    if (question) void ask(question);
    else setView({ kind: "input" });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (view.kind === "loading") return;
    if (view.kind === "key") {
      if (keyText.trim()) void saveKey();
      return;
    }
    const question = text.trim();
    if (question) void ask({ text: question });
  }

  function toggleVoice() {
    if (view.kind !== "answer") return;
    if (voice === "off") void speak(view.answer.needsClarification ?? view.answer.spoken);
    else stopVoice();
  }

  const askingForKey = view.kind === "key";

  return (
    <main className="stage" ref={stageRef}>
      <form
        className="bar"
        data-phase={phase}
        data-error={error ? "" : undefined}
        data-busy={view.kind === "loading" ? "" : undefined}
        data-listening={listening ? "" : undefined}
        onSubmit={onSubmit}
      >
        <span className="orb" aria-hidden="true" />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : askingForKey ? (
          <input
            ref={inputRef}
            key="key"
            className="prompt"
            type="password"
            value={keyText}
            onChange={(e) => setKeyText(e.currentTarget.value)}
            placeholder="Gemini-API-Key einfügen, dann Enter"
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <input
            ref={inputRef}
            key="question"
            className="prompt"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder="Frag etwas …"
            spellCheck={false}
            autoComplete="off"
          />
        )}
        <button
          type="button"
          className="mic"
          title="Sprechen: Strg+Umschalt+Leertaste gedrückt halten (oder hier klicken)"
          aria-label={listening ? "Aufnahme senden" : "Aufnahme starten"}
          aria-pressed={listening}
          tabIndex={-1}
          // Fokus im Eingabefeld lassen.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (listening ? void endListening(true) : startListening())}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
          </svg>
        </button>
        <button
          type="button"
          className="hint"
          title="Schließen (Esc)"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void invoke("request_dismiss")}
        >
          Esc
        </button>
      </form>

      {!error && (listening || view.kind !== "input") && (
        <section
          className="panel"
          data-phase={phase}
          data-listening={listening ? "" : undefined}
          aria-live="polite"
        >
          {listening ? (
            <p className="status listening">
              <span className="rec-dot" aria-hidden="true" />
              Ich höre zu … loslassen zum Senden
            </p>
          ) : (
            <ViewContent view={view} voice={voice} onToggleVoice={toggleVoice} />
          )}
        </section>
      )}
    </main>
  );
}

function ViewContent({
  view,
  voice,
  onToggleVoice,
}: {
  view: View;
  voice: Voice;
  onToggleVoice: () => void;
}) {
  switch (view.kind) {
    case "loading":
      return (
        <p className="status">
          <span className="shimmer">Schaue mir das an …</span>
        </p>
      );
    case "key":
      return (
        <p className="status">
          {view.invalid
            ? "Der gespeicherte Key wird nicht akzeptiert. Füge einen gültigen Key ein."
            : "Einmalig: Füge deinen Gemini-API-Key ein. Er wird sicher in Windows gespeichert."}
        </p>
      );
    case "error":
      return (
        <p className="status status-error" role="alert">
          {view.message}
        </p>
      );
    case "answer":
      return (
        <>
          <VoiceButton voice={voice} onToggle={onToggleVoice} />
          <AnswerView answer={view.answer} />
        </>
      );
    default:
      return null;
  }
}

function VoiceButton({ voice, onToggle }: { voice: Voice; onToggle: () => void }) {
  const label = voice === "off" ? "Vorlesen" : "Vorlesen stoppen";
  return (
    <button
      type="button"
      className="voice"
      data-voice={voice}
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" />
        {voice === "off" ? (
          <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
        ) : (
          <path d="M16 9.5l5 5M21 9.5l-5 5" />
        )}
      </svg>
    </button>
  );
}

function AnswerView({ answer }: { answer: Answer }) {
  if (answer.needsClarification) {
    return <p className="clarify">{answer.needsClarification}</p>;
  }
  return (
    <div className="answer">
      <p className="spoken">{answer.spoken}</p>
      {answer.steps.length > 0 && (
        <ol className="steps">
          {answer.steps.map((step, i) => (
            <li key={i}>
              <MathText text={step} />
            </li>
          ))}
        </ol>
      )}
      {answer.formulas.length > 0 && (
        <div className="formulas">
          {answer.formulas.map((formula, i) => (
            <Formula key={i} tex={formula} />
          ))}
        </div>
      )}
      {answer.plot && <Plot {...answer.plot} />}
    </div>
  );
}

export default App;
