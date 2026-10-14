# Woche 1: Fundament und die beiden größten Risiken

Ziel am Ende der Woche: Ein Overlay erscheint per Shortcut, und du weißt
sicher, dass das kostenlose Modell Bild und Audio verarbeitet. Wenn eines von
beidem nicht klappt, erfährst du es jetzt und nicht in Woche 4.

Zeitbedarf: etwa 4 Abende à 1 bis 3 Stunden.

## Abend 0: Werkzeuge (falls noch nicht erledigt)

PowerShell öffnen und ausführen (bei Fehlern die Programme von den Websites laden):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Microsoft.VisualStudioCode
winget install GitHub.cli
```

PowerShell schließen und neu öffnen, dann prüfen:

```powershell
node -v
rustc -V
cargo -V
git --version
```

- [ ] Alle vier Befehle zeigen eine Version an.

## Abend 1: Projekt, Git, Claude Code

- [ ] Projekt anlegen:
  ```powershell
  cd $HOME
  mkdir dev
  cd dev
  npm create tauri-app@latest
  ```
  Antworten: Name `malum`, Identifier `com.deinname.malum`, TypeScript, npm, React, TypeScript.
- [ ] `cd malum`, `npm install`, `npm run tauri dev`. Das erste Kompilieren dauert einige Minuten.
- [ ] Git und GitHub:
  ```powershell
  git config --global user.name "Dein Name"
  git config --global user.email "deine@mail.de"
  git init
  git add .
  git commit -m "Initial Tauri + React scaffold"
  gh auth login
  gh repo create malum --private --source=. --remote=origin --push
  ```
- [ ] `PROJECT.md` in den Projektordner legen und committen.
- [ ] Eine Datei `CLAUDE.md` mit diesem Inhalt anlegen und committen:
  ```
  Lies vor jeder Aufgabe PROJECT.md im Projektordner und halte dich an die Regeln dort.
  ```
- [ ] Claude Code nach der offiziellen Anleitung installieren (docs.claude.com),
  im Projektordner mit `claude` starten.
- [ ] API-Key holen: In Google AI Studio einen Gemini-API-Key erzeugen (kostenlos).
  Den Key in einer Datei `.env` im Projektordner ablegen. Prüfe vorher, dass
  `.env` in der `.gitignore` steht.

## Abend 2: Fenster-Spike

Ziel: Overlay per Shortcut, mittig, transparent, mit Fokus. Noch keine KI.

Prompt an Claude Code:

```
Lies PROJECT.md. Aufgabe: Spike für das Overlay-Fenster.
Ein rahmenloses, transparentes Fenster (ca. 680x72, später größer), das per
globalem Shortcut Strg+Umschalt+Leertaste ein- und ausgeblendet wird.
Es erscheint mittig auf dem Monitor mit dem Mauszeiger, hat sofort Fokus im
Textfeld und verschwindet mit Esc oder bei Fokusverlust. Immer im Vordergrund,
nicht in der Taskleiste.
Nicht ändern: nichts sonst, noch keine KI-Anbindung.
Mach zuerst einen Plan mit Dateien, Schritten, nötigen Plugins und
Berechtigungen (Tauri 2, nach aktueller Doku, nichts raten). Warte auf mein OK.
```

- [ ] 20-mal Shortcut, kurz tippen, Esc. Kein Flackern, kein Fokusverlust, kein Absturz.
- [ ] Commit und Tag: `git tag spike-fenster`.

## Abend 3: API-Spike (das größte Risiko)

Ziel: Prüfen, ob das kostenlose Kontingent Bild und Audio annimmt und ob das
Antwortformat aus PROJECT.md zuverlässig kommt. Noch nicht in der App.

Prompt an Claude Code:

```
Lies PROJECT.md. Aufgabe: Ein eigenständiges Testskript (kein App-Code),
das mit dem Key aus .env die Gemini-API aufruft. Nach aktueller Doku.
Test 1: Screenshot-Datei (PNG) und die Frage "Erkläre Aufgabe 1b" senden,
Antwort im JSON-Format aus PROJECT.md zurückbekommen.
Test 2: Zusätzlich eine kurze Audioaufnahme (WAV) mit derselben Frage senden.
Test 3: Anbieter-TTS testen: gesprochener Text aus Test 1, deutsche Stimme.
Gib mir pro Test aus: Erfolg oder Fehlermeldung, Dauer, und welches Modell
du genutzt hast. Wähle das Modell aus der aktuellen Preisseite: eines mit
kostenlosem Kontingent, das Bild und Audio unterstützt. Mach zuerst einen Plan.
```

Dein Testmaterial:
- [ ] Ein Screenshot deines Übungsblatts (PDF-Fenster) als PNG.
- [ ] Eine kurze WAV-Aufnahme: "Erkläre mir Aufgabe 1b". Dazu eine englische: "Plot the function in 1a".
- [ ] Notiere: Wird die Aufgabe richtig erkannt? Wird die Funktion in 1a richtig gelesen?
- [ ] Notiere die Dauer pro Anfrage und mögliche Limit-Fehlermeldungen.

Entscheidung am Ende des Abends:
- Alles klappt: weiter mit Woche 2 (Screenshot, Aufnahme und Antwort in die App).
- Audio im kostenlosen Tarif geht nicht: Transkription separat lösen (wir besprechen Optionen).
- Bild wird schlecht gelesen: Ausschnitt-Auswahl und Vergrößern früher einplanen.

## Abschluss Woche 1

- [ ] Overlay erscheint und verschwindet zuverlässig.
- [ ] Bild plus Frage ergibt eine brauchbare strukturierte Antwort.
- [ ] Audio plus Bild funktioniert oder ist als Problem benannt.
- [ ] Alles committet, `PROJECT.md` Abschnitt "Stand" aktualisiert, Entscheidungslog gefüllt.

Wenn du hängst: schick mir die vollständige Fehlermeldung und deinen Schritt.
