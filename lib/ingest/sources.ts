export type RepoSource = {
  key: string;
  owner: string;
  repo: string;
  branch: string;
  readmePath: string;
  kind: "new-grad" | "internship";
};

export const SOURCES: RepoSource[] = [
  {
    key: "simplify-new-grad",
    owner: "SimplifyJobs",
    repo: "New-Grad-Positions",
    branch: "dev",
    readmePath: "README.md",
    kind: "new-grad",
  },
  {
    key: "simplify-summer-2026",
    owner: "SimplifyJobs",
    repo: "Summer2026-Internships",
    branch: "dev",
    readmePath: "README.md",
    kind: "internship",
  },
  {
    // Fall/Winter/Spring co-ops — Tesla, Jane Street Winter Co-Op, etc. live here.
    key: "simplify-off-season-2026",
    owner: "SimplifyJobs",
    repo: "Summer2026-Internships",
    branch: "dev",
    readmePath: "README-Off-Season.md",
    kind: "internship",
  },
  {
    key: "vansh-summer-internships",
    owner: "vanshb03",
    repo: "Summer2026-Internships",
    branch: "dev",
    readmePath: "README.md",
    kind: "internship",
  },
  {
    key: "cvrve-new-grad",
    owner: "cvrve",
    repo: "New-Grad",
    branch: "main",
    readmePath: "README.md",
    kind: "new-grad",
  },
  {
    key: "speedyapply-2026-swe",
    owner: "speedyapply",
    repo: "2026-SWE-College-Jobs",
    branch: "main",
    readmePath: "README.md",
    kind: "new-grad",
  },
  {
    key: "speedyapply-2026-ai",
    owner: "speedyapply",
    repo: "2026-AI-College-Jobs",
    branch: "main",
    readmePath: "README.md",
    kind: "new-grad",
  },
  {
    key: "ambicuity-new-grad",
    owner: "ambicuity",
    repo: "New-Grad-Jobs",
    branch: "main",
    readmePath: "README.md",
    kind: "new-grad",
  },
  {
    key: "zapplyjobs-new-grad-2026",
    owner: "zapplyjobs",
    repo: "New-Grad-Jobs-2026",
    branch: "main",
    readmePath: "README.md",
    kind: "new-grad",
  },
  {
    key: "jobright-new-grad-2026",
    owner: "jobright-ai",
    repo: "2026-Software-Engineer-New-Grad",
    branch: "main",
    readmePath: "README.md",
    kind: "new-grad",
  },
  {
    key: "nuft-quant-2026",
    owner: "northwesternfintech",
    repo: "2026QuantInternships",
    branch: "main",
    readmePath: "README.md",
    kind: "internship",
  },
  {
    key: "nuft-quant-2027",
    owner: "northwesternfintech",
    repo: "2027QuantInternships",
    branch: "main",
    readmePath: "README.md",
    kind: "internship",
  },
];

export function rawUrl(s: RepoSource): string {
  return `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${s.branch}/${s.readmePath}`;
}
