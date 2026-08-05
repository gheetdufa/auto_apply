import { chromium, type Browser, type Page, type Frame } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { AtsType } from "@/db/schema";
import { greenhouseJobRef } from "@/lib/ats/questions";
import { extractLiveFields, type LiveField } from "./extract";
import { resolveFieldsWithClaude } from "./resolve";
import { resumePathForJob, contactOverridesForKind, transcriptPath } from "@/lib/resume/paths";
import { emailCodeReady, fetchEmailCode } from "./email-code";
import { ApplyDebugLog } from "./debug-log";
import type { JobKind } from "@/db/schema";

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
  /** Path to data/apply/<jobTag>-debug.log for diagnosing captcha/CSP/428. */
  debugLogPath?: string;
  /**
   * Set on needs_attention when the window stays open: a watcher keeps driving
   * it — auto-fills the email verification code once the user submits manually
   * — and resolves with the finish (or null if the window closes / times out).
   */
  assist?: Promise<AssistFinish | null>;
};

export type AssistFinish = { screenshot?: string };

type Contact = Record<string, string>;

const CONTACT_PATH = "./data/contact.json";
const SHOT_DIR = "./data/apply";

export function loadContact(): Contact {
  if (!existsSync(CONTACT_PATH)) return {};
  return JSON.parse(readFileSync(CONTACT_PATH, "utf-8")) as Contact;
}

/** The recruiter-visible upload name, e.g. "Dheer_Guda_Resume.pdf". */
function resumeUploadName(contact: Contact): string {
  const name = (contact.fullName ?? "").trim().replace(/\s+/g, "_");
  return name ? `${name}_Resume.pdf` : "Resume.pdf";
}

/**
 * Prefer contact.json truth over model output for identity fields.
 * Patterns must be tight: `\bschool\b` alone matches "High School" and dumps
 * the college name into the wrong Greenhouse education field.
 */
