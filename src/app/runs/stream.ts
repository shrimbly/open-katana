import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Parses the director's stream-json output (spec §9.7). Pure apart from the tailer at the end. The
 * parser keeps only what the app shows or decides on: image data is dropped at once and tool text is
 * trimmed, so a 50 MB stream of base64 frames becomes a few KB of events.
 */

const TEXT_MAX = 4096;
const TOOL_PREFIX = "mcp__open-katana__";

/** Tokens of one assistant message, as the CLI reports them in its `usage`. */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes by lifetime (5-minute and 1-hour writes are priced differently). */
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export type StreamEvent = (
  | { type: "attempt"; attempt: number }
  | { type: "init"; sessionId: string; mcpServers: { name: string; status: string }[]; tools: string[]; plugins: string[]; model?: string }
  | { type: "hook" }
  | { type: "activity" }
  | { type: "say"; text: string }
  | { type: "tool"; id: string; name: string; tool?: string; input: Record<string, unknown> }
  | { type: "toolError"; id: string; text: string }
  | { type: "toolOk"; id: string; text: string; structured?: Record<string, unknown> }
  | { type: "heartbeat"; tool?: string; elapsedSec?: number }
  | { type: "rateLimit"; status: string; fiveHour?: number; sevenDay?: number; resetsAt?: string }
  | { type: "usage"; id: string; model?: string; usage: MessageUsage }
  | {
      type: "result";
      subtype: string;
      isError: boolean;
      costUsd?: number;
      durationMs?: number;
      turns?: number;
      text: string;
      /** The API error that ended the turn (`usage_limit_reached`, `invalid_credential_header`…) and its HTTP status. */
      apiError?: string;
      apiErrorStatus?: number;
      terminalReason?: string;
    }
) & {
  /** When the line was written (ms), from its own `timestamp` (or the marker's `at`); absent on lines without one. */
  at?: number;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const trim = (s: string) => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s);

/** Epoch seconds (the CLI's unit) or an ISO string, as ISO. */
function isoTime(v: unknown): string | undefined {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  return str(v);
}

/** The text of a tool result: a string, or its text blocks joined (images and everything else dropped). */
function resultText(content: unknown): string {
  if (typeof content === "string") return trim(content);
  if (!Array.isArray(content)) return "";
  return trim(
    content
      .map((b) => obj(b))
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b!.text as string)
      .join("\n"),
  );
}

/** Milliseconds of an ISO time or epoch value, or undefined. */
function lineTime(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Plugins the CLI always loads itself (path "builtin", source "<name>@builtin"): not the person's. */
const builtinPlugin = (p: Json | undefined) => p?.path === "builtin" || /@builtin$/.test(str(p?.source) ?? "");

function usageOf(u: Json | undefined): MessageUsage | undefined {
  if (!u) return undefined;
  const creation = obj(u.cache_creation);
  const write = num(u.cache_creation_input_tokens) ?? 0;
  const write1h = num(creation?.ephemeral_1h_input_tokens) ?? 0;
  const write5m = num(creation?.ephemeral_5m_input_tokens) ?? Math.max(0, write - write1h);
  return { input: num(u.input_tokens) ?? 0, output: num(u.output_tokens) ?? 0, cacheRead: num(u.cache_read_input_tokens) ?? 0, cacheWrite5m: write5m, cacheWrite1h: write1h };
}

/**
 * One stream line → its events (a message can hold several blocks). Null when the line is not JSON;
 * an empty list when it is JSON the app ignores. Each event carries the line's own time when it has one.
 */
export function parseLine(line: string): StreamEvent[] | null {
  let d: Json;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!obj(parsed)) return null;
    d = parsed as Json;
  } catch {
    return null;
  }
  const events = parseEvents(d);
  const at = lineTime(d.type === "katana_app" ? d.at : d.timestamp);
  return at === undefined ? events : events.map((e) => ({ ...e, at }));
}

