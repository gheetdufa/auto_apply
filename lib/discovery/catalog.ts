import { SOURCES } from "@/lib/ingest/sources";
import { WATCH_BOARDS } from "@/lib/scout/watch-boards";

export type DiscoverySource = {
  key: string;
  label: string;
  kind: "github-list" | "ats-board" | "careers-site" | "aggregator" | "forum";
  detail: string;
  url?: string;
};

/** Every place Refresh / the watcher currently pulls from. */
export function discoveryCatalog(): DiscoverySource[] {
  const github: DiscoverySource[] = SOURCES.map((s) => ({
    key: s.key,
    label: `${s.owner}/${s.repo}`,
    kind: "github-list",
    detail: s.kind === "internship" ? "Internship list (README table)" : "New-grad list (README table)",
    url: `https://github.com/${s.owner}/${s.repo}`,
  }));

  const boards: DiscoverySource[] = WATCH_BOARDS.map((b) => ({
    key: `watch:${b.ats}:${b.token}`,
    label: `${b.company} (${b.ats}/${b.token})`,
    kind: "ats-board",
    detail: "Curated always-on board poll (early-career / metadata only)",
    url:
      b.ats === "greenhouse"
        ? `https://boards.greenhouse.io/${b.token}`
        : b.ats === "lever"
          ? `https://jobs.lever.co/${b.token}`
          : `https://jobs.ashbyhq.com/${b.token}`,
  }));

  return [
    ...github,
    ...boards,
    {
      key: "scout:db-boards",
      label: "Known ATS boards from your DB",
      kind: "ats-board",
      detail:
        "Every Greenhouse/Lever/Ashby/SmartRecruiters/Workable token mined from jobs you already track, plus YC hiring probes + NUFT quant firm boards",
    },
    {
      key: "scout:google-careers",
      label: "Google Careers",
      kind: "careers-site",
      detail: "US early-career / university SWE roles on careers.google.com",
      url: "https://www.google.com/about/careers/applications/jobs/results/?target_level=EARLY",
    },
    {
      key: "scout:hn",
      label: "HN Who's Hiring",
      kind: "forum",
      detail: "Ask HN monthly thread via Algolia (SF/NYC/remote startups)",
      url: "https://news.ycombinator.com/submitted?id=whoishiring",
    },
    {
      key: "scout:remotive",
      label: "Remotive",
      kind: "aggregator",
      detail: "Remote-US software-dev feed",
      url: "https://remotive.com/remote-jobs/software-dev",
    },
    {
      key: "note:tesla",
      label: "Tesla careers (indirect)",
      kind: "careers-site",
      detail:
        "tesla.com/careers is Akamai-blocked from scrapers — roles arrive via SimplifyJobs GitHub lists (tesla.com/careers/search/job/… URLs). No direct Tesla API scout.",
      url: "https://www.tesla.com/careers/search/?type=intern&site=US",
    },
  ];
}
