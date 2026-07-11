import { execFile } from "node:child_process";

/** Fire a macOS notification (no-op on other platforms / on failure). */
export function notifyMac(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)} sound name "Glass"`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) console.error("notification failed:", err.message);
  });
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
