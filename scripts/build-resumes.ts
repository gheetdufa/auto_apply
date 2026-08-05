#!/usr/bin/env tsx
/**
 * Compile both resume variants with tectonic and copy into data/:
 *   data/resume.pdf              — B.S., May 2027 (new-grad / full-time)
 *   data/resume-internship.pdf   — B.S./M.S., May 2028 (internships)
 *
 *   pnpm resume:build
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pdfPageCount } from "../lib/resume/page-count";

const ROOT = resolve(import.meta.dirname, "..");
const RESUME_DIR = resolve(ROOT, "resume");
const DATA = resolve(ROOT, "data");

function whichTectonic(): string {
  try {
    return execFileSync("which", ["tectonic"], { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("tectonic not found — brew install tectonic");
  }
}

function compile(texName: string, outPdfName: string) {
  const tex = resolve(RESUME_DIR, texName);
  if (!existsSync(tex)) throw new Error(`missing ${tex}`);
  console.log(`Compiling ${texName}…`);
  execFileSync("tectonic", ["-X", "compile", texName], {
    cwd: RESUME_DIR,
    stdio: "inherit",
  });
  const built = resolve(RESUME_DIR, outPdfName);
  if (!existsSync(built)) {
    // tectonic names output after the .tex basename
    throw new Error(`expected ${built} after compile`);
  }
  const pages = pdfPageCount(built);
  if (pages !== 1) {
    throw new Error(
      `${outPdfName} is ${pages || "an unreadable number of"} pages — must be exactly 1. ` +
        `Trim content in ${texName} (view it at /resume in the app).`,
    );
  }
  return built;
}

function main() {
  whichTectonic();
  mkdirSync(DATA, { recursive: true });

  const newGrad = compile("resume.tex", "resume.pdf");
  copyFileSync(newGrad, resolve(DATA, "resume.pdf"));
  console.log(`→ data/resume.pdf (B.S., May 2027) — 1 page ✓`);

  const intern = compile("resume-internship.tex", "resume-internship.pdf");
  copyFileSync(intern, resolve(DATA, "resume-internship.pdf"));
  console.log(`→ data/resume-internship.pdf (B.S./M.S., May 2028) — 1 page ✓`);
}

main();
