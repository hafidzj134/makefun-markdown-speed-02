// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` (Node 22, erasable TypeScript).
// It loads every case from cases.json in the input directory, renders each
// case's Markdown through parse() from ./parse.js, and writes the HTML
// strings — one per case, in input order — as a JSON array to html.json in
// the output directory. Outside the sandbox the MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR environment variables override /input and /output so
// the same driver can be exercised locally.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

type Case = { id: string; markdown: string };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw = readFileSync(join(inputDir, "cases.json"), "utf8");
const cases = JSON.parse(raw) as Case[];

const html = new Array<string>(cases.length);
for (let k = 0; k < cases.length; k++) {
  html[k] = parse(cases[k].markdown);
}
if (html.length !== cases.length) {
  throw new Error(`rendered ${html.length} of ${cases.length} cases`);
}

// The output directory exists in the sandbox, but a local run may point
// MAKEFUN_OUTPUT_DIR at a fresh path.
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
