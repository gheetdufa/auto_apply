/**
 * Always-on ATS boards we poll every scout run — companies that hide early-career
 * status in metadata (Jane Street) or aren't reliably on GitHub lists yet.
 *
 * startup:false → only explicit early-career / metadata-early roles are admitted
 * (no ambient "Software Engineer" spray).
 */

export type WatchBoard = {
  ats: "greenhouse" | "lever" | "ashby";
  token: string;
  company: string;
  startup: false;
};

export const WATCH_BOARDS: WatchBoard[] = [
  { ats: "greenhouse", token: "janestreet", company: "Jane Street", startup: false },
  { ats: "greenhouse", token: "stripe", company: "Stripe", startup: false },
  { ats: "greenhouse", token: "airbnb", company: "Airbnb", startup: false },
  { ats: "greenhouse", token: "discord", company: "Discord", startup: false },
  { ats: "greenhouse", token: "robinhood", company: "Robinhood", startup: false },
  { ats: "greenhouse", token: "coinbase", company: "Coinbase", startup: false },
  { ats: "greenhouse", token: "databricks", company: "Databricks", startup: false },
  { ats: "greenhouse", token: "figma", company: "Figma", startup: false },
  { ats: "greenhouse", token: "anthropic", company: "Anthropic", startup: false },
  { ats: "ashby", token: "openai", company: "OpenAI", startup: false },
];
