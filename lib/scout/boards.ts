import { db } from "@/db";
import { jobs, companies } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { SWE_TITLE_RE, NEGATIVE_TITLE_RE, QUANT_TITLE_RE, BACKFILL_THRESHOLD, upsertCompany } from "@/lib/ingest/run";
import { dedupeKey, coarseKey } from "@/lib/ingest/dedupe";
import { classify, isTarget, isQuantHub } from "@/lib/ingest/location";
import { isBlockedCompany } from "@/lib/ingest/blocklist";
import { EARLY_CAREER_RE, SENIOR_TITLE_RE } from "@/lib/ingest/early-career";
import {
  greenhouseEmploymentType,
  isEarlyCareerEmployment,
  kindFromTitleOrEmployment,
  titleWithEmployment,
  type GhMeta,
} from "@/lib/ats/employment";
import { discoverYcBoards, getDiscoveredBoards, loadState, saveState, type DiscoverResult } from "./discover";
import { WATCH_BOARDS } from "./watch-boards";
import { loadCoarseKeys } from "./coarse";

/**
 * Direct ATS board watcher. Boards come from:
 *  1. curated WATCH_BOARDS (Jane Street, Stripe, …),
 *  2. every company already in the DB (GH/Lever/Ashby/SmartRecruiters/Workable),
 *  3. YC hiring discovery + NUFT quant boards (see discover.ts).
 *
 * Two admission tiers per posting:
 *  - EXPLICIT: title OR Greenhouse Employment Type says new-grad / intern /
 *    co-op / junior → full pipeline (notify + auto-draft).
 *  - AMBIENT (startup boards only): plain SWE title with no seniority marker.
 *
 * Mega-tech boards stay on the watch list: early-career titles (and metadata)
 * pass the blocklist exception; senior FAANG spray still gets dropped.
 */

const UA = "auto-apply-scout/0.1";
const TIMEOUT = AbortSignal.timeout.bind(AbortSignal);
const AMBIENT_CAP_PER_RUN = 40;

type BoardAts = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable";
type Board = { ats: BoardAts; token: string; company: string; companyId?: number; startup?: boolean };
type Posting = {
  title: string;
  locationRaw: string;
  applyUrl: string;
  /** Raw Greenhouse Employment Type when present. */
  employmentType?: string | null;
};

export type ScoutBoardsResult = {
  boards: number;
  postingsSeen: number;
  newJobIds: number[];
  /** Explicit-tier postings from first-poll boards — inserted quietly. */
  seeded: number;
  ambientNew: number;
  backfill: boolean;
  discovery?: DiscoverResult;
};

export async function scoutBoards(): Promise<ScoutBoardsResult> {
  const discovery = await discoverYcBoards().catch(() => undefined);

  const boards = mergeBoards(WATCH_BOARDS, await dbBoards(), getDiscoveredBoards());
  const existingKeys = new Set(db.select({ k: jobs.dedupeKey }).from(jobs).all().map((r) => r.k));
  const coarseKeys = loadCoarseKeys();

  const state = loadState();
  const polled = new Set(state.polledBoards ?? []);

  const explicit: Array<{ board: Board; posting: Posting; seeding: boolean }> = [];
  const ambient: Array<{ board: Board; posting: Posting }> = [];
  let postingsSeen = 0;
  const BATCH = 12;
  for (let i = 0; i < boards.length; i += BATCH) {
    const results = await Promise.allSettled(boards.slice(i, i + BATCH).map((b) => fetchBoard(b)));
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const boardKey = `${r.value.board.ats}:${r.value.board.token.toLowerCase()}`;
      const seeding = !polled.has(boardKey);
      if (r.value.fetched) polled.add(boardKey);
      postingsSeen += r.value.postings.length;
      for (const raw of r.value.postings) {
        const posting: Posting = {
          ...raw,
          title: titleWithEmployment(raw.title, raw.employmentType),
        };
        const admitBlob = `${raw.title} ${raw.employmentType ?? ""}`;
        const isQuant = QUANT_TITLE_RE.test(admitBlob);
        if (NEGATIVE_TITLE_RE.test(posting.title) && !isQuant) continue;
        if (!SWE_TITLE_RE.test(admitBlob) && !isQuant) continue;
        if (isBlockedCompany(r.value.board.company, { title: admitBlob })) continue;
        if (!isTarget(classify(posting.locationRaw)) && !(isQuant && isQuantHub(posting.locationRaw))) continue;
        const early =
          EARLY_CAREER_RE.test(admitBlob) || isEarlyCareerEmployment(raw.employmentType);
        if (early) {
          explicit.push({ board: r.value.board, posting, seeding });
        } else if (r.value.board.startup && !SENIOR_TITLE_RE.test(posting.title)) {
          ambient.push({ board: r.value.board, posting });
        }
      }
    }
  }
  state.polledBoards = [...polled];
  saveState(state);

  const freshExplicit = explicit.filter(
    ({ board, posting }) => !existingKeys.has(dedupeKey(board.company, posting.title, posting.locationRaw)),
  );
  const liveNew = freshExplicit.filter((x) => !x.seeding);
  const backfill = liveNew.length > BACKFILL_THRESHOLD;
  const now = new Date();

  const newJobIds: number[] = [];
  let seeded = 0;
  for (const { board, posting, seeding } of freshExplicit) {
    const quiet = seeding || backfill;
    const id = await insertPosting(board, posting, { backfilled: quiet, now, existingKeys, coarseKeys });
    if (id === null) continue;
    if (quiet) seeded += 1;
    else newJobIds.push(id);
  }

  let ambientNew = 0;
  for (const { board, posting } of ambient) {
    if (ambientNew >= AMBIENT_CAP_PER_RUN) break;
    const id = await insertPosting(board, posting, { backfilled: true, now, existingKeys, coarseKeys, ambient: true });
    if (id !== null) ambientNew += 1;
  }

  return { boards: boards.length, postingsSeen, newJobIds, seeded, ambientNew, backfill, discovery };
}

