# auto-apply

A local job-search pipeline for new-grad and internship SWE roles. It watches public job lists and ATS boards, surfaces **new postings the moment they appear**, writes **tailored application drafts** keyed to each job's real form questions, and can **auto-fill and submit** applications through Playwright.

Everything runs on your machine. The database, profile, resume, and application history stay local.

## What it does

| Stage | What happens |
|-------|----------------|
| **Ingest** | Pulls 8 GitHub-maintained job lists (SimplifyJobs, speedyapply, NUFT quant repos, etc.), dedupes across sources, filters to SF / NYC / Remote-US SWE and quant roles |
| **Scout** | Polls company ATS boards directly (Greenhouse, Lever, Ashby, SmartRecruiters, Workable), discovers YC startup boards, scans HN "Who's Hiring", and checks Remotive for remote early-career roles |
| **Blocklist** | Drops mega-cap / big-tech companies at ingest time via `config/company-blocklist.json` (Amazon-tier and above) |
| **Enrich** | Follows redirect URLs, detects the real ATS, fetches the job description, and pulls the actual application-form questions |
| **Draft** | Claude writes a cover letter plus an answer for every form field, using your profile and canonical screening answers |
| **Apply** | Playwright opens a headed browser, reads the live form, fills every field, attaches your resume, and submits (or stops before submit if `AUTO_SUBMIT=0`) |
| **Notify** | macOS notification when new jobs land: `auto-apply: 3 new jobs — Nuro — SWE New Grad, +2 more — 3 drafted` |

The inbox is sorted by **release time** (`firstSeenAt`), not when you happened to open the app. A 870-job backfill on first run is normal; focus on **New today** and star/skip from there.

## Stack

Next.js 15 (App Router) · React 19 · Tailwind v4 · Drizzle + SQLite · Anthropic SDK (structured outputs) · Playwright · launchd watcher

## First-time setup

```bash
pnpm install
pnpm db:push                                # creates data/db.sqlite from schema
cp .env.local.example .env.local            # add ANTHROPIC_API_KEY
cp data/profile.md.template data/profile.md # fill in your background
cp resume/resume.pdf data/resume.pdf        # or use your own PDF
pnpm ingest                                 # first run = silent backfill of current listings
pnpm watcher:install                        # optional: launchd ingest every 15 min
pnpm dev                                    # http://localhost:3000
```

The UI shows a setup banner until `.env.local`, `profile.md`, and `resume.pdf` exist.

**One-time config files:**

- `data/profile.md` — your background; drafts are grounded in this
- `data/contact.json` — name, email, phone, LinkedIn, etc. (used by auto-apply for identity fields)
- `config/screening-answers.json` — canonical answers for work auth, comp, start date, EEOC prefs (used verbatim on select fields)
- `config/company-blocklist.json` — companies to exclude entirely (normalized name matching)

For a training-wheels period, set `AUTO_SUBMIT=0` in `.env.local`. The browser fills everything but leaves the final Submit click to you.

## How the pipeline works

Every 15 minutes (launchd watcher) or on **Refresh** in the UI:

1. **Ingest** fetches all source READMEs. Rows are filtered by title (SWE/quant, no sales/HR), location (SF, NYC, remote US, or quant hubs like Chicago/Austin for quant firms), and company blocklist. Jobs explicitly marked closed (🔒) in a source are closed immediately; jobs missing from every source for 24h+ are auto-closed.

2. **Scout** runs four keyless discovery streams:
   - **ATS boards**: polls boards for every known company (~140+ boards, thousands of postings per run). Catches postings before GitHub lists update.
   - **YC discovery**: probes actively-hiring YC companies for Greenhouse/Lever/Ashby boards (20 companies per run, cached in `data/scout-state.json`).
   - **HN**: "Who is hiring" comments plus front-page YC job posts (Algolia + Claude extraction, at most 2×/day).
   - **Remotive**: remote-US software-dev feed, early-career filtered (at most 2×/day).

   Two admission tiers: titles that say new-grad/intern/junior get notify + auto-draft. Generic SWE titles at startups enter quietly ("ambient": visible in inbox, no API spend). A board's first poll seeds quietly; only deltas from already-watched boards count as new releases.

