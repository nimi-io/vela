import { spawn } from "node:child_process";

export class ExecError extends Error {
  constructor(
    message: string,
    public code: number | null,
    public stderr: string,
  ) {
    super(message);
  }
}

export type RunOptions = {
  /** Called with each line of stdout (used for ffmpeg -progress pipe:1). */
  onStdoutLine?: (line: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
};

/** Runs a command, collecting stderr (last 64 KB) for error reporting. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      if (opts.onStdoutLine) {
        buf += s;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          opts.onStdoutLine(buf.slice(0, idx).trim());
          buf = buf.slice(idx + 1);
        }
      } else if (stdout.length < 8 * 1024 * 1024) {
        stdout += s;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 65536) stderr = stderr.slice(-65536);
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ExecError(`${cmd} failed to start: ${err.message}`, null, stderr));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-12).join("\n");
        reject(new ExecError(`${cmd} exited with code ${code}: ${tail}`, code, stderr));
      }
    });
  });
}