const CONTACT_RULES: Array<[RegExp, string]> = [
  [/preferred\s*(first\s*)?name/i, "preferredFirstName"],
  [/first\s*name/i, "firstName"],
  [/last\s*name/i, "lastName"],
  [/full\s*name|^name$/i, "fullName"],
  [/e-?mail/i, "email"],
  [/\bphone\b/i, "phone"],
  [/linkedin/i, "linkedin"],
  [/\bgithub\b/i, "github"],
  [/\bwebsite\b|portfolio|personal\s*site/i, "website"],
  [/current\s*location|^(location|city)\b/i, "location"],
  [/^country\b/i, "country"],
  // Institution only — not "high school", "university email", etc.
  [/^(school|university|college)\b|\b(school|university|college)\s*name\b/i, "school"],
  // Degree type only — not "degree date" / long policy text.
  [/^(degree)\b|\bdegree\s*(type|name)\b/i, "degree"],
  // "major" must be a whole word — otherwise Notion's "majority of their week"
  // matches and we fill the in-office Yes/No with "Computer Science & Math".
  [/^(discipline|major)\b|\bmajors?\b|field\s+of\s+study/i, "discipline"],
  // College/university graduation — never high school.
  [/anticipated\s+graduation|expected\s+graduation|\bgraduation\s*date\b|class\s*of/i, "graduation"],
  [/\bgpa\b|grade\s*point/i, "gpa"],
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
  /** Selects B.S. vs B.S./M.S. resume + contact graduation overrides. */
  kind?: JobKind;
  /** When set, prefers data/resumes/<jobId>.pdf if a tailored resume exists. */
  jobId?: number;
}): Promise<ApplyOutcome> {
  const log = new ApplyDebugLog(args.jobTag);
  const done = (outcome: ApplyOutcome): ApplyOutcome => ({ ...outcome, debugLogPath: log.path });

  if (args.ats === "workday" || args.ats === "linkedin") {
    log.error("unsupported ATS", { ats: args.ats });
    return done({
      status: "error",
      message: `${args.ats} requires an account login — apply manually with the draft`,
      answers: [],
      resumeAttached: false,
    });
  }
  const contact = { ...loadContact(), ...contactOverridesForKind(args.kind) };
  const resumePath = resumePathForJob(args.jobId, args.kind);
  // Upload under one standard name: ATSes show the file name to recruiters,
  // and the internal storage key ("871.pdf") must never leak there.
  const resumeFileName = resumeUploadName(contact);
  const resumeUpload = () => ({
    name: resumeFileName,
    mimeType: "application/pdf",
    buffer: readFileSync(resumePath),
  });
  mkdirSync(SHOT_DIR, { recursive: true });
  /** Audit trail of what actually went into the form. */
  const audit: Array<{ label: string; answer: string }> = [];
  const targetUrl = applicationUrl(args.url, args.ats);
  log.info("apply start", {
    jobTag: args.jobTag,
    jobId: args.jobId,
    company: args.company,
    title: args.title,
    ats: args.ats,
    sourceUrl: args.url,
    targetUrl,
    submit: args.submit,
    resumePath,
    resumeExists: existsSync(resumePath),
  });

  const headless = args.headless ?? false;
  const browser = await chromium.launch({
    headless,
    args: headless ? [] : ["--window-size=1280,960"],
  });
  let keepOpen = false;
  try {
    // Headed: viewport must track the real window (viewport: null). A fixed
    // 1600px-tall emulated viewport "fits" the page, so Chromium has nothing
    // to scroll — stranding the user below the fold when the window is left
    // open for CAPTCHA / needs_attention. Headless keeps the tall viewport
    // for consistent full-page screenshots.
    const page = await browser.newPage(
      headless ? { viewport: { width: 1280, height: 1600 } } : { viewport: null },
    );
    // Reap the process when the user closes the window: on macOS Chromium
    // stays alive (Dock icon, no windows) after its last window closes, so
    // "Chrome for Testing" would linger forever. Closing via browser.close()
    // fires this too — the second close is a no-op.
    page.on("close", () => {
      log.info("browser page closed");
      void browser.close().catch(() => {});
    });
    const net: ApplyNetState = { saw428: false, last428Body: "" };
    attachApplyNetworkLogging(page, log, net);
    if (args.ats === "greenhouse") await patchGreenhouseRecaptchaCsp(page, log);
    log.info("navigating", { targetUrl });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    log.info("landed", { url: page.url(), title: await page.title().catch(() => "") });

    await dismissCookieBanners(page, log);
    await openEmbeddedApplyIfNeeded(page, log);

    // Work inside the Greenhouse iframe when a company page embeds one.
    const frame = await pickFrame(page);
    log.info("form frame", { url: frame.url(), isMain: frame === page.mainFrame() });
    await waitForApplicationControls(frame, log);
    // Let hydration finish COMPLETELY — interacting mid-hydration hits the
    // server-rendered form that React is about to throw away (attached files
    // and filled values silently evaporate).
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_500);

    // 1. What does this form actually ask?
    const fields = await extractLiveFields(frame);
    log.info("extracted fields", {
      count: fields.length,
      labels: fields.map((f) => `${f.kind}:${f.required ? "*" : ""}${f.label.slice(0, 80)}`),
    });
    if (fields.length === 0) {
      return done({
        status: "error",
        message: "no fillable form found on the page — apply manually with the draft",
        answers: [],
        resumeAttached: false,
      });
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
    log.info("answer resolve", {
      fromContactOrDraft: answers.size,
      needsClaude: unresolved.length,
      unresolvedLabels: unresolved.map((f) => f.label.slice(0, 80)),
    });
    if (unresolved.length > 0) {
      const fromClaude = await resolveFieldsWithClaude({
        fields: unresolved,
        company: args.company,
        title: args.title,
        jdText: args.jdText,
        coverLetterMd: args.coverLetterMd,
        qa: args.qa,
        contact,
      }).catch((e) => {
        log.warn("claude resolve failed", e instanceof Error ? e.message : String(e));
        return new Map<number, string>();
      });
      for (const [i, a] of fromClaude) answers.set(i, a);
      log.info("claude resolve done", { answered: fromClaude.size });
    }

    // 3. Resume upload. Preferred: the real user flow — click Attach/Upload and
    // feed the native file chooser (works on React forms that ignore
    // programmatic input changes). Fallback: setInputFiles on the file input.
    let resumeAttached = false;
    if (existsSync(resumePath)) {
      const attach = frame.getByRole("button", { name: /attach|upload/i }).first();
      if (await attach.isVisible({ timeout: 2_000 }).catch(() => false)) {
        try {
          const [chooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 6_000 }),
            attach.click(),
          ]);
          await chooser.setFiles(resumeUpload());
          // waitFor (NOT isVisible — it doesn't wait) for the filename chip,
          // which renders after the async S3 upload completes.
          resumeAttached = await frame
            .getByText(new RegExp(resumeFileName.replace(".", "\\."), "i"))
            .first()
            .waitFor({ state: "visible", timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
          // Some ATSes normalize the displayed name to "resume.pdf".
          if (!resumeAttached) {
            resumeAttached = await frame
              .getByText(/resume/i)
              .first()
              .waitFor({ state: "visible", timeout: 5_000 })
              .then(() => true)
              .catch(() => false);
          }
        } catch {
          // fall through to the input-based path
        }
      }
      if (!resumeAttached) {
        try {
          const byId = frame.locator('input#resume[type="file"]');
          const fileInput =
            (await byId.count()) > 0 ? byId.first() : frame.locator('form input[type="file"]').first();
          if ((await fileInput.count()) > 0) {
            await fileInput.setInputFiles(resumeUpload()).catch(() => {});
            resumeAttached = await fileInput
              .evaluate((el) => ((el as HTMLInputElement).files?.length ?? 0) > 0)
              .catch(() => false);
            await page.waitForTimeout(2_000);
          }
        } catch {
          // Browser closed mid-upload (common when CAPTCHA / user dismisses).
        }
      }
    }

    log.info("resume attach", { resumeAttached, resumeFileName });

    const extraFiles = await attachExtraUploads(frame, page, log);
    log.info("extra file uploads", extraFiles);

    // React re-renders (e.g. after the resume upload lands) can wipe our
    // data-aa-idx tags — re-extract and remap answers by label so fills don't
    // target stale idxs after Ashby remounts controls.
    const answersByLabel = new Map<string, string>();
    for (const f of fields) {
      const a = answers.get(f.idx);
      if (a) answersByLabel.set(normalizeLabel(f.label), a);
    }
    let liveFields = await extractLiveFields(frame);
    const fillAnswers = new Map<number, string>();
    for (const f of liveFields) {
      const a = answersByLabel.get(normalizeLabel(f.label));
      if (a) fillAnswers.set(f.idx, a);
    }

    // 4. Fill.
    const filled: string[] = [];
    const missed: string[] = [];
    for (const f of liveFields) {
      const answer = fillAnswers.get(f.idx);
      if (!answer) {
        if (f.required) missed.push(f.label);
        log.warn("no answer for field", { label: f.label, required: f.required });
        continue;
      }
      const ok = await fillField(frame, page, f, answer);
      (ok ? filled : missed).push(f.label);
      if (ok) audit.push({ label: f.label, answer });
      else log.warn("fill failed", { label: f.label, kind: f.kind, answerPreview: answer.slice(0, 80) });
    }
    log.info("fill pass complete", { filled: filled.length, missed: missed.length, missedLabels: missed });

    // 5. Greenhouse-style typed cover letter (best effort; other ATSes get it
    // via a cover-letter/additional-info field answered by the resolver).
    await tryTypedCoverLetter(frame, args.coverLetterMd);

    // 6. Conditional fields can appear only after earlier answers land (e.g.
    // "Please identify your race" after the Hispanic/Latino question). One
    // more extraction pass catches them.
    const secondPass = await extractLiveFields(frame);
    const known = new Set(liveFields.map((f) => normalizeLabel(f.label)));
    const fresh = secondPass.filter((f) => !known.has(normalizeLabel(f.label)));
    if (fresh.length > 0) {
      const extra = new Map<number, string>();
      const unresolvedFresh: LiveField[] = [];
      for (const f of fresh) {
        const code = resolveByCode(f, contact, draftAnswers);
        if (code) {
          extra.set(f.idx, code);
          answersByLabel.set(normalizeLabel(f.label), code);
        } else unresolvedFresh.push(f);
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
        for (const [i, a] of fromClaude) {
          extra.set(i, a);
          const lab = unresolvedFresh.find((x) => x.idx === i)?.label;
          if (lab) answersByLabel.set(normalizeLabel(lab), a);
        }
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
      liveFields = secondPass;
      for (const f of liveFields) {
        const a = answersByLabel.get(normalizeLabel(f.label));
        if (a) fillAnswers.set(f.idx, a);
      }
    }

    // 7. Verify required controls still hold values (Ashby/React often clear a
    // prior Yes/No when a later field remounts). Retry empties once by label.
    const retried = await refillEmptyRequired(frame, page, liveFields, answersByLabel, log);
    for (const r of retried) {
      if (!audit.some((a) => normalizeLabel(a.label) === normalizeLabel(r.label))) {
        audit.push(r);
      }
      const mi = missed.findIndex((m) => normalizeLabel(m) === normalizeLabel(r.label));
      if (mi >= 0) missed.splice(mi, 1);
      if (!filled.some((x) => normalizeLabel(x) === normalizeLabel(r.label))) filled.push(r.label);
    }

    const filledShot = `${SHOT_DIR}/${args.jobTag}-filled.png`;
    await page.screenshot({ path: filledShot, fullPage: true }).catch(() => {});

    if (!args.submit) {
      await browser.close();
      return done({
        status: "filled_no_submit",
        message: `dry run: filled ${filled.length}/${fields.length} fields, resume ${resumeAttached ? "attached" : "NOT attached"}${missed.length ? `, missed: ${missed.join("; ")}` : ""}`,
        screenshot: filledShot,
        answers: audit,
        resumeAttached,
      });
    }

    if (!resumeAttached) {
      keepOpen = !headless;
      log.warn("resume not attached — leaving window open");
      return done({
        status: "needs_attention",
        message: `resume didn't attach — add it in the open browser window and hit Submit${keepOpen ? "; still watching: the email code will auto-fill and the result gets recorded" : ""} (debug: ${log.path})`,
        screenshot: filledShot,
        answers: audit,
        resumeAttached,
        assist: keepOpen ? watchManualFinish(frame, page, browser, args.jobTag, { log }) : undefined,
      });
    }

    // 6. Submit.
    const submittedAt = new Date();
    if (args.ats === "greenhouse") await primeGreenhouseRecaptcha(page, log);
    log.info("clicking submit");
    const submitBtn = frame
      .locator('[data-aa-form] button[type="submit"], [data-aa-form] input[type="submit"], form button[type="submit"]')
      .first();
    if ((await submitBtn.count()) > 0) await submitBtn.click({ timeout: 10_000 });
    else await frame.getByRole("button", { name: /submit|apply/i }).first().click({ timeout: 10_000 });

    let outcome = await waitForSubmitOutcome(frame, page, log);
    // 428 beats heuristics — Greenhouse rejected the captcha/bot check.
    if (net.saw428 && outcome !== "success") {
      log.error("overriding outcome to captcha due to HTTP 428", { previous: outcome, body: net.last428Body });
      outcome = "captcha";
    }
    log.info("submit outcome", { outcome, pageUrl: page.url(), saw428: net.saw428 });

    // Greenhouse email-verification gate: it emails a security code to the
    // application address and blocks on it. Pull the code from the inbox over
    // IMAP and type it in; on any failure the normal needs_attention path
    // leaves the window open for manual entry.
    if (outcome === "email_code" && !net.saw428 && emailCodeReady()) {
      log.info("fetching email verification code");
      const code = await fetchEmailCode({ since: submittedAt });
      log.info("email code", { found: !!code });
      if (code && (await fillVerificationCode(frame, page, code))) {
        outcome = await waitForSubmitOutcome(frame, page, log);
        if (net.saw428 && outcome !== "success") outcome = "captcha";
        log.info("post-code outcome", { outcome, saw428: net.saw428 });
      }
    }
    if (outcome === "success") {
      const doneShot = `${SHOT_DIR}/${args.jobTag}-submitted.png`;
      await page.screenshot({ path: doneShot, fullPage: true }).catch(() => {});
      await browser.close();
      return done({
        status: "submitted",
        message: `submitted (${filled.length}/${fields.length} fields filled)`,
        screenshot: doneShot,
        answers: audit,
        resumeAttached,
      });
    }

    keepOpen = !headless;
    const attention = net.saw428
      ? "Greenhouse blocked submit (HTTP 428) — their bot/captcha check rejected the automated token. In the open window, solve any CAPTCHA if shown and click Submit yourself"
      : outcome === "captcha"
        ? "CAPTCHA appeared — solve it in the open browser window and hit Submit"
        : outcome === "email_code"
          ? `email verification — enter the code from your inbox in the open browser window${emailCodeReady() ? " (auto-fill couldn't find/enter it yet)" : "; set EMAIL_IMAP_USER + EMAIL_IMAP_PASS in .env.local to auto-fill next time"}`
          : `form didn't confirm submission${missed.length ? ` (unanswered: ${missed.join("; ")})` : ""} — check the open browser window`;
    log.warn("needs attention", { outcome, saw428: net.saw428, attention, debugLogPath: log.path });
    return done({
      status: "needs_attention",
      message: keepOpen
        ? `${attention} — still watching (debug: ${log.path})`
        : `${attention} (debug: ${log.path})`,
      screenshot: filledShot,
      answers: audit,
      resumeAttached,
      assist: keepOpen
        ? watchManualFinish(frame, page, browser, args.jobTag, { emailSince: submittedAt, log })
        : undefined,
    });
  } catch (e) {
    log.error("apply crashed", e instanceof Error ? e.stack ?? e.message : String(e));
    return done({
      status: "error",
      message: `${e instanceof Error ? e.message : String(e)} (debug: ${log.path})`,
      answers: audit,
      resumeAttached: false,
    });
  } finally {
    if (!keepOpen) await browser.close().catch(() => {});
  }
}

