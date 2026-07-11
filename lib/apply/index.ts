import { chromium, type Page, type Frame } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import type { AtsType } from "@/db/schema";
import { greenhouseJobRef } from "@/lib/ats/questions";
import { extractLiveFields, type LiveField } from "./extract";
import { resolveFieldsWithClaude } from "./resolve";

/**
 * Universal auto-apply: read the form the page ACTUALLY renders (any ATS),
 * answer each field from contact.json + the tailored draft, ask Claude to
 * resolve anything unmatched, fill, attach resume, submit.
 *
 * Headed by default; on CAPTCHA or anything unexpected the browser stays open
 * so you can finish by hand. Workday/LinkedIn (login-walled wizards) are out.
 */

export type ApplyOutcome = {
  status: "submitted" | "filled_no_submit" | "needs_attention" | "error";
  message: string;
  screenshot?: string;
  /** Exact audit trail: every field label → the answer actually put in the form. */
  answers: Array<{ label: string; answer: string }>;
  resumeAttached: boolean;
};

type Contact = Record<string, string>;

const CONTACT_PATH = "./data/contact.json";
const RESUME_PATH = "./data/resume.pdf";
const SHOT_DIR = "./data/apply";

export function loadContact(): Contact {
  if (!existsSync(CONTACT_PATH)) return {};
  return JSON.parse(readFileSync(CONTACT_PATH, "utf-8")) as Contact;
}

/** Prefer contact.json truth over model output for identity fields. */
const CONTACT_RULES: Array<[RegExp, string]> = [
  [/preferred\s*(first\s*)?name/i, "preferredFirstName"],
  [/first\s*name/i, "firstName"],
  [/last\s*name/i, "lastName"],
  [/full\s*name|^name$/i, "fullName"],
  [/e-?mail/i, "email"],
  [/phone/i, "phone"],
  [/linkedin/i, "linkedin"],
  [/website|portfolio|personal\s*site/i, "website"],
  [/current\s*location|^location|city/i, "location"],
  [/^country/i, "country"],
  [/school|university|college/i, "school"],
  [/degree/i, "degree"],
  [/discipline|major|field\s*of\s*study/i, "discipline"],
];