async function insertPosting(
  board: Board,
  posting: Posting,
  opts: { backfilled: boolean; now: Date; existingKeys: Set<string>; coarseKeys: Set<string>; ambient?: boolean },
): Promise<number | null> {
  const key = dedupeKey(board.company, posting.title, posting.locationRaw);
  if (opts.existingKeys.has(key)) return null;
  const ck = coarseKey(board.company, posting.title, classify(posting.locationRaw));
  if (opts.coarseKeys.has(ck)) return null;
  opts.existingKeys.add(key);
  opts.coarseKeys.add(ck);
  const companyId = board.companyId ?? (await upsertCompany(board.company));
  const ats = board.ats === "smartrecruiters" || board.ats === "workable" ? "custom" : board.ats;
  const [inserted] = await db
    .insert(jobs)
    .values({
      companyId,
      title: posting.title,
      kind: kindFromTitleOrEmployment(posting.title, posting.employmentType),
      locationRaw: posting.locationRaw,
      locationClass: classify(posting.locationRaw),
      applyUrl: posting.applyUrl,
      atsType: ats,
      sourceRepos: [`scout:${board.ats}:${board.token}${opts.ambient ? ":ambient" : ""}`],
      status: "discovered",
      dedupeKey: key,
      backfilled: opts.backfilled,
      firstSeenAt: opts.now,
      lastSeenAt: opts.now,
    })
    .returning({ id: jobs.id });
  return inserted.id;
}

function mergeBoards(...groups: Board[][]): Board[] {
  const seen = new Map<string, Board>();
  for (const group of groups) {
    for (const b of group) {
      const key = `${b.ats}:${b.token.toLowerCase()}`;
      const prev = seen.get(key);
      // Prefer non-startup (watch list) over ambient-capable startup boards.
      if (!prev || (prev.startup && b.startup === false)) seen.set(key, b);
    }
  }
  return [...seen.values()];
}

