/** Must match `gemini::AskError` in Rust. */
export type AskError =
  | { kind: "keyMissing" | "keyInvalid" | "rateLimited" | "overloaded" | "offline" | "cancelled" }
  | { kind: "failed"; message: string };

export function errorMessage(error: AskError): string {
  switch (error.kind) {
    case "keyMissing":
      return "No API key saved yet.";
    case "keyInvalid":
      return "The saved key was rejected. Paste a valid key.";
    case "rateLimited":
      return "Free quota reached. Wait a minute and try again.";
    case "overloaded":
      return "Gemini is overloaded right now. Try again in a moment.";
    case "offline":
      return "Can't reach Gemini. Are you online?";
    case "failed":
      return `Something went wrong: ${error.message}`;
    default:
      return "Something went wrong.";
  }
}