export async function applyToJob(args: {
  url: string;
  ats: AtsType;
  qa: Array<{ question: string; answer: string }>;
  coverLetterMd: string;
  company: string;
  title: string;
  jdText: string;
  submit: boolean;
  headless?: boolean;
  jobTag: string;
}): Promise<ApplyOutcome> {
  if (args.ats === "workday" || args.ats === "linkedin") {
    return {
      status: "error",
      message: `${args.ats} requires an account login — apply manually with the draft`,
      answers: [],
      resumeAttached: false,
    };
  }
  const contact = loadContact();
  mkdirSync(SHOT_DIR, { recursive: true });
  /** Audit trail of what actually went into the form. */
  const audit: Array<{ label: string; answer: string }> = [];

  const browser = await chromium.launch({ headless: args.headless ?? false });
  let keepOpen = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    await page.goto(applicationUrl(args.url, args.ats), { waitUntil: "domcontentloaded", timeout: 45_000 });

    // Work inside the Greenhouse iframe when a company page embeds one.
    const frame = await pickFrame(page);
    await frame
      .locator("input:not([type=hidden]), textarea, select")
      .first()
      .waitFor({ timeout: 30_000 });
    // Let hydration finish COMPLETELY — interacting mid-hydration hits the
    // server-rendered form that React is about to throw away (attached files
    // and filled values silently evaporate).
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_500);

    // 1. What does this form actually ask?
    const fields = await extractLiveFields(frame);
    if (fields.length === 0) {
      return {
        status: "error",
        message: "no fillable form found on the page — apply manually with the draft",
        answers: [],
        resumeAttached: false,
      };
    }

    // 2. Resolve answers: contact.json → tailored draft → Claude for the rest.
    const answers = new Map<number, string>();
    const unresolved: LiveField[] = [];
    const draftAnswers = buildDraftIndex(args.qa);
    for (const f of fields) {
      const code = resolveByCode(f, contact, draftAnswers);
      if (code) answers.set(f.idx, code);
      else unresolved.push(f);
    }
    if (unresolved.length > 0) {
      const fromClaude = await resolveFieldsWithClaude({
        fields: unresolved,
        company: args.company,
        title: args.title,
        jdText: args.jdText,
        coverLetterMd: args.coverLetterMd,
        qa: args.qa,
        contact,
      }).catch(() => new Map<number, string>());
      for (const [i, a] of fromClaude) answers.set(i, a);
    }

    // 3. Resume upload. Preferred: the real user flow — click Attach/Upload and
    // feed the native file chooser (works on React forms that ignore
    // programmatic input changes). Fallback: setInputFiles on the file input.
    let resumeAttached = false;
    if (existsSync(RESUME_PATH)) {
      const attach = frame.getByRole("button", { name: /attach|upload/i }).first();
      if (await attach.isVisible({ timeout: 2_000 }).catch(() => false)) {
        try {
          const [chooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 6_000 }),
            attach.click(),
          ]);
          await chooser.setFiles(RESUME_PATH);
          // waitFor (NOT isVisible — it doesn't wait) for the filename chip,
          // which renders after the async S3 upload completes.
          resumeAttached = await frame
            .getByText(/resume\.pdf/i)
            .first()
            .waitFor({ state: "visible", timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
        } catch {
          // fall through to the input-based path
        }
      }
      if (!resumeAttached) {
        const byId = frame.locator('input#resume[type="file"]');
        const fileInput =
          (await byId.count()) > 0 ? byId.first() : frame.locator('form input[type="file"]').first();
        if ((await fileInput.count()) > 0) {
          await fileInput.setInputFiles(RESUME_PATH).catch(() => {});
          resumeAttached = await fileInput
            .evaluate((el) => ((el as HTMLInputElement).files?.length ?? 0) > 0)
            .catch(() => false);
          await page.waitForTimeout(2_000); // async parse/upload on some ATSes
        }
      }
    }

    // React re-renders (e.g. after the resume upload lands) can wipe our
    // data-aa-idx tags — re-tag before filling. Extraction is deterministic,
    // so idx assignments are stable across passes.
    await extractLiveFields(frame);

    // 4. Fill.
    const filled: string[] = [];
    const missed: string[] = [];
    for (const f of fields) {
      const answer = answers.get(f.idx);
      if (!answer) {
        if (f.required) missed.push(f.label);
        continue;
      }
      const ok = await fillField(frame, page, f, answer);
      (ok ? filled : missed).push(f.label);
      if (ok) audit.push({ label: f.label, answer });
    }

    // 5. Greenhouse-style typed cover letter (best effort; other ATSes get it
    // via a cover-letter/additional-info field answered by the resolver).
    await tryTypedCoverLetter(frame, args.coverLetterMd);

    // 6. Conditional fields can appear only after earlier answers land (e.g.
    // "Please identify your race" after the Hispanic/Latino question). One
    // more extraction pass catches them.
    const secondPass = await extractLiveFields(frame);
    const known = new Set(fields.map((f) => normalizeLabel(f.label)));
    const fresh = secondPass.filter((f) => !known.has(normalizeLabel(f.label)));
    if (fresh.length > 0) {
      const extra = new Map<number, string>();
      const unresolvedFresh: LiveField[] = [];
      for (const f of fresh) {
        const code = resolveByCode(f, contact, draftAnswers);
        if (code) extra.set(f.idx, code);
        else unresolvedFresh.push(f);
      }
      if (unresolvedFresh.length > 0) {
        const fromClaude = await resolveFieldsWithClaude({
          fields: unresolvedFresh,
          company: args.company,
          title: args.title,
          jdText: args.jdText,
          coverLetterMd: args.coverLetterMd,
          qa: args.qa,
          contact,
        }).catch(() => new Map<number, string>());
        for (const [i, a] of fromClaude) extra.set(i, a);
      }
      for (const f of fresh) {
        const a = extra.get(f.idx);
        if (!a) {
          if (f.required) missed.push(f.label);
          continue;
        }
        const ok = await fillField(frame, page, f, a);
        (ok ? filled : missed).push(f.label);
        if (ok) audit.push({ label: f.label, answer: a });
      }
    }

    const filledShot = `${SHOT_DIR}/${args.jobTag}-filled.png`;
    await page.screenshot({ path: filledShot, fullPage: true }).catch(() => {});

    if (!args.submit) {
      await browser.close();
      return {
        status: "filled_no_submit",
        message: `dry run: filled ${filled.length}/${fields.length} fields, resume ${resumeAttached ? "attached" : "NOT attached"}${missed.length ? `, missed: ${missed.join("; ")}` : ""}`,
        screenshot: filledShot,
        answers: audit,
        resumeAttached,
      };
    }

    if (!resumeAttached) {
      keepOpen = !(args.headless ?? false);
      return {
        status: "needs_attention",
        message: "resume didn't attach — add it in the open browser window and hit Submit",
        screenshot: filledShot,
        answers: audit,
        resumeAttached,
      };
    }

    // 6. Submit.
    const submitBtn = frame
      .locator('[data-aa-form] button[type="submit"], [data-aa-form] input[type="submit"], form button[type="submit"]')
      .first();
    if ((await submitBtn.count()) > 0) await submitBtn.click({ timeout: 10_000 });
    else await frame.getByRole("button", { name: /submit|apply/i }).first().click({ timeout: 10_000 });

    const outcome = await waitForSubmitOutcome(frame, page);
    if (outcome === "success") {
      const doneShot = `${SHOT_DIR}/${args.jobTag}-submitted.png`;
      await page.screenshot({ path: doneShot, fullPage: true }).catch(() => {});
      await browser.close();
      return {
        status: "submitted",
        message: `submitted (${filled.length}/${fields.length} fields filled)`,
        screenshot: doneShot,
        answers: audit,
        resumeAttached,
      };
    }

    keepOpen = !(args.headless ?? false);
    return {
      status: "needs_attention",
      message:
        outcome === "captcha"
          ? "CAPTCHA appeared — solve it in the open browser window and hit Submit"
          : `form didn't confirm submission${missed.length ? ` (unanswered: ${missed.join("; ")})` : ""} — check the open browser window`,
      screenshot: filledShot,
      answers: audit,
      resumeAttached,
    };
  } catch (e) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : String(e),
      answers: audit,
      resumeAttached: false,
    };
  } finally {
    if (!keepOpen) await browser.close().catch(() => {});
  }
}