/** Normalize to the page that hosts the actual application form. */
function applicationUrl(url: string, ats: AtsType): string {
  if (ats === "greenhouse") {
    // Use the embed form URL. Plain job-boards URLs (e.g. Databricks) often
    // 302 into a company careers page with only "Apply now" + OneTrust — no
    // fillable fields until the embed iframe opens. Embed always hosts the form.
    const ref = greenhouseJobRef(url, "");
    if (ref) return `https://job-boards.greenhouse.io/embed/job_app?for=${ref.board}&token=${ref.id}`;
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

/**
 * Greenhouse Lotus sets GOOGLE_RECAPTCHA_ENDPOINT to www.recaptcha.net, but its
 * Content-Security-Policy connect-src only allows www.google.com — so Enterprise
 * reCAPTCHA's /clr beacon is blocked, the widget hangs, and submit returns 428.
 * Rewrite recaptcha.net → www.google.com (same keys, allowed by CSP).
 */
async function patchGreenhouseRecaptchaCsp(page: Page, log: ApplyDebugLog): Promise<void> {
  log.info("installing Greenhouse reCAPTCHA CSP rewrite (recaptcha.net → www.google.com)");
  // Network calls from the widget (clr, reload, …).
  await page.route("https://www.recaptcha.net/**", async (route) => {
    const from = route.request().url();
    const url = from.replace(/www\.recaptcha\.net/i, "www.google.com");
    log.info("rewrite recaptcha request", { from, to: url });
    await route.continue({ url });
  });
  // HTML bootstrapping ENV.GOOGLE_RECAPTCHA_ENDPOINT on Greenhouse hosts.
  await page.route(/greenhouse\.io\/.*(jobs|embed|job_app)/i, async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    try {
      const res = await route.fetch();
      let body = await res.text();
      const hadRecaptchaNet = /recaptcha\.net/i.test(body);
      if (hadRecaptchaNet) {
        body = body
          .replace(/https:\/\/www\.recaptcha\.net/gi, "https://www.google.com")
          .replace(/\/\/www\.recaptcha\.net/gi, "//www.google.com");
        log.info("rewrote recaptcha.net in Greenhouse HTML", { url: route.request().url() });
      } else {
        log.info("Greenhouse HTML had no recaptcha.net endpoint", { url: route.request().url() });
      }
      await route.fulfill({ response: res, body });
    } catch (e) {
      log.warn("Greenhouse HTML rewrite failed", e instanceof Error ? e.message : String(e));
      await route.continue().catch(() => {});
    }
  });
}

type ApplyNetState = { saw428: boolean; last428Body: string };

/** Capture console + interesting network traffic for captcha / 428 diagnosis. */
function attachApplyNetworkLogging(page: Page, log: ApplyDebugLog, net: ApplyNetState): void {
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      /recaptcha|captcha|content security policy|violates|428|unauthorized|csp/i.test(text) ||
      msg.type() === "error"
    ) {
      log.warn(`browser console [${msg.type()}]`, text.slice(0, 500));
    }
  });
  page.on("pageerror", (err) => {
    // Greenhouse Job Seekers guest path always throws this — noise.
    if (/user is not logged in/i.test(err.message)) {
      log.info("pageerror (expected guest)", err.message);
      return;
    }
    log.error("pageerror", err.message);
  });
  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    const method = res.request().method();
    const interesting =
      status >= 400 ||
      /recaptcha|hcaptcha|searchLocations|greenhouse\.io\/.*jobs|my\.greenhouse/i.test(url);
    if (!interesting) return;
    // 401 on my.greenhouse.io/users/self is expected when not logged in.
    if (status === 401 && /my\.greenhouse\.io\/users\/self/i.test(url)) {
      log.info("network (expected guest 401)", { status, url: url.slice(0, 180) });
      return;
    }
    if (status === 428) {
      net.saw428 = true;
      void res
        .text()
        .then((body) => {
          net.last428Body = body.slice(0, 1200);
          log.error("network 428 Precondition Required", {
            method,
            url: url.slice(0, 220),
            body: net.last428Body,
          });
        })
        .catch(() => {
          log.error("network 428 Precondition Required", { method, url: url.slice(0, 220) });
        });
      return;
    }
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    log[level]("network", { status, method, url: url.slice(0, 220) });
  });
  page.on("requestfailed", (req) => {
    const url = req.url();
    if (!/recaptcha|hcaptcha|greenhouse|lever|ashby/i.test(url)) return;
    log.warn("request failed", {
      url: url.slice(0, 220),
      error: req.failure()?.errorText,
    });
  });
}

