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

Stand 2026-10-21: Abend 0 bis 2 erledigt. Fenster-Spike fertig (Tag `spike-fenster`)
und erweitert: Overlay (440 px breit) per Strg+Umschalt+Leertaste ein- und
ausblenden, oben rechts angedockt auf dem Monitor mit dem Mauszeiger, Ein- und
Ausblend-Animation, Esc und Fokusverlust schließen. Tray-Icon mit Menü (Öffnen,
Mit Windows starten, Beenden), nur eine laufende Instanz. Mikrofon-Symbol in der
Leiste, bisher nur Optik. Installer als NSIS. Der Shortcut reagiert bisher nur auf
"gedrückt"; Push-to-talk ("losgelassen") fehlt noch.
Offen: `.env` mit Gemini-Key, API-Spike (Abend 3). Siehe WOCHE-1-CHECKLISTE.md.

## Entscheidungslog

(Datum, Entscheidung, Grund)

- 2026-10-14, Gemini API (Gratis-Kontingent) als Anbieter, hinter einem Interface
  austauschbar. Grund: einzige Option ohne laufende Kosten, die Bild und Audio in
  einem Aufruf annimmt. Ob Bild und Audio im Gratis-Tarif wirklich funktionieren und
  wie gut Formeln gelesen werden, klärt der API-Spike (Abend 3).
- 2026-10-14, Startkandidaten laut Preisseite (Gratis-Tarif): Antwortmodell
  Gemini 3.8 Flash, Gegenprobe 3.6 Flash. TTS: Gemini 3.8 Flash TTS
  (`gemini-3.8-flash-tts`, Deutsch unterstützt, 30 feste Stimmen, WAV 24 kHz mono),
  Fallback Windows-Stimme. Modellnamen kommen in die Einstellungen, nicht in den Code.
- 2026-10-14, API-Hinweis: Aufruf über `v1beta/interactions` mit Header
  `x-goog-api-key` (neueres Format, nicht `generateContent`); SDK-Mindestversionen
  Python `google-genai` >= 2.25.0, JS `@google/genai` >= 2.24.0. Vor der Umsetzung
  gegen die aktuelle Doku prüfen. Gratis-Limits stehen nicht in der Doku, nur in
  AI Studio; zu Beginn von Abend 3 dort nachsehen.
- 2026-10-14, Datenschutz: Im Gratis-Tarif nutzt Google Inhalte zur
  Produktverbesserung. Deshalb nur Übungsmaterial senden, nie private Fenster.
  Persönliches Google-Konto für den Key, kein Uni-Konto.
- 2026-10-14, Windows Terminal statt alter cmd nutzen (Logo und eingefügte Links
  wurden in der alten Konsole als Fragezeichen dargestellt).
- 2026-10-19, Overlay oben rechts andocken statt mittig, Leiste schmaler (440 px).
  Grund: verdeckt das Übungsblatt nicht.
- 2026-10-19, Tray-Icon mit Menü. Linksklick blendet immer ein statt umzuschalten,
  weil der Klick aufs Tray dem Overlay den Fokus nimmt.
- 2026-10-19, Neue Abhängigkeiten `tauri-plugin-autostart` (Haken "Mit Windows
  starten", standardmäßig aus) und `tauri-plugin-single-instance` (ein zweiter Start
  blendet das Overlay der laufenden App ein, statt am belegten Shortcut zu scheitern).
- 2026-10-20, Installer nur als NSIS, kein MSI. Grund: spart den WiX-Download,
  ein Installer reicht.