3. **Delta detection**: a job is "released" the first time it appears in any source. The first-ever run (or any insert of 50+ jobs) is treated as backfill: stored, but no notifications or drafts.

4. **Enrich + draft** (new releases only): follow redirects, detect ATS, fetch JD, fetch real form questions (Greenhouse API; canonical fallback for others), then Claude drafts cover letter + per-field answers.

5. **Notify** via macOS `osascript`.

### Auto-apply flow

When you click **Apply** on a drafted job (or run `pnpm apply:batch`):

1. Ensures a draft exists (enriches + tailors if missing)
2. Double-apply guard: warns if you already applied to the same company
3. Launches Playwright (headed by default)
4. Reads whatever form the page actually renders (live DOM extraction)
5. Fills fields from `contact.json` → tailored draft → Claude for anything unmatched
6. Attaches `data/resume.pdf`
7. Submits (unless `AUTO_SUBMIT=0`) or leaves the window open on CAPTCHA / unexpected state

Workday and LinkedIn are login-walled and stay manual. Every attempt is recorded in the `applications` table with per-field audit trail.

## Commands

```bash
pnpm dev                 # UI at http://localhost:3000
pnpm ingest              # run the full pipeline once (what the watcher runs)
pnpm watcher:install     # launchd agent, every 15 min (logs: data/watch.log)
pnpm watcher:status
pnpm watcher:uninstall
pnpm blocklist:sweep     # retroactively skip open jobs from blocklisted companies
pnpm apply:dry <jobId>   # fill a form without submitting (sanity check)
pnpm apply:batch         # batch apply to drafted jobs (--limit, --gap, --starred)
pnpm db:studio           # browse the DB
```

### Resume (LaTeX)

Source lives in `resume/resume.tex` (Jake's Resume template). Compile with:

```bash
cd resume && tectonic resume.tex
```

Copy the output to the apply path when ready:

```bash
cp resume/resume.pdf data/resume.pdf
```

## Sources

Configured in `lib/ingest/sources.ts`:

- SimplifyJobs/New-Grad-Positions
- SimplifyJobs/Summer2026-Internships
- speedyapply/2026-SWE-College-Jobs
- ambicuity/New-Grad-Jobs
- zapplyjobs/New-Grad-Jobs-2026
- jobright-ai/2026-Software-Engineer-New-Grad
- northwesternfintech/2026QuantInternships
- northwesternfintech/2027QuantInternships

## Project layout

```
app/                    Next.js UI (inbox, job detail, API routes)
db/                     Drizzle schema
lib/
  pipeline.ts           ingest → scout → enrich → draft → notify
  ingest/               README fetchers, parsers, dedupe, blocklist, NUFT quant parser
  scout/                ATS board polling, YC discovery, HN, Remotive
  enrich/               per-job: finalUrl + ATS + JD + form questions
  tailor/               Claude draft generation (structured outputs)
  apply/                Playwright auto-apply (live form extraction + fill)
  ats/                  ATS detection + form-question fetching
  jd/                   JD fetchers
  notify.ts             macOS notifications
config/
  screening-answers.json
  company-blocklist.json
data/                   local only (gitignored): db, profile, resume, contact, logs
resume/                 LaTeX resume source + compiled PDF
scripts/
  run-ingest.ts         pipeline CLI
  watcher.ts            launchd install/uninstall
  batch-apply.ts        batch auto-apply
  dry-run-apply.ts      fill without submit
  sweep-blocklist.ts    retroactive blocklist sweep
```

## Notes

- Tailoring defaults to `claude-opus-4-8` with prompt caching. Override with `ANTHROPIC_MODEL` in `.env.local`.
- Drafts and apply answers never use em dashes (style rule in the system prompt).
- Outbound fetches timeout at 20s. Enrichment runs in parallel batches of 5 so one slow career site cannot stall the pipeline.
- The watcher only runs ingest/scout/enrich/draft/notify. It does **not** auto-apply in the background. Applying always requires you to trigger it.

## Roadmap

- **now:** watch → notify → real-form tailored drafts → Playwright auto-apply (Greenhouse, Lever, Ashby, most custom ATSes)
- **next:** per-job tailored resume variants from the LaTeX source
- **later:** contact discovery, follow-up tracker
