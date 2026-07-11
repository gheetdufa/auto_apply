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
const TRACKER_HOSTS = /(?:click\.appcast|tracking\.cv|\btrk\.|jobright-tracking)/i;
// Apply-badge images and other assets that must never be treated as apply links.
const IMAGE_URL = /\.(?:png|jpe?g|gif|svg|webp|ico)(?:\?[^#\s]*)?$/i;
const ASSET_HOSTS = /(?:i\.imgur\.com|img\.shields\.io|(?:raw|camo|user-images)\.githubusercontent\.com)/i;
// Paths that look like an actual job posting rather than a company homepage.
const JOB_PATH = /(?:[?&]gh_jid=|\/jobs?\/|\/careers?\/|\/positions?\/|\/openings?\/|\/postings?\/|\/apply\b|jobid=|requisition)/i;
const KNOWN_ATS =
  /(?:greenhouse\.io|grnh\.se|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|wellfound\.com|angel\.co|linkedin\.com\/jobs|smartrecruiters\.com|icims\.com|jobvite\.com|rippling\.com)/i;

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
  const seen = new Set<string>();
  const urls: string[] = [];
  const push = (raw: string) => {
    const u = cleanUrl(raw);
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };
  for (const m of cell.matchAll(URL_IN_HREF)) push(m[1]);
  for (const m of cell.matchAll(MD_LINK)) push(m[2]);
  for (const m of cell.matchAll(BARE_URL)) push(m[0]);

  // Never pick images/badges or tracker hosts.
  const candidates = urls.filter((u) => !IMAGE_URL.test(u) && !ASSET_HOSTS.test(u) && !TRACKER_HOSTS.test(u));

  // 1. Direct link on a known ATS domain.
  const ats = candidates.find((u) => KNOWN_ATS.test(u));
  if (ats) return ats;
  // 2. Direct link whose path looks like a job posting (careers page, gh_jid embed, …).
  const jobish = candidates.find((u) => JOB_PATH.test(u) && !SIMPLIFY_DOMAIN.test(u));
  if (jobish) return jobish;
  // 3. Simplify redirect — resolves to the real posting during enrichment.
  const simplify = candidates.find((u) => SIMPLIFY_DOMAIN.test(u));
  if (simplify) return simplify;
  // 4. Whatever is left (likely a homepage) — better than nothing.
  return candidates[0] ?? "";
}

function cleanUrl(raw: string): string {
  const u = raw.replace(/[)\]]+$/, "").trim();
  // Strip utm_* noise so dedupe/ATS matching sees a stable URL.
  try {
    const parsed = new URL(u);
    for (const k of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(k)) parsed.searchParams.delete(k);
    }
    return parsed.toString();
  } catch {
    return u;
  }
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
