export type MarkdownTable = {
  headers: string[];
  rows: string[][];
};

const ROW_LINE = /^\s*\|(.+)\|\s*$/;
const SEPARATOR_LINE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function* parseTables(markdown: string): Generator<MarkdownTable> {
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const headerMatch = lines[i].match(ROW_LINE);
    const sepLine = lines[i + 1];
    if (headerMatch && sepLine && SEPARATOR_LINE.test(sepLine)) {
      const headers = splitCells(headerMatch[1]);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const m = lines[j].match(ROW_LINE);
        if (!m) break;
        rows.push(splitCells(m[1]));
        j += 1;
      }
      yield { headers, rows };
      i = j;
    } else {
      i += 1;
    }
  }
}

const TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;

export function* parseHtmlTables(markdown: string): Generator<MarkdownTable> {
  for (const tm of markdown.matchAll(TABLE_RE)) {
    const tableHtml = tm[1];
    const rows: string[][] = [];
    let headers: string[] = [];
    for (const rm of tableHtml.matchAll(ROW_RE)) {
      const rowHtml = rm[1];
      const cells: string[] = [];
      let isHeader = false;
      for (const cm of rowHtml.matchAll(CELL_RE)) {
        if (cm[1].toLowerCase() === "th") isHeader = true;
        cells.push(cm[2].trim());
      }
      if (cells.length === 0) continue;
      if (isHeader && headers.length === 0) headers = cells;
      else rows.push(cells);
    }
    if (rows.length > 0) {
      if (headers.length === 0) headers = ["Company", "Role", "Location", "Application", "Date"];
      yield { headers, rows };
    }
  }
}

function splitCells(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === "<") depth += 1;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "|" && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf.trim());
  return out;
}
