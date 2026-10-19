import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

/** Muss zur Dauer der Ausblend-Transition in App.css passen. */
const EXIT_MS = 120;

type Phase = "in" | "out";

function App() {
  const [phase, setPhase] = useState<Phase>("out");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);

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
      setPhase("in");
      focusInput();
    };

    const exit = () => {
      setPhase("out");
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        void invoke("hide_overlay");
      }, EXIT_MS);
    };

    const unlistenShow = listen("overlay-show", enter);
    const unlistenDismiss = listen("overlay-dismiss", exit);

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
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <main className="stage">
      <div className="bar" data-phase={phase} data-error={error ? "" : undefined}>
        <span className="orb" aria-hidden="true" />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <input
            ref={inputRef}
            className="prompt"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder="Frag etwas …"
            spellCheck={false}
            autoComplete="off"
          />
        )}
        <kbd className="hint">Esc</kbd>
      </div>
    </main>
  );
}

export default App;
