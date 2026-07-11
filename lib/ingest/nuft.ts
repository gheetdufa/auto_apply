/**
 * Parser for northwesternfintech/20XXQuantInternships READMEs, which don't use
 * one big table. Format per firm:
 *
 *   ## Firm Name
 *   **Website**: [Firm](https://boards.greenhouse.io/firmtoken)
 *   **Locations**: Chicago, NYC
 *   |Role|Links|
 *   |----|-----|
 *   |Quant Trading Intern|[Apply](https://...)|
 *
 * Yields the role rows AND the firms' board URLs — the Website links are
 * frequently direct Greenhouse/Lever/Ashby boards, which we feed to the scout
 * so quant postings are caught the moment they drop (even between README updates).
 */

export type NuftRow = { company: string; title: string; locationRaw: string; applyUrl: string };
export type NuftBoard = { ats: "greenhouse" | "lever" | "ashby"; token: string; company: string };

const SKIP_SECTIONS = /^(contributing|using this repository|.*archive.*|faq|notes?)$/i;
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/;
const MD_LINK_G = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const ANY_URL = /https?:\/\/[^\s<>")\]]+/;

/** These repos abbreviate role titles — expand so title filters downstream work. */
const ROLE_EXPANSIONS: Record<string, string> = {
  qt: "Quantitative Trading Intern",
  qr: "Quantitative Research Intern",
  qd: "Quantitative Developer Intern",
  qs: "Quantitative Strategist Intern",
  ml: "Machine Learning Intern",
  swe: "Software Engineering Intern",
  hw: "Hardware Engineering Intern",
  "devops/sre": "DevOps/SRE Intern",
  sre: "Site Reliability Engineering Intern",
};

function expandRole(title: string): string {
  return ROLE_EXPANSIONS[title.toLowerCase().trim()] ?? title;
}

export function parseNuft(md: string): { rows: NuftRow[]; boards: NuftBoard[] } {
  const rows: NuftRow[] = [];
  const boards: NuftBoard[] = [];

  const sections = md.split(/^## +/m).slice(1); // drop preamble
  for (const section of sections) {
    const lines = section.split("\n");
    const company = lines[0].trim();
    if (!company || SKIP_SECTIONS.test(company)) continue;

    let locationRaw = "";
    let websiteUrl = "";
    let inTable = false;
    for (const line of lines.slice(1)) {
      if (/^\*\*Website\*\*/i.test(line)) {
        websiteUrl = line.match(MD_LINK)?.[2] ?? line.match(ANY_URL)?.[0] ?? "";
      } else if (/^\*\*Locations?\*\*/i.test(line)) {
        locationRaw = line.replace(/^\*\*Locations?\*\*:?\s*/i, "").trim();
      } else if (/^\|.*\|/.test(line)) {
        const cells = line.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
        if (cells.length < 2) continue;
        if (/^-+$/.test(cells[0].replace(/[: ]/g, "")) || /^role$/i.test(cells[0])) {
          inTable = true;
          continue;
        }
        if (!inTable) continue;
        const title = expandRole(cells[0].replace(MD_LINK, "$1").replace(/[*_`]/g, "").trim());
        if (!title) continue;
        const linkCell = cells.slice(1).join(" ");
        // One row PER link — firms often list several cities on one line
        // ("✅ Chicago … ✅ Austin"), each with its own posting URL. The link
        // text is a better location than the section-level Locations blurb.
        const links = [...linkCell.matchAll(MD_LINK_G)];
        if (links.length > 0) {
          for (const [, text, url] of links) {
            if (/closed|🔒|❌/i.test(text)) continue;
            const linkLoc = text.replace(/[^\p{L}\p{N}(), .\/-]/gu, "").trim();
            rows.push({ company, title, locationRaw: linkLoc || locationRaw || "Unspecified", applyUrl: url });
          }
        } else {
          const applyUrl = linkCell.match(ANY_URL)?.[0] ?? "";
          if (!applyUrl || /closed|🔒|❌/i.test(linkCell)) continue;
          rows.push({ company, title, locationRaw: locationRaw || "Unspecified", applyUrl });
        }
      }
    }

    const board = parseBoardUrl(websiteUrl, company);
    if (board) boards.push(board);
  }
  return { rows, boards };
}

export function parseBoardUrl(url: string, company: string): NuftBoard | null {
  if (!url) return null;
  const gh = url.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i);
  if (gh && gh[1] !== "embed") return { ats: "greenhouse", token: gh[1], company };
  const lv = url.match(/jobs(?:\.eu)?\.lever\.co\/([^/?#]+)/i);
  if (lv) return { ats: "lever", token: lv[1], company };
  const ab = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
  if (ab) return { ats: "ashby", token: ab[1], company };
  return null;
}
