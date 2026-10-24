// API spike: checks whether the Gemini API (free tier) accepts a screenshot plus a
// question, returns the answer format from docs/DESIGN.md, and can do German TTS.
// Not app code. No dependencies, only Node's built-in fetch.
//
// Run from the project folder:
//   node --env-file=.env spikes/api/spike.mjs [answer-model] [tts-model]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const inputDir = path.join(here, "input");
const outputDir = path.join(here, "output");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = process.argv[2] ?? "gemini-3.8-flash";
const TTS_MODEL = process.argv[3] ?? "gemini-3.8-flash-tts";
const TTS_VOICE = "Kore";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY is missing. Run with `node --env-file=.env ...`.");
  process.exit(1);
}

const SYSTEM = `You are a tutor for math exercise sheets. You get a screenshot and a
question. Answer in the language of the question (e.g. German or English).
Rules:
- "spoken" is the text that will be read aloud. Write formulas in words, never LaTeX.
- "steps" are short bullet points for the solution. Formulas in them go in $...$ (LaTeX).
- "formulas" are the key formulas as LaTeX (KaTeX-compatible).
- "plot" only if a plot is requested or clearly helps. "expr" must be parseable by
  mathjs and use x as the variable. You do not draw anything yourself.
- If it is unclear which exercise is meant, or something is unreadable, set
  "needsClarification" to a short follow-up question, otherwise null.`;

const SCHEMA = {
  type: "object",
  properties: {
    spoken: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    formulas: { type: "array", items: { type: "string" } },
    plot: {
      type: ["object", "null"],
      properties: {
        expr: { type: "string" },
        xMin: { type: "number" },
        xMax: { type: "number" },
        label: { type: "string" },
      },
      required: ["expr", "xMin", "xMax", "label"],
    },
    needsClarification: { type: ["string", "null"] },
  },
  required: ["spoken", "steps", "formulas", "plot", "needsClarification"],
};

// On 503 (model overloaded), up to three attempts with a short pause.
async function call(body) {
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const text = await res.text();
    if (res.status === 503 && attempt < 3) {
      console.log(`503 overloaded (attempt ${attempt}), retrying in ${attempt * 3} s`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} after ${seconds} s: ${text.slice(0, 800)}`);
    }
    return { json: JSON.parse(text), seconds, attempt };
  }
}

function outputBlocks(interaction, type) {
  return (interaction.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === type);
}

function checkShape(answer) {
  const problems = [];
  if (typeof answer.spoken !== "string") problems.push("spoken missing");
  if (/\\[a-z]+|\$/.test(answer.spoken ?? "")) problems.push("spoken contains LaTeX");
  if (!Array.isArray(answer.steps)) problems.push("steps missing");
  if (!Array.isArray(answer.formulas)) problems.push("formulas missing");
  if (!("plot" in answer)) problems.push("plot missing");
  if (!("needsClarification" in answer)) problems.push("needsClarification missing");
  return problems;
}

async function ask(name, question, image) {
  const { json, seconds } = await call({
    model: MODEL,
    system_instruction: SYSTEM,
    input: [
      { type: "text", text: question },
      { type: "image", data: image, mime_type: "image/png" },
    ],
    response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
    store: false,
  });
  await writeFile(path.join(outputDir, `${name}.raw.json`), JSON.stringify(json, null, 2));
  const text = outputBlocks(json, "text").map((c) => c.text).join("");
  const answer = JSON.parse(text);
  await writeFile(path.join(outputDir, `${name}.json`), JSON.stringify(answer, null, 2));
  return { answer, seconds, usage: json.usage };
}

async function speak(name, text) {
  const { json, seconds } = await call({
    model: TTS_MODEL,
    input: [{ type: "user_input", content: [{ type: "text", text }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice: TTS_VOICE }] },
    store: false,
  });
  const audio = outputBlocks(json, "audio").at(-1);
  if (!audio?.data) throw new Error("No audio in the response");
  const file = path.join(outputDir, `${name}.wav`);
  await writeFile(file, Buffer.from(audio.data, "base64"));
  return { file, seconds, mime: audio.mime_type };
}

async function run(label, fn) {
  console.log(`\n=== ${label} ===`);
  try {
    return await fn();
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return null;
  }
}

await mkdir(outputDir, { recursive: true });
const image = (await readFile(path.join(inputDir, "sheet.png"))).toString("base64");
console.log(`Answer model: ${MODEL}, TTS model: ${TTS_MODEL} (voice ${TTS_VOICE})`);

// One German and one English question, to check language detection.
const results = {};
for (const [name, question] of [
  ["test1_de_1b", "Erkläre mir Aufgabe 1b"],
  ["test2_en_1a", "Plot the function in 1a"],
]) {
  results[name] = await run(`${name}: "${question}"`, async () => {
    const r = await ask(name, question, image);
    const problems = checkShape(r.answer);
    console.log(`OK in ${r.seconds} s`);
    console.log(`Format: ${problems.length ? problems.join(", ") : "ok"}`);
    if (r.usage) console.log(`Tokens: ${JSON.stringify(r.usage)}`);
    console.log(JSON.stringify(r.answer, null, 2));
    return r;
  });
}

const spoken = results.test1_de_1b?.answer?.spoken;
await run("test3_tts: spoken text from test 1", async () => {
  if (!spoken) throw new Error("Skipped, test 1 returned no text");
  const r = await speak("test3_tts", spoken);
  console.log(`OK in ${r.seconds} s, ${r.mime ?? "unknown format"}`);
  console.log(`Saved: ${r.file}`);
});
