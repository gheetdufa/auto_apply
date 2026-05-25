import { decode } from "./html-entities";

export type RawJobRow = {
  company: string;
  title: string;
  locationRaw: string;
  applyUrl: string;
  postedDate: string | null;
  isClosed: boolean;
};

const TITLE_HINTS =
  /\b(engineer|developer|swe|sde|programmer|intern(ship)?|scientist|analyst|architect|fellow|technician|new\s*grad)\b/i;
const LOCATION_HINTS =
  /\b(remote|hybrid|on[\s-]?site|usa|united states|canada|new york|nyc|san francisco|sf|bay area|seattle|austin|boston|chicago|los angeles|la|atlanta|denver|miami|portland|washington|dc|virginia|cupertino|mountain view|palo alto|menlo park|sunnyvale|berkeley|oakland|brooklyn|queens|manhattan|jersey city|hoboken|[A-Z]{2})\b/i;
const APPLY_TEXTS = /apply|application|view\s*role|job\s*posting|simplify|easy\s*apply/i;
const CLOSED_RE = /🔒|closed|no longer accepting/i;

const URL_IN_HREF = /href=["']([^"']+)["']/gi;
const MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"')]+/g;

const SIMPLIFY_DOMAIN = /simplify\.jobs/i;
const TRACKING_DOMAINS = /(?:utm_|click\.appcast|tracking\.cv|trk\.|jobright-tracking)/i;

export function normalizeRow(headers: string[], cells: string[]): RawJobRow | null {
  const hMap = mapHeaders(headers);
  const isClosed = cells.some((c) => CLOSED_RE.test(c));

  let company = "";
  let title = "";
  let locationRaw = "";
  let applyUrl = "";
  let postedDate: string | null = null;

  if (hMap.company !== -1) company = stripCell(cells[hMap.company]);
  if (hMap.role !== -1) title = stripCell(cells[hMap.role]);
  if (hMap.location !== -1) locationRaw = stripCell(cells[hMap.location]);
  if (hMap.date !== -1) postedDate = stripCell(cells[hMap.date]) || null;
  if (hMap.apply !== -1) applyUrl = pickBestUrl(cells[hMap.apply]);

  if (!company) {
    const c = cells.find((cell) => /\*\*\[|<strong>/.test(cell));
    if (c) company = stripCell(c);
  }
  if (!title) {
    const c = cells.find((cell) => TITLE_HINTS.test(stripCell(cell)));
    if (c) title = stripCell(c);
  }
  if (!locationRaw) {
    const c = cells.find((cell) => LOCATION_HINTS.test(stripCell(cell)));
    if (c) locationRaw = stripCell(c);
  }
  if (!applyUrl) {
    for (const cell of cells) {
      const u = pickBestUrl(cell);
      if (u) {
        applyUrl = u;
        break;
      }
    }
  }

  company = cleanup(company);
  title = cleanup(title);
  locationRaw = cleanup(locationRaw);

  if (!company || !title || !applyUrl) return null;

  return { company, title, locationRaw: locationRaw || "Unspecified", applyUrl, postedDate, isClosed };
}

type HeaderMap = { company: number; role: number; location: number; apply: number; date: number };
function mapHeaders(headers: string[]): HeaderMap {
  const norm = headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const find = (...needles: string[]) => norm.findIndex((h) => needles.some((n) => h.includes(n)));
  return {
    company: find("company"),
    role: find("role", "position", "title", "job"),
    location: find("location", "city", "where"),
    apply: find("application", "apply", "link"),
    date: find("date", "age", "posted"),
  };
}

function pickBestUrl(cell: string): string {
  const urls: string[] = [];
  for (const m of cell.matchAll(URL_IN_HREF)) urls.push(m[1]);
  for (const m of cell.matchAll(MD_LINK)) urls.push(m[2]);
  for (const m of cell.matchAll(BARE_URL)) urls.push(m[0]);

  const direct = urls.find((u) => !SIMPLIFY_DOMAIN.test(u) && !TRACKING_DOMAINS.test(u) && APPLY_TEXTS_OK(u));
  if (direct) return cleanUrl(direct);
  const anySimplify = urls.find((u) => SIMPLIFY_DOMAIN.test(u));
  if (anySimplify) return cleanUrl(anySimplify);
  return urls.length > 0 ? cleanUrl(urls[0]) : "";
}

function APPLY_TEXTS_OK(_u: string): boolean {
  return true;
}

function cleanUrl(u: string): string {
  return u.replace(/[)\]]+$/, "").trim();
}

function stripCell(cell: string): string {
  let s = decode(cell);
  s = s.replace(/<details[^>]*>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (_m, sum, body) =>
    `${sum} ${body.replace(/<\/?(br|p|div)[^>]*>/gi, ", ")}`,
  );
  s = s.replace(/<br\s*\/?>(?:\s*<\/li>)?/gi, ", ");
  s = s.replace(/<\/li>/gi, ", ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  s = s.replace(/[\*_`]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "");
  return s;
}

function cleanup(s: string): string {
  return s
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
