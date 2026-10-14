# malum

Arbeitstitel. Name vorläufig, Verfügbarkeit (Domain, GitHub, Marke) nicht geprüft.

## Vision

Ein Overlay für Windows: Shortcut halten, "Erkläre mir Aufgabe 1b" oder
"plot the function in 1a" sagen, loslassen. Die App schaut auf das gewählte
Fenster (zum Beispiel ein PDF-Übungsblatt), erklärt per Stimme und zeigt
wichtige Formeln zusätzlich als LaTeX. Funktionen werden lokal geplottet.
Qualität vor Umfang. Es soll optisch sehr hübsch und smooth sein.

## Kernablauf

1. Shortcut halten: Overlay erscheint, Aufnahme läuft.
2. Loslassen: Screenshot (aktives Fenster) und Audio gehen ans Modell.
3. Antwort kommt als JSON (siehe unten): Text, Formeln (KaTeX), optional Plot.
   Der gesprochene Text wird per TTS vorgelesen.
4. Rückfragen im selben Gespräch per Sprache oder Text. Esc schließt.

## Getroffene Entscheidungen

- Plattform: Windows 11, Tauri 2, React + TypeScript (strict), Tailwind, Motion.
- Mathe-Darstellung: KaTeX. Ausdrücke parsen: mathjs. Plot-Bibliothek: zum
  Beispiel function-plot (vor der Wahl in der Doku prüfen).
- Sprachen: Deutsch und Englisch, das Modell erkennt die Sprache selbst.
- Sprachsteuerung: Push-to-talk. Halten = aufnehmen und senden beim Loslassen.
  Ein kurzer Tipp (unter etwa 300 ms) öffnet nur das Overlay zum Tippen.
  Standard-Shortcut: Strg+Umschalt+Leertaste (nicht Alt+Leertaste, das ist
  das Windows-Systemmenü).
- KI-Anbieter: Gemini API mit kostenlosem Kontingent, hinter einem Interface
  austauschbar. Modellname steht in den Einstellungen, nicht fest im Code.
  Wichtig: Im kostenlosen Tarif nutzt der Anbieter Inhalte zur Produktverbesserung.
  Deshalb nur Übungsmaterial aufnehmen, nie private Fenster.
- Stimme: zuerst die TTS des Anbieters, wenn sie kostenlos und gut genug ist,
  sonst Windows-Stimme als Fallback. Austauschbar hinter einem Interface.
- Keine laufenden Kosten, kein Hosting, kein lokales Modell.
- Entwicklung mit Claude Code lokal im Projektordner. Git von Tag 1.

## Antwortformat (Modell an App)

Das Modell liefert strukturiertes JSON (JSON-Modus des Anbieters nutzen,
Doku prüfen):

```json
{
  "spoken": "Hier nutzt du die Produktregel: erst u mal v Strich ...",
  "steps": ["Produktregel anwenden", "u und v bestimmen"],
  "formulas": ["f'(x) = 2x\\sin x + x^2\\cos x"],
  "plot": null,
  "needsClarification": null
}
```

Plot-Beispiel: `"plot": {"expr": "x^2*sin(x)", "xMin": -5, "xMax": 5, "label": "f(x) aus 1a"}`

Regeln:
- `spoken` enthält Formeln in Worten, nie LaTeX, sonst liest die Stimme Zeichen vor.
- `plot.expr` muss mathjs-parsebar sein. Die App zeichnet selbst, das Modell malt nicht.
- Bei Unsicherheit (welche Aufgabe? Funktion nicht lesbar?) setzt das Modell
  `needsClarification` mit einer kurzen Rückfrage.

## Datenschutz und Sicherheit

- Aufnahme nur vom aktiven Fenster oder einem gewählten Bereich, nie der ganze Bildschirm.
- Kleine Vorschau des Screenshots vor dem Senden (in den Einstellungen abschaltbar).
- Sichtbarer Aufnahme-Indikator, solange Mikrofon oder Aufnahme aktiv ist.
- Screenshots und Audio werden nicht auf der Festplatte gespeichert.
- API-Key liegt im Windows-Anmeldeinformationsspeicher (Rust-Seite), nie im
  Frontend, nie im Repo. `.env` steht in `.gitignore`.
- Screenshots vor dem Senden verkleinern (zum Beispiel höchstens 1600 px Breite),
  das spart Zeit und Kontingent.

## Scope v1

Overlay mit Shortcut, Push-to-talk, Screenshot, Erklärung, Formeln, Plot,
Stimme, Gesprächsverlauf pro Sitzung, Einstellungen (Key, Modell, Stimme, Shortcut).

## Später (optional)

Ergebnisse mit einem Algebra-System nachrechnen und Unsicherheit markieren,
Hilfe für Tabellen (Simplex), Verlauf speichern.

## Nicht-Liste

Accounts, Cloud-Sync, Mobile, Aktivierungswort (Dauer-Zuhören), lokales Modell,
Plugin-System.

## Regeln für Claude Code

- Erst einen Plan (Dateien, Schritte, Risiken), dann auf mein OK warten, dann Code.
- Tauri-2-, Plugin- und API-Details nur nach aktueller Doku, nichts raten.
- Keine neue Abhängigkeit ohne Rückfrage und kurze Begründung.
- Ein Feature pro Aufgabe, kleine Commits, vor größeren Eingriffen committen.
- Keys nie in Code, Logs oder Repo.
- Jede Animation ist unterbrechbar. Esc bricht alles ab (Aufnahme, Wiedergabe, Anfrage).
- Fehlerzustände immer sichtbar: kein Netz, Key fehlt, Limit erreicht, Mikrofon verweigert.
- Nach jeder Änderung: Test in drei Schritten nennen, den ich selbst ausführen kann.

## Stand

Nichts gebaut. Nächster Schritt: siehe WOCHE-1-CHECKLISTE.md.

## Entscheidungslog

(Datum, Entscheidung, Grund)
