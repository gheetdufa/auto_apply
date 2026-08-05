import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

/**
 * Fetch the email-verification security code some ATSes (Greenhouse) send on
 * submit. Polls the inbox over IMAP for a fresh matching message and pulls the
 * code out of it. Configure in .env.local:
 *
 *   EMAIL_IMAP_USER=you@gmail.com
 *   EMAIL_IMAP_PASS=<app password — myaccount.google.com/apppasswords>
 *   EMAIL_IMAP_HOST=imap.gmail.com   (default)
 *
 * Unconfigured → callers fall back to manual entry in the open browser.
 */

export function emailCodeReady(): boolean {
  return Boolean(process.env.EMAIL_IMAP_USER && process.env.EMAIL_IMAP_PASS);
}

const SENDER_RE = /greenhouse|no-?reply/i;

export async function fetchEmailCode(args: {
  /** Only messages received at/after this time count — set it when Submit is clicked. */
  since: Date;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string | null> {
  if (!emailCodeReady()) return null;
  const deadline = Date.now() + (args.timeoutMs ?? 120_000);
  for (;;) {
    const code = await pollInbox(args.since).catch((e) => {
      console.warn("[email-code] poll failed:", e instanceof Error ? e.message : e);
      return null;
    });
    if (code) return code;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, args.pollMs ?? 5_000));
  }
}

async function pollInbox(since: Date): Promise<string | null> {
  const client = new ImapFlow({
    host: process.env.EMAIL_IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.EMAIL_IMAP_PORT ?? 993),
    secure: true,
    auth: { user: process.env.EMAIL_IMAP_USER!, pass: process.env.EMAIL_IMAP_PASS! },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // IMAP SINCE is date-granular; exact time filtering happens per message.
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return null;

      let best: { at: number; code: string } | null = null;
      for await (const msg of client.fetch(uids.slice(-15).join(","), { source: true }, { uid: true })) {
        if (!msg.source) continue;
        const mail = await simpleParser(msg.source);
        const at = mail.date?.getTime() ?? 0;
        // 90s grace: ATS clock skew vs. our submit timestamp.
        if (at < since.getTime() - 90_000) continue;
        const sender = mail.from?.text ?? "";
        const subject = mail.subject ?? "";
        if (!SENDER_RE.test(sender) && !/security code|verification code/i.test(subject)) continue;
        const code = extractCode(`${subject}\n${mail.text ?? ""}\n${mail.html || ""}`);
        if (code && (!best || at > best.at)) best = { at, code };
      }
      return best?.code ?? null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Pull a 4–8 digit code out of message text, preferring digits near "code". */
export function extractCode(text: string): string | null {
  const t = text.replace(/<[^>]+>/g, " "); // crude de-HTML so tags don't split digits from context
  const candidates: string[] = [];
  for (const re of [/\bcode\b\D{0,40}?(\d{4,8})\b/gi, /\b(\d{4,8})\b\D{0,40}?\bcode\b/gi]) {
    for (let m = re.exec(t); m; m = re.exec(t)) candidates.push(m[1]);
  }
  // Footer years ("© 2026") sit near "code" in subjects/footers; 6 digits is
  // the common OTP shape, so prefer it among the survivors.
  const plausible = candidates.filter((c) => !/^(19|20)\d{2}$/.test(c));
  const six = plausible.find((c) => c.length === 6);
  if (six ?? plausible[0]) return six ?? plausible[0];
  const bare = t.match(/(?<![\d.])(\d{6})(?![\d.])/);
  return bare ? bare[1] : null;
}