/** Board tokens from URLs of jobs we already track, mapped to their company. */
async function dbBoards(): Promise<Board[]> {
  const rows = db
    .select({
      companyId: jobs.companyId,
      company: companies.name,
      ats: jobs.atsType,
      applyUrl: jobs.applyUrl,
      finalUrl: jobs.finalUrl,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(sql`${jobs.atsType} IN ('greenhouse','lever','ashby','custom')`)
    .all();

  const byToken = new Map<string, Board>();
  const add = (ats: BoardAts, token: string, r: { companyId: number; company: string }) =>
    byToken.set(`${ats}:${token.toLowerCase()}`, { ats, token, companyId: r.companyId, company: r.company });

  for (const r of rows) {
    for (const url of [r.finalUrl, r.applyUrl]) {
      if (!url) continue;
      if (/janestreet\.com\/join-jane-street/i.test(url)) {
        add("greenhouse", "janestreet", r);
        break;
      }
      const gh = url.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9_-]+)/i);
      if (gh && (r.ats === "greenhouse" || r.ats === "custom") && gh[1] !== "embed") {
        add("greenhouse", gh[1], r);
        break;
      }
      const lv = url.match(/jobs(?:\.eu)?\.lever\.co\/([^/?#]+)/i);
      if (lv && (r.ats === "lever" || r.ats === "custom")) {
        add("lever", lv[1], r);
        break;
      }
      const ab = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
      if (ab && (r.ats === "ashby" || r.ats === "custom")) {
        add("ashby", ab[1], r);
        break;
      }
      const sr = url.match(/(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)/i);
      if (sr && !/^(www|api)$/i.test(sr[1])) {
        add("smartrecruiters", sr[1], r);
        break;
      }
      const wk = url.match(/apply\.workable\.com\/([^/?#]+)/i) ?? url.match(/https?:\/\/([a-z0-9-]+)\.workable\.com/i);
      if (wk && !/^(apply|www|jobs|help)$/i.test(wk[1])) {
        add("workable", wk[1], r);
        break;
      }
    }
  }
  return [...byToken.values()];
}

async function fetchBoard(board: Board): Promise<{ board: Board; postings: Posting[]; fetched: boolean }> {
  const opts = { headers: { "User-Agent": UA }, signal: TIMEOUT(12_000) };
  if (board.ats === "greenhouse") {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board.token}/jobs`, opts);
    if (!res.ok) return { board, postings: [], fetched: false };
    const data = (await res.json()) as {
      jobs?: Array<{
        title: string;
        absolute_url: string;
        location?: { name?: string };
        metadata?: GhMeta[];
      }>;
    };
    return {
      board,
      fetched: true,
      postings: (data.jobs ?? []).map((j) => ({
        title: j.title,
        locationRaw: j.location?.name ?? "",
        applyUrl: j.absolute_url,
        employmentType: greenhouseEmploymentType(j.metadata),
      })),
    };
  }
  if (board.ats === "lever") {
    const res = await fetch(`https://api.lever.co/v0/postings/${board.token}?mode=json`, opts);
    if (!res.ok) return { board, postings: [], fetched: false };
    const data = (await res.json()) as Array<{ text: string; hostedUrl: string; categories?: { location?: string } }>;
    return {
      board,
      fetched: true,
      postings: (Array.isArray(data) ? data : []).map((j) => ({
        title: j.text,
        locationRaw: j.categories?.location ?? "",
        applyUrl: j.hostedUrl,
      })),
    };
  }
  if (board.ats === "ashby") {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${board.token}`, opts);
    if (!res.ok) return { board, postings: [], fetched: false };
    const data = (await res.json()) as { jobs?: Array<{ id: string; title: string; location?: string; jobUrl?: string }> };
    return {
      board,
      fetched: true,
      postings: (data.jobs ?? []).map((j) => ({
        title: j.title,
        locationRaw: j.location ?? "",
        applyUrl: j.jobUrl ?? `https://jobs.ashbyhq.com/${board.token}/${j.id}`,
      })),
    };
  }
  if (board.ats === "smartrecruiters") {
    const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${board.token}/postings?limit=100`, opts);
    if (!res.ok) return { board, postings: [], fetched: false };
    const data = (await res.json()) as {
      content?: Array<{ id: string; name: string; location?: { city?: string; region?: string; country?: string; remote?: boolean } }>;
    };
    return {
      board,
      fetched: true,
      postings: (data.content ?? []).map((j) => ({
        title: j.name,
        locationRaw: j.location
          ? [j.location.city, j.location.region, j.location.country, j.location.remote ? "Remote" : ""].filter(Boolean).join(", ")
          : "",
        applyUrl: `https://jobs.smartrecruiters.com/${board.token}/${j.id}`,
      })),
    };
  }
  const res = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${board.token}`, opts);
  if (!res.ok) return { board, postings: [], fetched: false };
  const data = (await res.json()) as {
    jobs?: Array<{ title: string; shortcode: string; city?: string; state?: string; country?: string; remote?: boolean; url?: string }>;
  };
  return {
    board,
    fetched: true,
    postings: (data.jobs ?? []).map((j) => ({
      title: j.title,
      locationRaw: [j.city, j.state, j.country, j.remote ? "Remote" : ""].filter(Boolean).join(", "),
      applyUrl: j.url ?? `https://apply.workable.com/${board.token}/j/${j.shortcode}`,
    })),
  };
}