/**
 * Force-populate g-recaptcha-response before Submit. Greenhouse's Lotus client
 * often POSTs before the invisible Enterprise widget finishes — empty token → 428.
 */
async function primeGreenhouseRecaptcha(page: Page, log: ApplyDebugLog): Promise<void> {
  try {
    const result = await page.evaluate(async () => {
      type G = {
        ready: (cb: () => void) => void;
        execute: (key: string, opts: { action: string }) => Promise<string>;
      };
      const w = window as unknown as {
        grecaptcha?: G & { enterprise?: G };
        ENV?: { GOOGLE_RECAPTCHA_INVISIBLE_KEY?: string };
      };
      const g = w.grecaptcha?.enterprise ?? w.grecaptcha;
      const key = w.ENV?.GOOGLE_RECAPTCHA_INVISIBLE_KEY;
      if (!g || !key) return { ok: false as const, reason: "no grecaptcha or site key" };
      await new Promise<void>((resolve) => {
        try {
          g.ready(() => resolve());
        } catch {
          resolve();
        }
      });
      const token = await g.execute(key, { action: "submit" });
      for (const el of document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
        '[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]',
      )) {
        el.value = token;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: true as const, tokenLen: token?.length ?? 0 };
    });
    log.info("primed grecaptcha before submit", result);
    await page.waitForTimeout(800);
  } catch (e) {
    log.warn("prime grecaptcha failed", e instanceof Error ? e.message : String(e));
  }
}

