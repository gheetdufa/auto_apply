import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { AtsType } from "@/db/schema";
import { greenhouseJobRef } from "@/lib/ats/questions";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type FetchedJd = { text: string; finalUrl: string; ats: AtsType };
export type FetchedPage = { url: string; html: string };

export async function fetchJd(applyUrl: string, atsHint: AtsType): Promise<FetchedJd> {
  const followed = await follow(applyUrl);
  return fetchJdFromPage(followed, atsHint);
}

/** Same as fetchJd but reuses an already-fetched page (enrichment fetches the page once). */
export async function fetchJdFromPage(followed: FetchedPage, atsHint: AtsType): Promise<FetchedJd> {
  const ats = redetectAts(followed.url, atsHint);

  if (ats === "greenhouse") {
    const text = await tryGreenhouse(followed.url, followed.html);
    if (text) return { text, finalUrl: followed.url, ats };
  }
  if (ats === "lever") {
    const text = await tryLever(followed.url);
    if (text) return { text, finalUrl: followed.url, ats };
  }
  if (ats === "ashby") {
    const text = await tryAshby(followed.url);
    if (text) return { text, finalUrl: followed.url, ats };
  }

  const text = extractReadable(followed.html, followed.url);
  return { text, finalUrl: followed.url, ats };
}

/** Career sites hang or bot-wall for minutes — never wait longer than this per request. */
export const FETCH_TIMEOUT_MS = 20_000;

export async function follow(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { url: res.url, html: await res.text() };
}

function redetectAts(url: string, hint: AtsType): AtsType {
  const u = url.toLowerCase();
  if (u.includes("greenhouse.io") || u.includes("grnh.se") || /[?&]gh_jid=/.test(u)) return "greenhouse";
  if (u.includes("lever.co")) return "lever";
  if (u.includes("ashbyhq.com")) return "ashby";
  if (u.includes("myworkdayjobs.com") || u.includes("workday.com")) return "workday";
  return hint;
}

async function tryGreenhouse(url: string, html: string): Promise<string | null> {
  // Handles both direct board URLs and company pages embedding Greenhouse via gh_jid.
  const ref = greenhouseJobRef(url, html);
  if (!ref) return null;
  const api = `https://boards-api.greenhouse.io/v1/boards/${ref.board}/jobs/${ref.id}?content=true`;
  const res = await fetch(api, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = (await res.json()) as { title?: string; content?: string; location?: { name?: string } };
  const plain = stripTags(decodeEntities(data.content ?? ""));
  if (!plain) return null;
  const head = [data.title, data.location?.name].filter(Boolean).join(" · ");
  return `${head}\n\n${plain}`.trim();
}

async function tryLever(url: string): Promise<string | null> {
  const m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]+)/i);
  if (!m) return null;
  const [, company, id] = m;
  const api = `https://api.lever.co/v0/postings/${company}/${id}`;
  const res = await fetch(api, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    text?: string;
    descriptionPlain?: string;
    additionalPlain?: string;
    text_html?: string;
    categories?: { team?: string; location?: string };
    lists?: Array<{ text?: string; content?: string }>;
  };
  const parts: string[] = [];
  if (data.text) parts.push(data.text);
  if (data.descriptionPlain) parts.push(data.descriptionPlain);
  for (const l of data.lists ?? []) {
    parts.push(`\n## ${l.text ?? ""}\n${stripTags(decodeEntities(l.content ?? ""))}`);
  }
  if (data.additionalPlain) parts.push("\n" + data.additionalPlain);
  return parts.join("\n").trim() || null;
}

async function tryAshby(url: string): Promise<string | null> {
  const m = url.match(/(?:jobs|app)\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]+)/i);
  if (!m) return null;
  const [, org, id] = m;
  const api = `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`;
  const res = await fetch(api, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const data = (await res.json()) as { jobs?: Array<{ id: string; title: string; descriptionPlain?: string; location?: string }> };
  const job = data.jobs?.find((j) => j.id === id);
  if (!job?.descriptionPlain) return null;
  return `${job.title} · ${job.location ?? ""}\n\n${job.descriptionPlain}`.trim();
}

function extractReadable(html: string, baseUrl: string): string {
  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const article = new Readability(dom.window.document).parse();
    if (article?.textContent) return article.textContent.replace(/\n{3,}/g, "\n\n").trim();
  } catch {}
  return stripTags(decodeEntities(html)).slice(0, 12000);
}

function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<br\s*\/?>(?:)/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
