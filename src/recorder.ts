/**
 * Mikrofonaufnahme für Push-to-talk. Das Mikrofon ist nur offen, solange
 * aufgenommen wird; danach wird es sofort freigegeben (Windows-Indikator geht aus).
 */

const MIME = "audio/webm;codecs=opus";

export type Recording = { bytes: Uint8Array; mime: string };

export class MicError extends Error {}

export class Recorder {
  private starting: Promise<MediaRecorder> | null = null;
  private chunks: Blob[] = [];

  get active(): boolean {
    return this.starting !== null;
  }

  /** Aufnahme starten. Wirft `MicError` mit lesbarer Meldung. */
  start(): Promise<void> {
    this.cancel();
    this.chunks = [];
    const starting = (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (e) {
        const name = (e as DOMException).name;
        if (name === "NotAllowedError") {
          throw new MicError(
            "Microphone blocked. Windows Settings > Privacy > Microphone: allow desktop apps to access your microphone.",
          );
        }
        if (name === "NotFoundError") throw new MicError("No microphone found.");
        throw new MicError(`Microphone unavailable (${name}).`);
      }
      const recorder = new MediaRecorder(stream, { mimeType: MIME });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      recorder.onstop = () => stream.getTracks().forEach((t) => t.stop());
      recorder.start();
      return recorder;
    })();
    this.starting = starting;
    // Wurde während des Startens abgebrochen, Mikrofon gleich wieder schließen.
    starting.then(
      (recorder) => {
        if (this.starting !== starting) recorder.stop();
      },
      () => {
        if (this.starting === starting) this.starting = null;
      },
    );
    return starting.then(() => undefined);
  }

  /** Aufnahme beenden und zurückgeben. `null`, wenn nichts aufgenommen wurde. */
  async stop(): Promise<Recording | null> {
    const starting = this.starting;
    this.starting = null;
    if (!starting) return null;
    let recorder: MediaRecorder;
    try {
      recorder = await starting;
    } catch {
      return null;
    }
    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
    const blob = new Blob(this.chunks, { type: MIME });
    this.chunks = [];
    if (blob.size === 0) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "audio/webm" };
  }

  /** Aufnahme verwerfen. */
  cancel(): void {
    const starting = this.starting;
    this.starting = null;
    this.chunks = [];
    starting?.then(
      (recorder) => {
        if (recorder.state !== "inactive") recorder.stop();
      },
      () => {},
    );
  }
}
