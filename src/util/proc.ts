import { spawn } from "node:child_process";

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number,
    readonly stderrTail: string,
    /** What the command printed before failing (some CLIs report errors as JSON on stdout). */
    readonly stdout: Buffer = Buffer.alloc(0),
  ) {
    super(`${command} exited with code ${code}: ${stderrTail}`);
    this.name = "CommandError";
  }
}

const STDERR_TAIL = 4000;

/** Runs a command to completion, buffering stdout. Throws CommandError on a non-zero exit. */
export function run(cmd: string, args: string[], opts: { input?: Buffer; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      err = (err + c.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { stdout: Buffer.concat(out), stderr: err, code: code ?? -1 };
      if (result.code !== 0) reject(new CommandError(`${cmd} ${args.slice(0, 6).join(" ")}…`, result.code, err, result.stdout));
      else resolve(result);
    });
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Streams a command's stdout in fixed-size records (e.g. raw video frames).
 * `onRecord` receives a view that is only valid during the call.
 */
export function streamRecords(
  cmd: string,
  args: string[],
  recordSize: number,
  onRecord: (record: Buffer, index: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let pending: Buffer = Buffer.alloc(0);
    let index = 0;
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (pending.length - offset >= recordSize) {
        onRecord(pending.subarray(offset, offset + recordSize), index++);
        offset += recordSize;
      }
      pending = pending.subarray(offset);
    });
    child.stderr.on("data", (c: Buffer) => {
      err = (err + c.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new CommandError(cmd, code ?? -1, err));
      else resolve(index);
    });
  });
}
