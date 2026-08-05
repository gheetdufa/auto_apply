import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "./data/apply";

/**
 * Structured apply diagnostics — written to data/apply/<jobTag>-debug.log and
 * mirrored to the server console so console CSP/428 noise can be correlated
 * with what the filler actually saw.
 */
export class ApplyDebugLog {
  readonly path: string;
  private readonly lines: string[] = [];

  constructor(jobTag: string) {
    mkdirSync(DIR, { recursive: true });
    this.path = join(DIR, `${jobTag}-debug.log`);
    writeFileSync(this.path, "");
    this.info("log opened", { path: this.path });
  }

  info(msg: string, data?: unknown): void {
    this.write("INFO", msg, data);
  }

  warn(msg: string, data?: unknown): void {
    this.write("WARN", msg, data);
  }

  error(msg: string, data?: unknown): void {
    this.write("ERROR", msg, data);
  }

  private write(level: string, msg: string, data?: unknown): void {
    const ts = new Date().toISOString();
    const extra =
      data === undefined
        ? ""
        : typeof data === "string"
          ? ` ${data}`
          : ` ${JSON.stringify(data)}`;
    const line = `[${ts}] ${level} ${msg}${extra}`;
    this.lines.push(line);
    try {
      appendFileSync(this.path, line + "\n");
    } catch {
      // disk full / race — still mirror to console
    }
    const sink = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
    sink(`[apply] ${msg}${extra}`);
  }

  snapshot(): string[] {
    return [...this.lines];
  }
}
