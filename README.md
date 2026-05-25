# auto-apply

Local web app that ingests new-grad SWE jobs from 6 GitHub-maintained lists, filters to SF / NYC / Remote-US, and uses Claude to draft tailored cover letters + screening Q answers for each one. Human-in-loop: you review the draft and click through to apply.

## Stack

Next.js 15 (App Router) · React 19 · Tailwind v4 · Drizzle + SQLite · Anthropic SDK · Playwright (v1 — autofill, not in v0).

## First-time setup

```bash
pnpm install
pnpm db:push          # creates data/db.sqlite from schema
cp .env.local.example .env.local
# edit .env.local and put your ANTHROPIC_API_KEY
cp data/profile.md.template data/profile.md
# fill in profile.md — Claude uses this as the source of truth for tailoring
# drop your resume PDF at data/resume.pdf (used in v1 for autofill)
```

Edit `config/screening-answers.json` once with your canonical answers (work auth, comp expectations, start date, etc.). Claude reuses these verbatim.

## Run

```bash
pnpm dev          # http://localhost:3000
pnpm ingest       # one-off ingest from CLI (Refresh button does the same thing)
pnpm db:studio    # browse the DB
```

## Flow

1. **Refresh** (button in inbox) — fetches the 6 source READMEs, parses tables, dedupes across sources, filters to SF/NYC/Remote-US, writes new jobs with status `discovered`.
2. Open a job → **Fetch JD** — pulls the full description (uses Greenhouse/Lever/Ashby APIs when applicable, falls back to Readability).
3. **Generate Draft** — Claude produces a cover letter + answers to 8 canonical screening questions, using your `profile.md` + the JD.
4. Edit anything in the draft (each save creates a new version).
5. **Open application** — opens the apply URL in a new tab. You manually fill the form using the draft (v0). In v1, Playwright will autofill.
6. **Mark Applied** / **Skip** — moves the job through status.

## Sources

- SimplifyJobs/New-Grad-Positions
- SimplifyJobs/Summer2026-Internships
- speedyapply/2026-SWE-College-Jobs
- ambicuity/New-Grad-Jobs
- zapplyjobs/New-Grad-Jobs-2026
- jobright-ai/2026-Software-Engineer-New-Grad

Add or remove in `lib/ingest/sources.ts`.

## Project layout

```
app/                Next.js App Router
  api/              JSON endpoints (refresh, jd, draft, status)
  job/[id]/         Job detail page + components
  _components/      Inbox components
db/                 Drizzle schema + client
lib/
  ingest/           README fetchers, table parsers, dedupe, location classifier
  ats/              ATS URL detection
  jd/               Per-ATS JD fetchers (Greenhouse/Lever/Ashby) + Readability fallback
  tailor/           Claude prompt + generation
config/             screening-answers.json
data/               db.sqlite, profile.md, resume.pdf (gitignored)
scripts/            CLI entry points
```

## Roadmap

- **v0 (now):** ingest, filter, JD fetch, Claude draft, edit, manual apply.
- **v1:** Playwright autofill for Greenhouse / Lever / Ashby (headed browser, you click final Submit).
- **v2:** contact discovery (Hunter.io etc.).
- **later:** Workday adapter, follow-up tracker, rejection logging.

## Notes

- Tailoring uses `claude-sonnet-4-6` by default with prompt caching on system + profile. Override with `ANTHROPIC_MODEL`.
- All data is local. The DB lives at `data/db.sqlite` and is gitignored.
- `pnpm-workspace.yaml` exists only to allowlist native-module build scripts (better-sqlite3 etc.).
