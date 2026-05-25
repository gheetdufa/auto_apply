import type { AtsType } from "@/db/schema";

const ATS_PATTERNS: Array<[RegExp, AtsType]> = [
  [/(?:boards|job-boards)\.greenhouse\.io|grnh\.se/i, "greenhouse"],
  [/jobs\.lever\.co/i, "lever"],
  [/(?:jobs|app)\.ashbyhq\.com/i, "ashby"],
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
