/**
 * Install/uninstall the launchd agent that runs the ingest pipeline every 15
 * minutes, so new job postings surface (and notify) without the app running.
 *
 *   pnpm watcher:install
 *   pnpm watcher:uninstall
 *   pnpm watcher:status
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LABEL = "com.autoapply.watch";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const PROJECT_DIR = resolve(import.meta.dirname, "..");
const INTERVAL_SECONDS = 15 * 60;

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd ${PROJECT_DIR} &amp;&amp; pnpm ingest &gt;&gt; data/watch.log 2&gt;&amp;1</string>
  </array>
  <key>StartInterval</key><integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;

function launchctl(args: string[], ignoreFailure = false): string {
  try {
    return execFileSync("launchctl", args, { encoding: "utf-8" });
  } catch (e) {
    if (ignoreFailure) return "";
    throw e;
  }
}

const uid = process.getuid?.() ?? 501;
const cmd = process.argv[2];

switch (cmd) {
  case "install": {
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(PLIST_PATH, plist);
    launchctl(["bootout", `gui/${uid}`, PLIST_PATH], true); // reload if already installed
    launchctl(["bootstrap", `gui/${uid}`, PLIST_PATH]);
    console.log(`Installed ${LABEL} — ingest every ${INTERVAL_SECONDS / 60} min.`);
    console.log(`Plist: ${PLIST_PATH}`);
    console.log(`Logs:  ${join(PROJECT_DIR, "data", "watch.log")}`);
    break;
  }
  case "uninstall": {
    launchctl(["bootout", `gui/${uid}`, PLIST_PATH], true);
    if (existsSync(PLIST_PATH)) rmSync(PLIST_PATH);
    console.log(`Uninstalled ${LABEL}.`);
    break;
  }
  case "status": {
    const out = launchctl(["print", `gui/${uid}/${LABEL}`], true);
    console.log(out ? out.split("\n").slice(0, 20).join("\n") : `${LABEL} is not loaded.`);
    break;
  }
  default:
    console.log("Usage: tsx scripts/watcher.ts <install|uninstall|status>");
    process.exit(1);
}
