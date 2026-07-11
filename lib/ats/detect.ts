import type { AtsType } from "@/db/schema";

const ATS_PATTERNS: Array<[RegExp, AtsType]> = [
  // gh_jid= is Greenhouse's embed param — company career pages with it are Greenhouse under the hood.
  [/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io|grnh\.se|greenhouse\.io\/embed|[?&]gh_jid=/i, "greenhouse"],
  [/jobs(?:\.eu)?\.lever\.co/i, "lever"],
  [/ashbyhq\.com/i, "ashby"],
  [/myworkdayjobs\.com|workday\.com/i, "workday"],
  [/wellfound\.com|angel\.co/i, "wellfound"],
  [/linkedin\.com\/jobs/i, "linkedin"],
];

export function detectAts(url: string): AtsType {
  if (!url) return "unknown";
  try {
    for (const [re, t] of ATS_PATTERNS) if (re.test(url)) return t;
    return "custom";
  } catch {
    return "unknown";
  }
}
