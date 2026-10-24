import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

function render(tex: string, displayMode: boolean): string {
  // Don't crash on broken LaTeX, show the source in a muted color instead.
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    errorColor: "#9a9aa6",
    strict: "ignore",
  });
}

/** A formula on its own line. */
export function Formula({ tex }: { tex: string }) {
  const html = useMemo(() => render(tex, true), [tex]);
  return <div className="formula" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Text with inline formulas in `$...$`. */
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