async function pickFrame(page: Page): Promise<Frame> {
  const hasIframe = await page
    .locator("#grnhse_iframe")
    .waitFor({ timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (hasIframe) {
    for (let i = 0; i < 20; i++) {
      const fr = page.frames().find((f) => /greenhouse\.io/.test(f.url()) && /embed|job_app|jobs\//i.test(f.url()));
      if (fr) return fr;
      await page.waitForTimeout(500);
    }
  }
  // Databricks / company career pages: Greenhouse form may live in an embed
  // frame without #grnhse_iframe id after "Apply now".
  const embed = page.frames().find((f) => /greenhouse\.io\/embed\//i.test(f.url()));
  if (embed) return embed;
  return page.mainFrame();
}

/** OneTrust / cookie banners steal the first `input` match and block Apply. */
async function dismissCookieBanners(page: Page, log: ApplyDebugLog): Promise<void> {
  const selectors = [
    "#onetrust-accept-btn-handler",
    "#accept-recommended-btn-handler",
    "button:has-text('Accept All')",
    "button:has-text('Accept all')",
    "button:has-text('Allow all')",
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1_200 }).catch(() => false)) {
      await btn.click().catch(() => {});
      log.info("dismissed cookie banner", { sel });
      await page.waitForTimeout(800);
      return;
    }
  }
}

/**
 * Company career shells (Databricks) show JD + "Apply now" only — the real
 * Greenhouse form mounts in an iframe after that click.
 */
async function openEmbeddedApplyIfNeeded(page: Page, log: ApplyDebugLog): Promise<void> {
  if (/greenhouse\.io\/embed\//i.test(page.url())) return;
  if (page.frames().some((f) => /greenhouse\.io\/embed\//i.test(f.url()))) return;

  const apply = page
    .getByRole("link", { name: /^apply( now)?$/i })
    .or(page.getByRole("button", { name: /^apply( now)?$/i }))
    .first();
  if (!(await apply.isVisible({ timeout: 2_500 }).catch(() => false))) return;
  log.info("clicking Apply now on company career page");
  await apply.click().catch(() => {});
  for (let i = 0; i < 20; i++) {
    if (page.frames().some((f) => /greenhouse\.io\/embed\//i.test(f.url()))) {
      log.info("Greenhouse embed iframe appeared", {
        url: page.frames().find((f) => /greenhouse\.io\/embed\//i.test(f.url()))?.url().slice(0, 160),
      });
      return;
    }
    await page.waitForTimeout(500);
  }
  log.warn("Apply now clicked but no Greenhouse embed iframe appeared");
}

/** Real application controls — never OneTrust / cookie-manager inputs. */
function applicationControlLocator(frame: Frame) {
  return frame.locator(
    [
      'form input:not([type=hidden]):not([type=submit]):not([type=button])',
      "form textarea",
      "form select",
      'input[name*="first_name"], input[name*="last_name"], input[name*="email"]',
      'input[autocomplete="given-name"], input[autocomplete="email"]',
    ].join(", "),
  );
}

async function waitForApplicationControls(frame: Frame, log: ApplyDebugLog): Promise<void> {
  const controls = applicationControlLocator(frame);
  try {
    await controls.first().waitFor({ state: "visible", timeout: 30_000 });
    log.info("application controls visible", { count: await controls.count() });
  } catch (e) {
    // Last resort: any visible non-OneTrust text input.
    const fallback = frame.locator(
      'input:not([type=hidden]):not([id^="ot-"]):not([name^="ot-"]):not(.category-switch-handler), textarea, select',
    );
    await fallback.first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => {
      throw e;
    });
    log.warn("application controls via fallback selector", { count: await fallback.count() });
  }
}

function buildDraftIndex(qa: Array<{ question: string; answer: string }>): Map<string, string> {
  return new Map(qa.map((x) => [normalizeLabel(x.question), x.answer]));
}

function normalizeLabel(s: string): string {
  return s.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveByCode(field: LiveField, contact: Contact, draft: Map<string, string>): string | null {
  // Ashby/Greenhouse Yes/No first — before CONTACT_RULES, which can false-hit
  // long policy labels (e.g. "majority" ⊃ "major" → discipline).
  if (field.options?.length === 2 && field.options.every((o) => /^(yes|no)$/i.test(o))) {
    if (/authoriz(ed|ation).{0,40}work|work.{0,20}lawfully|legally\s+authorized/i.test(field.label)) {
      return matchOption(field.options, "Yes") ?? "Yes";
    }
    if (
      /confirm that you have read|in[- ]office|anchor days|willing to relocate|understand.{0,80}(policy|requirement)|in person company/i.test(
        field.label,
      )
    ) {
      return matchOption(field.options, "Yes") ?? "Yes";
    }
    // Default Yes/No confirmations / acknowledgements when clearly binary.
    if (/please confirm|have you read|do you (agree|acknowledge|understand)/i.test(field.label)) {
      return matchOption(field.options, "Yes") ?? "Yes";
    }
  }

  // Stable optioned screening — avoid Claude nondeterminism on common Ashby groups.
  if (field.options && field.options.length > 0 && (field.kind === "radio" || field.kind === "checkbox")) {
    const opts = field.options;
    const pick = (...candidates: string[]) => {
      for (const c of candidates) {
        const m = matchOption(opts, c);
        if (m) return m;
      }
      return null;
    };
    if (/pronoun/i.test(field.label)) {
      return pick("Prefer not to say", "Decline", "Not represented here") ?? null;
    }
    if (/sponsorship|visa status|require any of the below sponsorship/i.test(field.label)) {
      return pick("None", "No") ?? null;
    }
    if (/how did you hear|hear about this/i.test(field.label)) {
      return pick("LinkedIn", "Linkedin") ?? null;
    }
    if (/type of role|roles? are you interested/i.test(field.label)) {
      return pick("Security", "Infra", "Product") ?? null;
    }
    if (/degree type|what degree/i.test(field.label)) {
      // Internship track often B.S./M.S. — prefer Master's when listed, else undergrad.
      return pick("Master's", "Masters", "Undergraduate/Bachelors", "Bachelor") ?? null;
    }
    if (/prior internship|how many.*internship/i.test(field.label)) {
      return pick("3+", "2", "2+") ?? null;
    }
    if (/gender/i.test(field.label)) {
      return pick("Decline to self-identify", "Prefer not to say", "Decline") ?? null;
    }
    if (/race|ethnicity|hispanic/i.test(field.label)) {
      return pick("Decline to self-identify", "Prefer not to say", "Decline") ?? null;
    }
    if (/veteran/i.test(field.label)) {
      return pick(
        "I decline to self-identify for protected veteran status",
        "I am not a protected veteran",
        "Decline",
      ) ?? null;
    }
  }

  // Never map contact identity onto radio/checkbox groups — "website" must not
  // fill Ashby's "Notion Website" source checkbox with a URL, etc.
  if (field.kind !== "radio" && field.kind !== "checkbox") {
    const label = field.label;
    // Hard exclusions before CONTACT_RULES (education / email edge cases).
    if (/high\s*school|secondary\s*school|middle\s*school/i.test(label)) {
      // leave to Claude / draft — not college contact fields
    } else if (/university\s*email|school\s*email|\.edu\b/i.test(label)) {
      if (contact.email) return contact.email;
    } else if (/standardized\s*test\s*score\s*type|test\s*score\s*type/i.test(label)) {
      return contact.standardizedTestType || "SAT";
    } else if (/\bSAT\b/i.test(label) && /result|score/i.test(label)) {
      // IMC-style ranges: prefer satRange when present.
      return contact.satRange || contact.sat || null;
    } else if (/\bACT\b/i.test(label) && /result|score/i.test(label)) {
      if (contact.act) return contact.act;
      return "I don't have ACT score";
    } else {
      for (const [re, key] of CONTACT_RULES) {
        if (re.test(label) && contact[key]) return contact[key];
      }
    }
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
  const candidates = [answer, ...academicSeasonQueries(answer)];
  for (const cand of candidates) {
    const a = cand.toLowerCase().trim();
    const exact =
      options.find((o) => o.toLowerCase().trim() === a) ??
      options.find((o) => o.toLowerCase().includes(a.slice(0, 24)) || a.includes(o.toLowerCase()));
    if (exact) return exact;

    // "University of Maryland College Park" ↔ "University of Maryland - College Park"
    const aKey = fuzzyKey(a);
    let best: string | null = null;
    let bestScore = 0;
    for (const o of options) {
      const oKey = fuzzyKey(o);
      if (!oKey || !aKey) continue;
      if (oKey === aKey) return o;
      if (oKey.includes(aKey) || aKey.includes(oKey)) {
        const score = Math.min(oKey.length, aKey.length) / Math.max(oKey.length, aKey.length);
        if (score > bestScore) {
          bestScore = score;
          best = o;
        }
      }
    }
    if (bestScore >= 0.72) return best;
  }
  return null;
}

async function fillField(frame: Frame, page: Page, field: LiveField, answer: string): Promise<boolean> {
  const sel = `[data-aa-idx="${field.idx}"]`;
  try {
    if (field.kind === "radio" || field.kind === "checkbox") {
      // Ashby Yes/No widgets: click the labeled button (hidden checkbox alone
      // does not satisfy Ashby client validation).
      if (await fillAshbyYesNo(frame, sel, answer)) return true;

      // Single-option checkbox = boolean toggle:
      // affirmative answer → tick it; anything else → leave alone.
      if (field.kind === "checkbox" && (field.options?.length ?? 0) === 1) {
        if (/^(yes|true|i\s|agree|confirm)/i.test(answer) || matchOption(field.options!, answer)) {
          await pickChoice(frame.locator(sel).first());
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
            await pickChoice(members.nth(i));
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
      // Prefer matching against live <option> text — large Lever school lists
      // intentionally omit options from the Claude prompt.
      const liveOpts = (await control.locator("option").allTextContents().catch(() => []))
        .map((t) => t.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const target = matchOption(liveOpts.length ? liveOpts : (field.options ?? []), answer) ?? answer;
      try {
        await control.selectOption({ label: target }, { force: true, timeout: 5_000 });
        return true;
      } catch {
        try {
          await control.selectOption({ value: target }, { force: true, timeout: 5_000 });
          return true;
        } catch {
          return false;
        }
      }
    }

    if (field.kind === "combobox") {
      const ok = await fillCombobox(frame, page, control, answer);
      // Always dismiss the menu so the next education combobox doesn't inherit
      // the open list (School options bleeding into Degree).
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(150);
      return ok;
    }

    await control.fill(answer, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// Prefer react-select menus; exclude intl-tel-input's hidden country listbox
// which otherwise pollutes [role=option] queries on Greenhouse phone fields.
const OPTION_SEL =
  '.select__menu [role="option"]:visible, .select__option:visible, .dropdown-location:visible, [role="listbox"]:not(.iti__country-list):not([id^="iti-"]) [role="option"]:visible';

/**
 * Combobox fill that survives real ATS widgets (Greenhouse react-select, Lever
 * location autocomplete). Option text rarely equals our answer verbatim, and
 * typing the whole answer can over-constrain search to zero results. Fuzzy-
 * match the open menu; never press Enter (it submits half-filled Lever forms).
 *
 * Lever's Current location search is hCaptcha-gated (/searchLocations) — when
 * no suggestions appear, we return false so the field stays in `missed` and
 * the apply flow can leave the window open for a manual pick.
 */
export async function fillCombobox(
  frame: Frame,
  page: Page,
  control: import("playwright").Locator,
  answer: string,
): Promise<boolean> {
  const options = () => frame.locator(OPTION_SEL);
  const tryPick = async (): Promise<boolean> => {
    const texts = await options().allInnerTexts().catch(() => [] as string[]);
    const best = bestOptionIndex(texts, answer);
    if (best === -1) return false;
    await options().nth(best).click({ timeout: 3_000 });
    return true;
  };

  try {
    // Greenhouse react-select often needs the control shell clicked, not just
    // the inner input, for the menu to open.
    const shell = control.locator(
      "xpath=ancestor::div[contains(@class,'select__control')][1]",
    );
    if ((await shell.count()) > 0) await shell.click({ timeout: 5_000 });
    else await control.click({ timeout: 5_000 });
    await control.fill("").catch(() => {});
    await page.waitForTimeout(600);
    if (await tryPick()) return true;

    // Try season/year aliases first (May 2027 → type "Spring 2027") before
    // raw answer tokens that over-filter the menu to empty.
    const aliases = academicSeasonQueries(answer);
    for (const q of aliases) {
      await control.fill("").catch(() => {});
      await control.pressSequentially(q, { delay: 25 }).catch(() => {});
      await page.waitForTimeout(700);
      if (await tryPick()) return true;
    }

    const words = answer.slice(0, 80).split(/\s+/).slice(0, 8);
    for (let i = 0; i < words.length; i++) {
      await control.pressSequentially((i > 0 ? " " : "") + words[i], { delay: 25 }).catch(() => {});
      await page.waitForTimeout(900);
      if (await tryPick()) return true;
    }

    if ((await options().count()) === 1) {
      await options().first().click({ timeout: 3_000 });
      return true;
    }
    // Lever location: suggestions never load without hCaptcha — leave typed
    // value for the user rather than wiping on blur.
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}

/** Fuzzy option match: case/punctuation-insensitive equality, then containment. */
function bestOptionIndex(options: string[], answer: string): number {
  const candidates = [answer, ...academicSeasonQueries(answer)];
  let best = -1;
  let bestScore = 1; // containment or better — never a blind first-option pick
  for (const cand of candidates) {
    const key = fuzzyKey(cand);
    if (!key) continue;
    options.forEach((text, i) => {
      const ok = fuzzyKey(text);
      if (!ok) return;
      let score = 0;
      if (ok === key) score = 3;
      else if (key.length >= 4 && (ok.includes(key) || key.includes(ok))) score = 2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (bestScore >= 3) break;
  }
  return best;
}

/**
 * Map calendar graduation answers onto academic-term dropdowns
 * (e.g. "May 2027" → "Spring 2027" on Databricks new-grad forms).
 */
function academicSeasonQueries(answer: string): string[] {
  const year = answer.match(/\b(20\d{2})\b/)?.[1];
  if (!year) return [];
  const a = answer.toLowerCase();
  const out: string[] = [];
  const push = (season: string) => {
    const q = `${season} ${year}`;
    if (!out.includes(q)) out.push(q);
  };
  if (/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|spring)\b/.test(a)) push("Spring");
  // US undergrad "May/June 20xx" ≈ Spring term; also try Summer when listed.
  if (/\b(may|june|jun|jul(?:y)?|summer)\b/.test(a)) {
    push("Spring");
    push("Summer");
  }
  if (/\b(aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|fall|autumn)\b/.test(a)) push("Fall");
  if (/\b(nov(?:ember)?|dec(?:ember)?|winter)\b/.test(a)) push("Winter");
  if (out.length === 0) {
    // Bare year — try common terms so typing filters the menu.
    push("Spring");
    push("Fall");
  }
  return out;
}

function fuzzyKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
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

const SUCCESS_RE = /thank you|application (has been |was )?(submitted|received)|we('ve| have) received|successfully submitted/i;
// Keep this tight — Jane Street JDs say "security" constantly and used to
// false-trigger email_code right after a 428 captcha failure.
const EMAIL_CODE_RE =
  /\b(enter|type|paste)\b.{0,24}\b(security|verification)\s+code\b|\bwe (just )?sent (you )?(a |an )?(security |verification )?code\b|\bemail(ed)? you (a |an )?(security |verification )?code\b/i;

/** One non-waiting pass over the page: what state is the submission in? Exported for tests. */
export async function checkSubmitOutcome(
  frame: Frame,
  page: Page,
): Promise<"success" | "captcha" | "email_code" | null> {
  const success =
    (await page.getByText(SUCCESS_RE).first().isVisible().catch(() => false)) ||
    (await frame.getByText(SUCCESS_RE).first().isVisible().catch(() => false)) ||
    /confirmation|thank/i.test(page.url());
  if (success) return "success";

  // Visible captcha challenge before email-code heuristics.
  for (const root of frame === page.mainFrame() ? [page.mainFrame()] : [frame, page.mainFrame()]) {
    if (await hasCaptchaChallenge(root)) return "captcha";
  }

  // Email gate: only match modal-y copy, not JD words like "security".
  const emailGate =
    (await frame.getByText(EMAIL_CODE_RE).first().isVisible().catch(() => false)) ||
    (await page.getByText(EMAIL_CODE_RE).first().isVisible().catch(() => false));
  if (emailGate) return "email_code";

  return null;
}

/**
 * Only REAL challenges count as a CAPTCHA: the image-grid popup (bframe) or a
 * visible "I'm not a robot" checkbox. The bottom-right badge iframe that every
 * invisible-reCAPTCHA page shows (src has size=invisible, lives inside
 * .grecaptcha-badge) must not.
 */
function hasCaptchaChallenge(root: Frame): Promise<boolean> {
  return root
    .locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')
    .evaluateAll((els) =>
      els.some((el) => {
        const src = el.getAttribute("src") ?? "";
        if (/size=invisible/.test(src)) return false;
        if (el.closest(".grecaptcha-badge")) return false;
        if (!/bframe|anchor|hcaptcha/.test(src)) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return false;
        const cs = window.getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
      }),
    )
    .catch(() => false);
}

async function waitForSubmitOutcome(
  frame: Frame,
  page: Page,
  log?: ApplyDebugLog,
): Promise<"success" | "captcha" | "email_code" | "unknown"> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await checkSubmitOutcome(frame, page);
    if (state) {
      log?.info("submit state detected", { state, url: page.url() });
      return state;
    }
    await page.waitForTimeout(1_000);
  }
  log?.warn("submit wait timed out without confirmation", { url: page.url() });
  return "unknown";
}

/**
 * Keep assisting a window left open for manual attention. The user fixes the
 * form and clicks Submit themselves; this watcher spots the email-verification
 * gate when it appears, auto-fills the code from the inbox, and resolves with
 * the finish (screenshot taken, browser closed) once the confirmation shows.
 * Resolves null when the user closes the window or the watch times out — it
 * never throws. Exported for tests.
 */
export async function watchManualFinish(
  frame: Frame,
  page: Page,
  browser: Browser,
  jobTag: string,
  opts: { timeoutMs?: number; pollMs?: number; emailSince?: Date; log?: ApplyDebugLog } = {},
): Promise<AssistFinish | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  let codeAttempts = 0;
  opts.log?.info("watchManualFinish started", { timeoutMs: opts.timeoutMs ?? 15 * 60_000 });
  try {
    while (Date.now() < deadline) {
      if (page.isClosed() || !browser.isConnected()) {
        await browser.close().catch(() => {}); // window closed by the user — make sure the process dies too
        return null;
      }
      const state = await checkSubmitOutcome(frame, page);
      if (state === "success") {
        // Pre-submit pages can contain success-y words ("Thank you for your
        // interest" in the JD), so manual finish additionally requires the
        // application form to be gone before believing it.
        const formStillThere = await frame
          .locator(
            '[data-aa-form] button[type="submit"], form button[type="submit"], form input[type="submit"]',
          )
          .first()
          .isVisible()
          .catch(() => false);
        if (!formStillThere) {
          opts.log?.info("manual finish: success confirmed");
          const shot = `${SHOT_DIR}/${jobTag}-submitted.png`;
          await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
          await browser.close().catch(() => {});
          return { screenshot: shot };
        }
      } else if (state === "email_code" && emailCodeReady() && codeAttempts < 2) {
        codeAttempts += 1;
        opts.log?.info("manual finish: email verification gate", { attempt: codeAttempts });
        console.log(`[apply] ${jobTag}: email verification gate — fetching the code from the inbox`);
        const code = await fetchEmailCode({
          since: opts.emailSince ?? new Date(Date.now() - 30_000),
          timeoutMs: 90_000,
        });
        if (code) await fillVerificationCode(frame, page, code).catch(() => false);
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 2_000));
    }
  } catch {
    // the window belongs to the user now — a dead watcher must stay silent
  }
  return null;
}

/**
 * Type an emailed verification code into the gate that appeared after Submit.
 * The application form's own controls all carry data-aa-idx tags from
 * extraction, so the code box is a fresh untagged input — scoped to the modal
 * dialog when one exists. Handles both a single box and per-digit boxes.
 * Exported for tests.
 */
export async function fillVerificationCode(frame: Frame, page: Page, code: string): Promise<boolean> {
  const roots = frame === page.mainFrame() ? [frame] : [frame, page.mainFrame()];
  for (const root of roots) {
    const dialog = root.locator('[role="dialog"], [aria-modal="true"], dialog').last();
    const scope = (await dialog.isVisible().catch(() => false)) ? dialog : root.locator("body");
    const inputs = scope.locator(
      'input:not([data-aa-idx]):not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):visible',
    );
    const n = await inputs.count();
    if (n === 0) continue;
    try {
      if (n === code.length) {
        // one box per digit
        for (let i = 0; i < n; i++) await inputs.nth(i).fill(code[i], { timeout: 3_000 });
      } else {
        const box = inputs.first();
        await box.click({ timeout: 3_000 }).catch(() => {});
        try {
          await box.fill(code, { timeout: 3_000 });
        } catch {
          await box.pressSequentially(code, { delay: 40 });
        }
      }
    } catch {
      continue;
    }
    const verify = scope.getByRole("button", { name: /verify|confirm|continue|submit/i }).first();
    if (await verify.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await verify.click({ timeout: 5_000 }).catch(() => {});
    } else {
      await page.keyboard.press("Enter").catch(() => {});
    }
    return true;
  }
  return false;
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

/**
 * Prefer clicking the visible Ashby/Greenhouse option label (or parent option
 * row). Hidden custom radio/checkbox inputs often ignore input.check().
 */
async function pickChoice(locator: import("playwright").Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const id = await locator.getAttribute("id").catch(() => null);
  if (id) {
    const lab = locator.page().locator(`label[for=${JSON.stringify(id)}]`).first();
    if ((await lab.count()) > 0 && (await lab.isVisible().catch(() => false))) {
      await lab.click({ timeout: 3_000 }).catch(() => {});
      if (await locator.isChecked().catch(() => false)) return;
    }
  }
  const optionRow = locator.locator(
    "xpath=ancestor::*[contains(@class,'option') or contains(@class,'checkbox') or contains(@class,'radio')][1]",
  );
  if ((await optionRow.count()) > 0) {
    await optionRow.click({ timeout: 3_000 }).catch(() => {});
    if (await locator.isChecked().catch(() => false)) return;
  }
  await forceCheck(locator);
}

/** Re-click required fields that look empty after later React remounts. */
async function refillEmptyRequired(
  frame: Frame,
  page: Page,
  fields: LiveField[],
  answersByLabel: Map<string, string>,
  log: ApplyDebugLog,
): Promise<Array<{ label: string; answer: string }>> {
  if (page.isClosed()) return [];
  let live: LiveField[];
  try {
    live = await extractLiveFields(frame);
  } catch {
    return [];
  }
  const recovered: Array<{ label: string; answer: string }> = [];
  // Close any open react-select menu before probing — open menus make
  // neighboring fields look empty / steal keystrokes.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
  for (const f of live) {
    if (page.isClosed()) break;
    if (!f.required) continue;
    // Skip education comboboxes on retry — false "empty" + reopen is what
    // swapped School into Degree on Greenhouse. First-pass fill is enough.
    if (
      (f.kind === "combobox" || f.kind === "select") &&
      /^(school|degree|discipline|university|college)\b|start date|end date/i.test(f.label)
    ) {
      continue;
    }
    const answer = answersByLabel.get(normalizeLabel(f.label));
    if (!answer) continue;
    let empty = false;
    try {
      empty = await fieldAppearsEmpty(frame, f);
    } catch {
      break; // page/context gone
    }
    if (!empty) continue;
    log.warn("required field empty after fill — retrying", { label: f.label.slice(0, 80) });
    const ok = await fillField(frame, page, f, answer);
    if (ok) recovered.push({ label: f.label, answer });
    await page.keyboard.press("Escape").catch(() => {});
  }
  if (recovered.length) log.info("refill recovered", { count: recovered.length });
  return recovered;
}

async function fieldAppearsEmpty(frame: Frame, field: LiveField): Promise<boolean> {
  const sel = `[data-aa-idx="${field.idx}"]`;
  const first = frame.locator(sel).first();
  if ((await first.count()) === 0) return true;

  if (field.kind === "radio" || field.kind === "checkbox") {
    const yesNo = (await first.getAttribute("data-aa-yesno").catch(() => null)) === "1";
    if (yesNo) {
      const host = first.locator(
        "xpath=ancestor::*[contains(@class,'yesno') or contains(@class,'_yesno_')][1]",
      );
      const active = host.locator("button[class*='_active_'], button[class*='active']");
      return (await active.count()) === 0;
    }
    const n = await frame.locator(sel).count();
    for (let i = 0; i < n; i++) {
      if (await frame.locator(sel).nth(i).isChecked().catch(() => false)) return false;
    }
    return true;
  }

  if (field.kind === "combobox" || field.kind === "select") {
    // Greenhouse/Ashby react-select: selected value lives in .select__single-value,
    // not the input. Treating those as empty caused refill to re-type School into
    // Degree (and other crossed education fields).
    const single = first.locator(
      "xpath=ancestor::*[contains(@class,'select') or contains(@class,'Select')][1]//*[contains(@class,'single-value') or contains(@class,'Select-value')]",
    );
    if ((await single.count()) > 0) {
      const shown = ((await single.first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (shown && !/^select/i.test(shown)) return false;
    }
    const text = ((await first.inputValue().catch(() => "")) || "").trim();
    if (text && !/^select/i.test(text)) return false;
    // If a value container exists but we couldn't read it, assume filled — better
    // than scrambling neighboring comboboxes with a retry.
    const valueContainer = first.locator(
      "xpath=ancestor::*[contains(@class,'select__control') or contains(@class,'Select-control')][1]//*[contains(@class,'value-container') or contains(@class,'Select-value')]",
    );
    if ((await valueContainer.count()) > 0) {
      const vc = ((await valueContainer.first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (vc && !/^select|\.\.\./i.test(vc) && vc.length > 1) return false;
      // Placeholder-only → empty
      if (!vc || /^select/i.test(vc)) return true;
      return false;
    }
    return !text;
  }

  const val = (await first.inputValue().catch(() => "")).trim();
  return !val;
}

/** Ashby `_yesno_` controls: Yes/No <button>s beside a hidden checkbox. */
async function fillAshbyYesNo(frame: Frame, sel: string, answer: string): Promise<boolean> {
  const input = frame.locator(sel).first();
  if ((await input.count()) === 0) return false;
  const isYesNo =
    (await input.getAttribute("data-aa-yesno").catch(() => null)) === "1" ||
    (await input
      .evaluate((el) => !!el.closest("[class*='yesno'], [class*='_yesno_']"))
      .catch(() => false));
  if (!isYesNo) return false;

  const a = answer.trim().toLowerCase();
  let choice: "Yes" | "No" | null = null;
  if (/^(yes|true|y)$/i.test(a) || /^(i\s|agree|confirm|understand|authorized)/i.test(a)) choice = "Yes";
  else if (/^(no|false|n)$/i.test(a)) choice = "No";
  else if (/\byes\b/i.test(a) && !/\bno\b/i.test(a)) choice = "Yes";
  else if (/\bno\b/i.test(a)) choice = "No";
  if (!choice) return false;

  const host = input.locator("xpath=ancestor::*[contains(@class,'yesno') or contains(@class,'_yesno_')][1]");
  const btn = host.getByRole("button", { name: new RegExp(`^${choice}$`, "i") }).first();
  if ((await btn.count()) === 0) return false;
  await btn.click({ timeout: 5_000 });
  return true;
}

/**
 * Attach non-resume uploads (e.g. undergraduate transcript). File inputs are
 * excluded from field extraction; match by the Greenhouse upload-label text.
 * Prefer the Attach button + native file chooser (same as resume) because
 * Greenhouse Lotus often ignores programmatic setInputFiles on hidden inputs.
 */
async function attachExtraUploads(
  frame: Frame,
  page: Page,
  log: ApplyDebugLog,
): Promise<{ attached: string[]; skipped: string[] }> {
  const attached: string[] = [];
  const skipped: string[] = [];
  const undergradRel = transcriptPath();
  const undergrad = undergradRel ? resolvePath(undergradRel) : null;

  type FileMeta = { id: string; label: string };
  const metas = (await frame
    .evaluate(() =>
      Array.from(document.querySelectorAll('input[type="file"]')).map((el) => {
        const input = el as HTMLInputElement;
        const byId = input.id
          ? document.getElementById("upload-label-" + input.id)?.textContent || ""
          : "";
        const wrap =
          input
            .closest(".field-wrapper, .file-upload, .application-question")
            ?.querySelector(".upload-label, .label, legend")
            ?.textContent || "";
        return {
          id: input.id || "",
          label: (byId || wrap || input.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .replace(/\*$/, "")
            .trim(),
        };
      }),
    )
    .catch(() => [])) as FileMeta[];

  for (const meta of metas) {
    if (!meta.id || /resume/i.test(meta.label)) continue;
    const isUndergradTranscript =
      /transcript/i.test(meta.label) &&
      /undergrad|undergraduate|bachelor/i.test(meta.label);
    const isGradTranscript =
      /transcript/i.test(meta.label) && /grad(?:uate)?\b/i.test(meta.label) && !isUndergradTranscript;
    const isGenericTranscript = /transcript/i.test(meta.label) && !isGradTranscript;

    let filePath: string | null = null;
    if (isUndergradTranscript || isGenericTranscript) filePath = undergrad;
    if (isGradTranscript) {
      skipped.push(`${meta.label.slice(0, 60)} (no graduate transcript on file)`);
      continue;
    }
    if (!filePath) {
      if (/transcript/i.test(meta.label)) skipped.push(`${meta.label.slice(0, 60)} (missing data/transcript.pdf)`);
      continue;
    }

    const fileName = filePath.split(/[/\\]/).pop() ?? "transcript.pdf";
    let ok = false;
    try {
      const wrap = frame.locator(`#upload-label-${meta.id}`).locator(
        "xpath=ancestor::*[contains(@class,'file-upload') or contains(@class,'field-wrapper')][1]",
      );
      const attachBtn = wrap.getByRole("button", { name: /attach|upload/i }).first();
      if ((await attachBtn.count()) > 0 && (await attachBtn.isVisible().catch(() => false))) {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 6_000 }),
          attachBtn.click(),
        ]);
        await chooser.setFiles(filePath);
        ok = await wrap
          .getByText(new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40), "i"))
          .first()
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
      }
      if (!ok) {
        const input = frame.locator(`input[type="file"][id=${JSON.stringify(meta.id)}]`);
        if ((await input.count()) > 0) {
          await input.setInputFiles(filePath);
          ok = await input
            .evaluate((el) => ((el as HTMLInputElement).files?.length ?? 0) > 0)
            .catch(() => false);
        }
      }
      if (ok) attached.push(meta.label.slice(0, 80));
      else skipped.push(`${meta.label.slice(0, 60)} (upload failed)`);
    } catch (e) {
      log.warn("extra upload failed", {
        label: meta.label.slice(0, 60),
        err: e instanceof Error ? e.message : String(e),
      });
      skipped.push(meta.label.slice(0, 60));
    }
  }
  return { attached, skipped };
}
