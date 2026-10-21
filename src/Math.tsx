import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

function render(tex: string, displayMode: boolean): string {
  // Kaputtes LaTeX nicht abstürzen lassen, sondern rot als Quelltext zeigen.
  return katex.renderToString(tex, { displayMode, throwOnError: false, strict: "ignore" });
}

/** Eine Formel als eigene Zeile. */
export function Formula({ tex }: { tex: string }) {
  const html = useMemo(() => render(tex, true), [tex]);
  return <div className="formula" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Text mit eingebetteten Formeln in `$...$`. */
export function MathText({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(\$[^$]+\$)/g), [text]);
  return (
    <>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith("$") && part.endsWith("$") ? (
          <span key={i} dangerouslySetInnerHTML={{ __html: render(part.slice(1, -1), false) }} />
        ) : (
          part
        ),
      )}
    </>
  );
}
