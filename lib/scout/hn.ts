import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { upsertCompany, BACKFILL_THRESHOLD } from "@/lib/ingest/run";
import { dedupeKey, coarseKey } from "@/lib/ingest/dedupe";
import { classify, isTarget } from "@/lib/ingest/location";
import { isBlockedCompany } from "@/lib/ingest/blocklist";
import { detectAts } from "@/lib/ats/detect";
import { loadState, saveState } from "./discover";
import { loadCoarseKeys } from "./coarse";

/**
 * HN "Ask HN: Who is hiring?" scout — startup-dense, SF/NYC-heavy, and lots of
 * roles that never reach the GitHub lists. Public Algolia API, no auth.
 * Regex prefilter → Claude extracts structured postings from matching comments.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
const MIN_INTERVAL_MS = 12 * 60 * 60 * 1000; // at most twice a day

const Extracted = z.object({
  postings: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      applyUrl: z.string().nullable(),
      commentId: z.string(),
    }),
  ),
});

export type ScoutHnResult = { skipped: boolean; commentsScanned: number; matched: number; newJobIds: number[] };

export async function scoutHn(): Promise<ScoutHnResult> {
  const state = loadState();
  if (Date.now() - (state.lastHnScanAt ?? 0) < MIN_INTERVAL_MS) {
    return { skipped: true, commentsScanned: 0, matched: 0, newJobIds: [] };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, commentsScanned: 0, matched: 0, newJobIds: [] };

  // Latest "Who is hiring?" thread by the whoishiring bot.
  const threadRes = await fetch(
    "https://hn.algolia.com/api/v1/search_by_date?query=%22who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=1",
    { signal: AbortSignal.timeout(15_000) },
  );
  const thread = (await threadRes.json()) as { hits?: Array<{ objectID: string; title: string }> };
  const storyId = thread.hits?.[0]?.objectID;
  if (!storyId) return { skipped: false, commentsScanned: 0, matched: 0, newJobIds: [] };

  const commentsRes = await fetch(
    `https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${storyId}&hitsPerPage=1000`,
    { signal: AbortSignal.timeout(20_000) },
  );
  const comments = (await commentsRes.json()) as {
    hits?: Array<{ objectID: string; comment_text?: string; parent_id?: number; created_at_i?: number }>;
  };
  const top = (comments.hits ?? []).filter(
    (c) =>
      String(c.parent_id) === storyId && // top-level postings only
      c.comment_text &&
      (c.created_at_i ?? 0) * 1000 > (state.lastHnScanAt ?? 0) - MIN_INTERVAL_MS, // only newer than last scan (with overlap)
  );

  // Cheap prefilter before spending tokens.
  const ROLE_RE = /(new.?grad|university\s*grad|entry.?level|junior|early.?career|intern)/i;
  const LOC_RE = /(san\s*francisco|\bsf\b|bay\s*area|new\s*york|\bnyc\b|remote)/i;
  const candidates = top.filter((c) => ROLE_RE.test(c.comment_text!) && LOC_RE.test(c.comment_text!));

  // Second stream: "X (YC W26) Is Hiring …" job posts on the HN front page.
  // Fetched as pseudo-comments through the same extractor.
  try {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const jobsRes = await fetch(
      `https://hn.algolia.com/api/v1/search_by_date?tags=job&hitsPerPage=100&numericFilters=created_at_i>${weekAgo}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const jobPosts = (await jobsRes.json()) as { hits?: Array<{ objectID: string; title?: string; url?: string }> };
    const SENIOR_RE = /\b(senior|staff|principal|lead|manager|director|head of)\b/i;
    for (const h of jobPosts.hits ?? []) {
      if (!h.title || !/hiring/i.test(h.title)) continue;
      if (!/(engineer|swe|developer|software|founding)/i.test(h.title)) continue;
      if (SENIOR_RE.test(h.title)) continue;
      candidates.push({
        objectID: h.objectID,
        comment_text: `[HN JOB POST] ${h.title}${h.url ? ` — apply: ${h.url}` : ""}`,
        parent_id: Number(storyId),
        created_at_i: Math.floor(Date.now() / 1000),
      });
    }
  } catch {
    // job-post stream is best-effort
  }

  const client = new Anthropic();
  const system = `You extract job postings from Hacker News "Who is hiring" comments for a May-2027 CS grad seeking software-engineering NEW GRAD / EARLY CAREER / INTERN roles in San Francisco, NYC, or Remote-US.

From each comment, extract postings ONLY when ALL are true:
- software engineering role (not sales/marketing/recruiting/senior-only)
- explicitly open to new grads, juniors, early career, or interns (senior-only posts: skip)
- located in SF Bay Area, NYC, or US-remote
Include the application URL if one appears in the comment; else null. Use the provided commentId. Return an empty list when nothing qualifies.
Items marked [HN JOB POST] are YC-startup job posts: extract company from the title (the part before "(YC" or "Is Hiring"); when no location is given, assume "San Francisco, CA". Generic non-senior engineering titles from these startups qualify even without an explicit new-grad tag.`;

  const found: Array<z.infer<typeof Extracted>["postings"][number]> = [];
  const CHUNK = 12;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const user = chunk
      .map((c) => `### commentId: ${c.objectID}\n${stripHtml(c.comment_text!).slice(0, 2200)}`)
      .join("\n\n");
    try {
      const msg = await client.messages.parse({
        model: MODEL,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: { format: zodOutputFormat(Extracted) },
      });
      found.push(...(msg.parsed_output?.postings ?? []));
    } catch {
      // one bad chunk shouldn't kill the scan
    }
  }

  // Insert.
  const existingKeys = new Set(db.select({ k: jobs.dedupeKey }).from(jobs).all().map((r) => r.k));
  const coarseKeys = loadCoarseKeys();
  const backfill = found.length > BACKFILL_THRESHOLD;
  const now = new Date();
  const newJobIds: number[] = [];
  for (const p of found) {
    if (!isTarget(classify(p.location))) continue;
    if (isBlockedCompany(p.company)) continue;
    const key = dedupeKey(p.company, p.title, p.location);
    if (existingKeys.has(key)) continue;
    const ck = coarseKey(p.company, p.title, classify(p.location));
    if (coarseKeys.has(ck)) continue;
    existingKeys.add(key);
    coarseKeys.add(ck);
    const companyId = await upsertCompany(p.company);
    const applyUrl = p.applyUrl ?? `https://news.ycombinator.com/item?id=${p.commentId}`;
    const [inserted] = await db
      .insert(jobs)
      .values({
        companyId,
        title: p.title,
        kind: /intern(ship)?/i.test(p.title) ? "internship" : "new-grad",
        locationRaw: p.location,
        locationClass: classify(p.location),
        applyUrl,
        atsType: detectAts(applyUrl),
        sourceRepos: ["scout:hn"],
        status: "discovered",
        dedupeKey: key,
        backfilled: backfill,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: jobs.id });
    newJobIds.push(inserted.id);
  }

  saveState({ ...state, lastHnScanAt: Date.now() });
  return { skipped: false, commentsScanned: top.length, matched: found.length, newJobIds };
}

function stripHtml(s: string): string {
  return s
    .replace(/<p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

