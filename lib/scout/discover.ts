import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * Board discovery: find ATS boards for companies we've never seen, so the
 * scout isn't limited to companies already in the DB.
 *
 * Source: yc-oss/api — daily-updated static JSON of all YC companies with an
 * isHiring flag (~1.5k hiring). We filter to US-relevant ones and probe each
 * company's likely Greenhouse/Lever/Ashby board slug. Results (hits AND
 * misses) persist in data/scout-state.json, so probing spreads across watcher
 * runs at a bounded request budget until the queue is drained; new YC batches
 * get picked up as they appear.
 */

const STATE_PATH = "./data/scout-state.json";
const YC_HIRING_URL = "https://yc-oss.github.io/api/companies/hiring.json";
const YC_REFETCH_MS = 6 * 60 * 60 * 1000;
const PROBE_BUDGET_PER_RUN = 20; // companies per run (≤ ~9 requests each)

export type DiscoveredBoard = {
  ats: "greenhouse" | "lever" | "ashby";
  token: string;
  company: string;
  startup: true;
};

type ScoutState = {
  lastHnScanAt?: number;
  lastRemoteScanAt?: number;
  lastYcFetchAt?: number;
  ycQueue?: Array<{ name: string; slug: string; website?: string }>;
  /** company slug → discovered board, or null when all probes missed */
  ycProbed?: Record<string, DiscoveredBoard | null>;
  /** "ats:token" keys of boards that have completed at least one poll. */
  polledBoards?: string[];
  /** One-time flag: quant firm seeds pushed into the probe queue. */
  quantSeeded?: boolean;
  /** Boards registered by ingests (NUFT firm websites etc.). */
  extraBoards?: DiscoveredBoard[];
};

export type DiscoverResult = { probed: number; hits: number; queueRemaining: number };

/**
 * Quant firms — hand-curated probe seeds (they aren't in the YC list and their
 * campus roles drop in one seasonal burst). Probed once like YC companies;
 * whichever have public GH/Lever/Ashby boards join the watch list.
 */
const QUANT_SEEDS: Array<{ name: string; slug: string }> = [
  { name: "Hudson River Trading", slug: "wehrtyou" },
  { name: "Jump Trading", slug: "jumptrading" },
  { name: "Two Sigma", slug: "twosigma" },
  { name: "Optiver", slug: "optiver" },
  { name: "IMC Trading", slug: "imc" },
  { name: "DRW", slug: "drweng" },
  { name: "Akuna Capital", slug: "akunacapital" },
  { name: "Five Rings", slug: "fiverings" },
  { name: "Tower Research Capital", slug: "towerresearchcapital" },
  { name: "Old Mission", slug: "oldmissioncapital" },
  { name: "Belvedere Trading", slug: "belvederetrading" },
  { name: "Chicago Trading Company", slug: "chicagotrading" },
  { name: "XTX Markets", slug: "xtxmarkets" },
  { name: "Squarepoint Capital", slug: "squarepoint" },
  { name: "Radix Trading", slug: "radixtrading" },
  { name: "Headlands Technologies", slug: "headlandstech" },
  { name: "PEAK6", slug: "peak6" },
  { name: "Flow Traders", slug: "flowtraders" },
  { name: "Millennium", slug: "millennium" },
  { name: "Point72", slug: "point72" },
  { name: "Balyasny Asset Management", slug: "balyasny" },
  { name: "Schonfeld", slug: "schonfeld" },
  { name: "Voleon", slug: "voleon" },
  { name: "PDT Partners", slug: "pdtpartners" },
  { name: "Geneva Trading", slug: "genevatrading" },
  { name: "DV Trading", slug: "dvtrading" },
  { name: "TransMarket Group", slug: "transmarketgroup" },
  { name: "Wolverine Trading", slug: "wolverinetrading" },
  { name: "Group One Trading", slug: "grouponetrading" },
  { name: "Aquatic Capital Management", slug: "aquaticcapital" },
];