function parseEvents(d: Json): StreamEvent[] {
  switch (d.type) {
    case "katana_app":
      return [{ type: "attempt", attempt: num(d.attempt) ?? 0 }];
    case "system": {
      if (d.subtype === "init") {
        const servers = (Array.isArray(d.mcp_servers) ? d.mcp_servers : []).map((s) => obj(s)).filter(Boolean) as Json[];
        const plugins = (Array.isArray(d.plugins) ? d.plugins : []).filter((p) => !builtinPlugin(obj(p))).map((p) => str(obj(p)?.name) ?? str(p) ?? "plugin");
        return [
          {
            type: "init",
            sessionId: str(d.session_id) ?? "",
            mcpServers: servers.map((s) => ({ name: str(s.name) ?? "", status: str(s.status) ?? "" })),
            tools: (Array.isArray(d.tools) ? d.tools : []).filter((t): t is string => typeof t === "string"),
            plugins,
            model: str(d.model),
          },
        ];
      }
      if (d.subtype === "hook_started" || d.subtype === "hook_response") return [{ type: "hook" }];
      return [{ type: "activity" }];
    }
    case "assistant": {
      const message = obj(d.message);
      const content = message?.content;
      const out: StreamEvent[] = [];
      for (const b of Array.isArray(content) ? content : []) {
        const block = obj(b);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") out.push({ type: "say", text: block.text });
        else if (block.type === "tool_use") {
          const name = str(block.name) ?? "";
          out.push({ type: "tool", id: str(block.id) ?? "", name, tool: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : undefined, input: obj(block.input) ?? {} });
        }
      }
      // The message's tokens (repeated on each of its lines; the reducer keeps one per message id).
      const usage = usageOf(obj(message?.usage));
      const id = str(message?.id);
      if (usage && id) out.push({ type: "usage", id, ...(str(message?.model) ? { model: str(message?.model) } : {}), usage });
      return out.length ? out : [{ type: "activity" }];
    }
    case "user": {
      const content = obj(d.message)?.content;
      const structured = obj(obj(d.tool_use_result)?.structuredContent);
      const out: StreamEvent[] = [];
      for (const b of Array.isArray(content) ? content : []) {
        const block = obj(b);
        if (block?.type !== "tool_result") continue;
        const id = str(block.tool_use_id) ?? "";
        const text = resultText(block.content);
        if (block.is_error === true) out.push({ type: "toolError", id, text: text.replace(/^Error:\s*/, "") });
        else out.push({ type: "toolOk", id, text, ...(structured ? { structured } : {}) });
      }
      return out.length ? out : [{ type: "activity" }];
    }
    case "tool_progress":
      return [{ type: "heartbeat", tool: str(d.tool_name), elapsedSec: num(d.elapsed_time_seconds) }];
    case "rate_limit_event": {
      // overageStatus is ignored: it reads "rejected" even while the plan itself still allows use.
      const info = obj(d.rate_limit_info) ?? {};
      const windows = obj(info.unifiedWindows) ?? {};
      const five = obj(windows.five_hour);
      const seven = obj(windows.seven_day);
      return [
        {
          type: "rateLimit",
          status: str(info.status) ?? "allowed",
          fiveHour: num(five?.utilization),
          sevenDay: num(seven?.utilization),
          resetsAt: isoTime(info.resetsAt ?? five?.resetsAt),
        },
      ];
    }
    case "result":
      return [
        {
          type: "result",
          subtype: str(d.subtype) ?? "unknown",
          isError: d.is_error === true,
          costUsd: num(d.total_cost_usd),
          durationMs: num(d.duration_ms),
          turns: num(d.num_turns),
          text: str(d.result) ?? "",
          ...(str(d.api_error) ? { apiError: str(d.api_error) } : {}),
          ...(num(d.api_error_status) !== undefined ? { apiErrorStatus: num(d.api_error_status) } : {}),
          ...(str(d.terminal_reason) ? { terminalReason: str(d.terminal_reason) } : {}),
        },
      ];
    default:
      return [{ type: "activity" }];
  }
}

/** The app's attempt marker, written before each spawn; the attempt's events start after it. */
export function markerLine(attempt: number, at: string): string {
  return `${JSON.stringify({ type: "katana_app", attempt, at })}\n`;
}

/** Prefixed tool errors (`[BUDGET] needs=52 cap=45 …`), the machine-readable reasons to stop. */
export function errorCode(text: string): { code: string; needs?: number; cap?: number } | undefined {
  const m = /^\[([A-Z_]+)\]/.exec(text.trim());
  if (!m) return undefined;
  const budget = /needs=(\d+(?:\.\d+)?)\s+cap=(\d+(?:\.\d+)?)/.exec(text);
  return { code: m[1]!, ...(budget ? { needs: Number(budget[1]), cap: Number(budget[2]) } : {}) };
}

/** The issues of the last `KATANA_REPORT {...}` line; bad JSON gives none. */
export function reportIssues(text: string): string[] {
  const lines = text.split("\n").filter((l) => l.includes("KATANA_REPORT"));
  const last = lines.at(-1);
  if (!last) return [];
  try {
    const data = JSON.parse(last.slice(last.indexOf("KATANA_REPORT") + "KATANA_REPORT".length).trim()) as { issues?: unknown };
    return Array.isArray(data.issues) ? data.issues.filter((i): i is string => typeof i === "string").map((i) => i.slice(0, 300)).slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** Text without the report line. */
export function withoutReport(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.includes("KATANA_REPORT"))
    .join("\n")
    .trim();
}

/**
 * Reads a growing file line by line from a byte offset. A trailing partial line stays buffered until
 * its newline arrives; memory holds one line plus the current chunk, however long the stream gets.
 */
export class LineTailer {
  private partial: Buffer[] = [];
  private partialBytes = 0;
  /** Lines that were not JSON. */
  junk = 0;

  constructor(
    readonly file: string,
    /** Byte offset of the next unread byte. */
    public offset: number,
  ) {}

  /** Calls `onLine` for every complete line written since the last read. Returns the number of lines. */
  read(onLine: (line: string) => void, chunkSize = 1 << 16): number {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return 0;
    }
    if (size <= this.offset) return 0;
    const fd = openSync(this.file, "r");
    let lines = 0;
    try {
      const buf = Buffer.alloc(chunkSize);
      while (this.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(chunkSize, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        let start = 0;
        for (let i = 0; i < n; i++) {
          if (buf[i] !== 10) continue;
          const piece = buf.subarray(start, i);
          const line = this.partialBytes ? Buffer.concat([...this.partial, piece]).toString("utf8") : piece.toString("utf8");
          this.partial = [];
          this.partialBytes = 0;
          start = i + 1;
          if (line.trim()) {
            onLine(line);
            lines++;
          }
        }
        if (start < n) {
          this.partial.push(Buffer.from(buf.subarray(start, n)));
          this.partialBytes += n - start;
        }
      }
    } finally {
      closeSync(fd);
    }
    return lines;
  }
}
