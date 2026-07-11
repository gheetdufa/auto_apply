import type { AtsType, FormField } from "@/db/schema";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_SELECT_OPTIONS = 40;

export type FetchedForm = { fields: FormField[]; source: "greenhouse" | "fallback" };

/**
 * Canonical questions used when the ATS doesn't expose its form
 * (Lever/Ashby/Workday/custom). Roughly what those forms actually ask.
 */
export const FALLBACK_FIELDS: FormField[] = [
  { label: "Why are you interested in this company?", type: "textarea", required: false },
  { label: "Why this role specifically?", type: "textarea", required: false },
  { label: "What's your work authorization status? Will you now or in the future require sponsorship?", type: "text", required: true },
  { label: "When can you start?", type: "text", required: false },
  { label: "What are your compensation expectations?", type: "text", required: false },
  { label: "Tell us about a project you're proud of and your specific contribution.", type: "textarea", required: false },
  { label: "What programming languages and frameworks are you most comfortable with?", type: "text", required: false },
  { label: "Is there anything else you'd like the hiring team to know?", type: "textarea", required: false },
];

/**
 * Fetch the job's real application-form fields when the ATS exposes them.
 * Greenhouse's public board API does (`?questions=true`); everything else falls back.
 */
export async function fetchFormFields(args: {
  url: string;
  html?: string;
  ats: AtsType;
}): Promise<FetchedForm> {
  if (args.ats === "greenhouse") {
    const gh = await tryGreenhouseForm(args.url, args.html ?? "");
    if (gh && gh.length > 0) return { fields: gh, source: "greenhouse" };
  }
  return { fields: FALLBACK_FIELDS, source: "fallback" };
}

async function tryGreenhouseForm(url: string, html: string): Promise<FormField[] | null> {
  const ref = greenhouseJobRef(url, html);
  if (!ref) return null;
  const api = `https://boards-api.greenhouse.io/v1/boards/${ref.board}/jobs/${ref.id}?questions=true`;
  const res = await fetch(api, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    questions?: GhQuestion[];
    compliance?: Array<{ questions?: GhQuestion[] }>;
  };
  const fields: FormField[] = [];
  for (const q of data.questions ?? []) {
    const f = mapGhQuestion(q);
    if (f) fields.push(f);
  }
  for (const block of data.compliance ?? []) {
    for (const q of block.questions ?? []) {
      const f = mapGhQuestion(q);
      if (f) fields.push(f);
    }
  }
  return fields;
}

type GhQuestion = {
  label?: string;
  required?: boolean;
  fields?: Array<{ type?: string; values?: Array<{ label?: string | number }> }>;
};

function mapGhQuestion(q: GhQuestion): FormField | null {
  const label = (q.label ?? "").trim();
  const f = q.fields?.[0];
  if (!label || !f || f.type === "input_hidden") return null;
  const type: FormField["type"] =
    f.type === "input_file"
      ? "attachment"
      : f.type === "textarea"
        ? "textarea"
        : f.type === "multi_value_single_select"
          ? "select"
          : f.type === "multi_value_multi_select"
            ? "multiselect"
            : "text";
  const field: FormField = { label, type, required: q.required ?? false };
  if (type === "select" || type === "multiselect") {
    const options = (f.values ?? []).map((v) => String(v.label ?? "")).filter(Boolean);
    // Giant lists (schools, countries) get truncated — the model only needs the shape.
    field.options = options.slice(0, MAX_SELECT_OPTIONS);
    if (options.length > MAX_SELECT_OPTIONS) field.options.push("…");
  }
  return field;
}

/**
 * For JS-rendered career pages where the board token isn't in the static HTML:
 * probe the Greenhouse API with board slugs derived from the company name
 * ("Nuro" → nuro, "iXL Learning" → ixllearning/ixl/ixl-learning).
 * Returns the ref on the first slug the API recognizes.
 */
export async function probeGreenhouseBoard(url: string, companyName: string): Promise<{ board: string; id: string } | null> {
  const id = url.match(/[?&]gh_jid=(\d+)/i)?.[1];
  if (!id) return null;
  const lower = companyName.toLowerCase().trim();
  const candidates = [
    ...new Set([
      lower.replace(/[^a-z0-9]+/g, ""),
      lower.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      lower.split(/\s+/)[0].replace(/[^a-z0-9]/g, ""),
    ]),
  ].filter(Boolean);
  for (const board of candidates) {
    try {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { board, id };
    } catch {
      // timeouts/refusals just mean "not this slug"
    }
  }
  return null;
}

/**
 * Resolve the Greenhouse board token + job id from a URL, falling back to the
 * page HTML for company career pages that embed Greenhouse via gh_jid.
 */
export function greenhouseJobRef(url: string, html: string): { board: string; id: string } | null {
  const direct = url.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  if (direct) return { board: direct[1], id: direct[2] };

  const embed = url.match(/greenhouse\.io\/embed\/job_app\?[^#]*for=([a-z0-9_-]+)[^#]*token=(\d+)/i);
  if (embed) return { board: embed[1], id: embed[2] };

  const jid = url.match(/[?&]gh_jid=(\d+)/i);
  if (jid) {
    // Board token lives somewhere in the embedding page's HTML.
    const board =
      html.match(/greenhouse\.io\/embed\/job_(?:app|board)[^"']*[?&]for=([a-z0-9_-]+)/i)?.[1] ??
      html.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i)?.[1] ??
      html.match(/["']boardToken["']\s*:\s*["']([a-z0-9_-]+)["']/i)?.[1];
    if (board && board !== "embed") return { board, id: jid[1] };
  }
  return null;
}
