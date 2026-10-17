#!/usr/bin/env node
// Turns a recorded `claude -p --output-format stream-json` run into a small, shareable test fixture
// (tests/fixtures/stream/*.jsonl): image data and thinking dropped, tool result text cut to 4 KB,
// home and temp paths replaced by /HOME, emails removed, and the init line's slash command, skill and
// agent lists emptied. To stay under 400 KB it also drops what the app never reads: the duplicate
// `wire_tool_inputs`, the duplicate `tool_use_result.content` text, runs of `thinking_tokens` lines
// (the last of each run is kept), the list of dropped thinking blocks, and the tail of very large tool
// inputs and structured results.
//
//   node scripts/scrub-stream.mjs <recorded.jsonl> <fixture.jsonl>
//
// Lines can be several MB (base64 images), so the input is read line by line, never whole.
import { createReadStream, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const TEXT_MAX = 4096;
/** Tool inputs and structured results larger than this keep only their first items and short strings. */
const LARGE = 6000;
const STRING_KEEP = 400;
/** Ever tighter [items kept per array, characters kept per string, depth] until a value fits LARGE. */
const STEPS = [[16, 400, 8], [8, 200, 6], [4, 120, 4], [2, 80, 3]];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATHS = [
  // Claude Code scratchpads and other session temp folders.
  [/(?:\/private)?\/tmp\/claude-\d+\/[^/"\\\s]+\/[0-9a-f-]{36}\/scratchpad/g, "/HOME"],
  [/(?:\/private)?\/var\/folders\/[^/"\\\s]+\/[^/"\\\s]+\/T/g, "/HOME/tmp"],
  [/(?<![\w.-])(?:\/private)?\/tmp\//g, "/HOME/tmp/"],
  [new RegExp(escape(homedir()), "g"), "/HOME"],
  // The same home inside Claude Code's dash-encoded project keys.
  [new RegExp(escape(homedir().replace(/\//g, "-")), "g"), "-HOME"],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const cut = (s, max = TEXT_MAX) => (typeof s === "string" && s.length > max ? s.slice(0, max) : s);

/** Empties image data and thinking, and cuts text blocks; walks the whole value. */
function scrubBlocks(v) {
  if (Array.isArray(v)) return v.map(scrubBlocks);
  if (!v || typeof v !== "object") return v;
  if (v.type === "image") return { type: "image", source: { type: v.source?.type ?? "base64", media_type: v.source?.media_type ?? "image/jpeg", data: "" } };
  if (v.type === "thinking") return { type: "thinking", thinking: "", signature: "" };
  if (v.type === "redacted_thinking") return { type: "redacted_thinking", data: "" };
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = scrubBlocks(x);
  if (out.type === "text" && typeof out.text === "string") out.text = cut(out.text);
  if (out.type === "tool_result" && typeof out.content === "string") out.content = cut(out.content);
  if (out.type === "tool_use" && out.input) out.input = fit(out.input);
  return out;
}

/** Keeps a large value's shape: arrays keep their first items, strings their start, deep values a marker. */
function shorten(v, [items, chars, depth]) {
  if (typeof v === "string") return cut(v, chars);
  if (!v || typeof v !== "object") return v;
  if (depth <= 0) return "…";
  const next = [items, chars, depth - 1];
  if (Array.isArray(v)) return v.slice(0, items).map((x) => shorten(x, next));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x, next)]));
}

function fit(v) {
  if (JSON.stringify(v).length <= LARGE) return v;
  let out = v;
  for (const step of STEPS) {
    out = shorten(v, step);
    if (JSON.stringify(out).length <= LARGE) break;
  }
  return out;
}

function scrubToolUseResult(r) {
  if (typeof r === "string") return cut(r);
  if (Array.isArray(r)) return scrubBlocks(r);
  if (!r || typeof r !== "object") return r;
  const out = { ...r };
  // The same text is in the message's tool_result block.
  if (typeof out.content === "string") out.content = cut(out.content, STRING_KEEP);
  else if (out.content !== undefined) out.content = scrubBlocks(out.content);
  if (out.structuredContent) out.structuredContent = fit(out.structuredContent);
  return out;
}

function scrubLine(o) {
  if (o.type === "system" && o.subtype === "init") {
    for (const k of ["slash_commands", "skills", "agents"]) if (k in o) o[k] = [];
  }
  if (o.message) {
    o.message = scrubBlocks(o.message);
    // Lists of dropped thinking blocks: thinking again, and large.
    if (Array.isArray(o.message.input_transformations)) o.message.input_transformations = [];
  }
  if ("tool_use_result" in o) o.tool_use_result = scrubToolUseResult(o.tool_use_result);
  delete o.wire_tool_inputs;
  let text = JSON.stringify(o);
  for (const [re, to] of PATHS) text = text.replace(re, to);
  return text.replace(EMAIL, "");
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write("usage: node scripts/scrub-stream.mjs <recorded.jsonl> <fixture.jsonl>\n");
    process.exit(1);
  }
  const out = createWriteStream(output);
  let lines = 0;
  let bytes = 0;
  /** A thinking_tokens line waiting to see whether the next line is another one. */
  let thinking;
  const write = (s) => {
    out.write(`${s}\n`);
    lines++;
    bytes += Buffer.byteLength(s) + 1;
  };
  for await (const line of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      if (line.length <= TEXT_MAX) write(line);
      continue;
    }
    if (o.type === "system" && o.subtype === "thinking_tokens") {
      thinking = scrubLine(o);
      continue;
    }
    if (thinking) write(thinking);
    thinking = undefined;
    write(scrubLine(o));
  }
  if (thinking) write(thinking);
  await new Promise((r) => out.end(r));
  process.stdout.write(`${output}: ${lines} lines, ${(bytes / 1024).toFixed(0)} KB\n`);
}

await main();