/** Normalize to the page that hosts the actual application form. */
function applicationUrl(url: string, ats: AtsType): string {
  if (ats === "greenhouse") {
    // Board URLs often redirect to company career chrome; the embed URL
    // renders ONLY the form and never redirects.
    const ref = greenhouseJobRef(url, "");
    if (ref) return `https://boards.greenhouse.io/embed/job_app?for=${ref.board}&token=${ref.id}`;
  }
  if (ats === "lever") {
    const m = url.match(/(https?:\/\/jobs(?:\.eu)?\.lever\.co\/[^/?#]+\/[0-9a-f-]+)/i);
    if (m) return `${m[1]}/apply`;
  }
  if (ats === "ashby") {
    const m = url.match(/(https?:\/\/jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f-]+)/i);
    if (m && !/\/application/i.test(url)) return `${m[1]}/application`;
  }
  return url;
}

async function pickFrame(page: Page): Promise<Frame> {
  const hasIframe = await page
    .locator("#grnhse_iframe")
    .waitFor({ timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (hasIframe) {
    for (let i = 0; i < 20; i++) {
      const fr = page.frames().find((f) => /greenhouse\.io/.test(f.url()));
      if (fr) return fr;
      await page.waitForTimeout(500);
    }
  }
  return page.mainFrame();
}

function buildDraftIndex(qa: Array<{ question: string; answer: string }>): Map<string, string> {
  return new Map(qa.map((x) => [normalizeLabel(x.question), x.answer]));
}

function normalizeLabel(s: string): string {
  return s.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveByCode(field: LiveField, contact: Contact, draft: Map<string, string>): string | null {
  for (const [re, key] of CONTACT_RULES) {
    if (re.test(field.label) && contact[key]) return contact[key];
  }
  // Draft label match: exact → camelCase-spaced → loose word match.
  // Loose matching is only safe on SHORT labels (EEOC variants like
  // "Disability Status") — long free-text questions must go to the Claude
  // resolver, or filler-word overlap produces absurd answers.
  const STOPWORDS = /^(what|whats|your|you|will|would|like|this|that|have|does|are|the|and|for|with)$/;
  const label = normalizeLabel(field.label);
  let answer = draft.get(label) ?? null;
  if (!answer) {
    const spaced = normalizeLabel(field.label.replace(/([a-z])([A-Z])/g, "$1 $2"));
    answer = draft.get(spaced) ?? null;
    if (!answer) {
      const words = [...new Set(spaced.split(/\s+/))].filter((w) => w.length > 3 && !STOPWORDS.test(w));
      if (words.length >= 2 && words.length <= 4) {
        for (const [q, a] of draft) {
          if (words.every((w) => q.includes(w))) {
            answer = a;
            break;
          }
        }
      }
    }
  }
  if (!answer) return null;
  // Optioned fields: only accept a code-side answer that maps onto a real option.
  if (field.options && field.options.length > 0 && field.kind !== "combobox") {
    const match = matchOption(field.options, answer);
    return match ?? null; // no match → let Claude pick from the real options
  }
  return answer;
}

function matchOption(options: string[], answer: string): string | null {
  const a = answer.toLowerCase().trim();
  return (
    options.find((o) => o.toLowerCase().trim() === a) ??
    options.find((o) => o.toLowerCase().includes(a.slice(0, 24)) || a.includes(o.toLowerCase())) ??
    null
  );
}

async function fillField(frame: Frame, page: Page, field: LiveField, answer: string): Promise<boolean> {
  const sel = `[data-aa-idx="${field.idx}"]`;
  try {
    if (field.kind === "radio" || field.kind === "checkbox") {
      // Single-option checkbox = boolean toggle (Ashby work-auth etc.):
      // affirmative answer → tick it; anything else → leave alone.
      if (field.kind === "checkbox" && (field.options?.length ?? 0) === 1) {
        if (/^(yes|true|i\s|agree|confirm)/i.test(answer) || matchOption(field.options!, answer)) {
          await forceCheck(frame.locator(sel).first());
          return true;
        }
        return false;
      }
      const wanted = field.kind === "checkbox" ? answer.split(/,\s*/) : [answer];
      let any = false;
      for (const value of wanted) {
        const members = frame.locator(sel);
        const n = await members.count();
        for (let i = 0; i < n; i++) {
          const opt = (await members.nth(i).getAttribute("data-aa-opt")) ?? "";
          if (opt && matchOption([opt], value)) {
            await forceCheck(members.nth(i));
            any = true;
            break;
          }
        }
      }
      return any;
    }

    let control = frame.locator(sel).first();
    if ((await control.count()) === 0) {
      // Tag got wiped by a re-render mid-loop — re-tag and retry once.
      await extractLiveFields(frame).catch(() => {});
      control = frame.locator(sel).first();
      if ((await control.count()) === 0) return false;
    }

    if (field.kind === "select") {
      const target = matchOption(field.options ?? [], answer) ?? answer;
      // force: select2-style widgets keep the native select hidden; the change
      // event from selectOption updates the visible widget.
      await control.selectOption({ label: target }, { force: true, timeout: 5_000 });
      return true;
    }

    if (field.kind === "combobox") {
      await control.click({ timeout: 5_000 });
      // Short option lists open on click — pick directly without typing
      // (react-select inputs can be readonly; fill() breaks the widget).
      const wanted = frame
        .locator('[role="option"]')
        .filter({ hasText: new RegExp(escapeRe(answer.slice(0, 40)), "i") })
        .first();
      if (await visibleWithin(wanted, 2_000)) {
        await wanted.click();
        return true;
      }
      // Long/searchable lists: type to filter, then pick.
      await control.pressSequentially(answer.slice(0, 40), { delay: 15 }).catch(() => {});
      if (await visibleWithin(wanted, 3_000)) {
        await wanted.click();
      } else {
        const firstOption = frame.locator('[role="option"]').first();
        if (await visibleWithin(firstOption, 2_000)) await firstOption.click();
        else await page.keyboard.press("Enter");
      }
      return true;
    }

    await control.fill(answer, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function tryTypedCoverLetter(frame: Frame, coverLetterMd: string): Promise<void> {
  try {
    // Greenhouse renders "Enter manually" under BOTH Resume and Cover Letter;
    // only act when there are two — the last belongs to the cover letter.
    const toggles = frame.getByRole("button", { name: /enter manually/i });
    const n = await toggles.count();
    if (n >= 2) {
      await toggles.last().click({ timeout: 2_000 });
      const box = frame.locator("textarea").last();
      if (await box.isVisible({ timeout: 2_000 }).catch(() => false)) await box.fill(coverLetterMd);
    }
  } catch {
    // best-effort only
  }
}

async function waitForSubmitOutcome(frame: Frame, page: Page): Promise<"success" | "captcha" | "unknown"> {
  const successRe = /thank you|application (has been |was )?(submitted|received)|we('ve| have) received|successfully submitted/i;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const success =
      (await page.getByText(successRe).first().isVisible().catch(() => false)) ||
      (await frame.getByText(successRe).first().isVisible().catch(() => false)) ||
      /confirmation|thank/i.test(page.url());
    if (success) return "success";

    const captcha = await page
      .locator('iframe[src*="recaptcha"], iframe[title*="captcha" i], iframe[src*="hcaptcha"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (captcha) return "captcha";

    await page.waitForTimeout(1_000);
  }
  return "unknown";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * check() fails on inputs whose visual toggle is a sibling element (Ashby).
 * Fall back to a programmatic click, which toggles state + fires change.
 */
async function forceCheck(locator: import("playwright").Locator): Promise<void> {
  try {
    await locator.check({ timeout: 3_000, force: true });
  } catch {
    await locator.evaluate((el) => (el as HTMLInputElement).click());
  }
}

/** isVisible() doesn't wait — this does. */
function visibleWithin(locator: import("playwright").Locator, timeout: number): Promise<boolean> {
  return locator
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}
