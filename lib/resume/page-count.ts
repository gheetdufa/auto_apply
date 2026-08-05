import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * Page count of a PDF without a PDF library: read /Count from the /Pages
 * dictionary, inflating flate streams first since tectonic packs object
 * dictionaries into compressed object streams. Returns 0 if unparseable.
 */
export function pdfPageCount(path: string): number {
  const raw = readFileSync(path);
  const src = raw.toString("latin1");

  const chunks: string[] = [src];
  const streamRe = /stream\r?\n/g;
  for (let m = streamRe.exec(src); m; m = streamRe.exec(src)) {
    const start = m.index + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end === -1) break;
    try {
      chunks.push(inflateSync(raw.subarray(start, end)).toString("latin1"));
    } catch {
      // binary/non-flate stream (fonts, images) — irrelevant here
    }
  }
  const text = chunks.join("\n");

  // Root /Pages node carries the total; intermediate nodes are smaller, so max.
  let count = 0;
  for (const re of [
    /\/Type\s*\/Pages\b[^>]{0,400}?\/Count\s+(\d+)/g,
    /\/Count\s+(\d+)[^>]{0,400}?\/Type\s*\/Pages\b/g,
  ]) {
    for (let m = re.exec(text); m; m = re.exec(text)) count = Math.max(count, Number(m[1]));
  }
  if (count > 0) return count;

  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}