export async function discoverYcBoards(): Promise<DiscoverResult> {
  const state = loadState();
  state.ycProbed ??= {};

  // One-time: put quant firms at the FRONT of the probe queue (season is live).
  const probedSoFar = state.ycProbed;
  if (!state.quantSeeded) {
    const queued = new Set((state.ycQueue ?? []).map((q) => q.slug));
    state.ycQueue = [
      ...QUANT_SEEDS.filter((q) => !queued.has(q.slug) && !(q.slug in probedSoFar)),
      ...(state.ycQueue ?? []),
    ];
    state.quantSeeded = true;
    saveState(state);
  }

  // Refresh the hiring list periodically; enqueue companies we haven't probed.
  if (Date.now() - (state.lastYcFetchAt ?? 0) > YC_REFETCH_MS) {
    try {
      const res = await fetch(YC_HIRING_URL, { signal: AbortSignal.timeout(20_000) });
      const companies = (await res.json()) as Array<{
        name: string;
        slug: string;
        website?: string;
        all_locations?: string;
        status?: string;
      }>;
      const US_RE = /(san francisco|bay area|new york|nyc|remote|united states|palo alto|mountain view|oakland|brooklyn)/i;
      const fresh = companies.filter(
        (c) =>
          c.status !== "Inactive" &&
          (!c.all_locations || US_RE.test(c.all_locations)) &&
          !(c.slug in state.ycProbed!),
      );
      const queued = new Set((state.ycQueue ?? []).map((q) => q.slug));
      state.ycQueue = [
        ...(state.ycQueue ?? []),
        ...fresh.filter((c) => !queued.has(c.slug)).map((c) => ({ name: c.name, slug: c.slug, website: c.website })),
      ];
      state.lastYcFetchAt = Date.now();
    } catch {
      // network hiccup — try again next refetch window
    }
  }

  // Probe a bounded batch this run.
  const batch = (state.ycQueue ?? []).slice(0, PROBE_BUDGET_PER_RUN);
  let hits = 0;
  const results = await Promise.allSettled(batch.map((c) => probeCompany(c)));
  results.forEach((r, i) => {
    const company = batch[i];
    const board = r.status === "fulfilled" ? r.value : null;
    state.ycProbed![company.slug] = board;
    if (board) hits += 1;
  });
  state.ycQueue = (state.ycQueue ?? []).slice(batch.length);
  saveState(state);

  return { probed: batch.length, hits, queueRemaining: state.ycQueue.length };
}

/** All boards discovered so far (consumed by the board scout every run). */
export function getDiscoveredBoards(): DiscoveredBoard[] {
  const state = loadState();
  const probed = Object.values(state.ycProbed ?? {}).filter((b): b is DiscoveredBoard => b !== null);
  return [...probed, ...(state.extraBoards ?? [])];
}

/** Register boards found by other ingests (e.g. NUFT quant firm websites). */
export function addExtraBoards(boards: Array<{ ats: "greenhouse" | "lever" | "ashby"; token: string; company: string }>): number {
  const state = loadState();
  const existing = new Set(
    [...(state.extraBoards ?? []), ...Object.values(state.ycProbed ?? {}).filter((b) => b !== null)].map(
      (b) => `${b!.ats}:${b!.token.toLowerCase()}`,
    ),
  );
  let added = 0;
  for (const b of boards) {
    const key = `${b.ats}:${b.token.toLowerCase()}`;
    if (existing.has(key)) continue;
    existing.add(key);
    state.extraBoards = [...(state.extraBoards ?? []), { ...b, startup: true }];
    added += 1;
  }
  if (added > 0) saveState(state);
  return added;
}

async function probeCompany(c: { name: string; slug: string; website?: string }): Promise<DiscoveredBoard | null> {
  const lower = c.name.toLowerCase().trim();
  const domainBase = c.website?.match(/https?:\/\/(?:www\.)?([^./]+)/)?.[1];
  const candidates = [
    ...new Set(
      [c.slug, lower.replace(/[^a-z0-9]+/g, ""), lower.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), domainBase]
        .filter((s): s is string => !!s && s.length > 1),
    ),
  ].slice(0, 3);

  for (const token of candidates) {
    const opts = { headers: { "User-Agent": "auto-apply-scout/0.1" }, signal: AbortSignal.timeout(8_000) };
    const [gh, lv, ab] = await Promise.allSettled([
      fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, opts),
      fetch(`https://api.lever.co/v0/postings/${token}?mode=json&limit=1`, opts),
      fetch(`https://api.ashbyhq.com/posting-api/job-board/${token}`, opts),
    ]);
    if (gh.status === "fulfilled" && gh.value.ok) {
      const data = (await gh.value.json().catch(() => null)) as { jobs?: unknown[] } | null;
      if (data?.jobs) return { ats: "greenhouse", token, company: c.name, startup: true };
    }
    if (lv.status === "fulfilled" && lv.value.ok) {
      const data = (await lv.value.json().catch(() => null)) as unknown;
      if (Array.isArray(data)) return { ats: "lever", token, company: c.name, startup: true };
    }
    if (ab.status === "fulfilled" && ab.value.ok) {
      const data = (await ab.value.json().catch(() => null)) as { jobs?: unknown[] } | null;
      if (data?.jobs) return { ats: "ashby", token, company: c.name, startup: true };
    }
  }
  return null;
}

export function loadState(): ScoutState {
  try {
    return existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, "utf-8")) as ScoutState) : {};
  } catch {
    return {};
  }
}

export function saveState(s: ScoutState): void {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
