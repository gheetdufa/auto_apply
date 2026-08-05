import { existsSync } from "node:fs";
import { AlertTriangle } from "lucide-react";

/**
 * Server component: surfaces missing setup instead of letting tailoring fail
 * silently at generate time. Renders nothing when everything is configured.
 */
export function SetupBanner() {
  const missing: Array<{ what: string; fix: string }> = [];

  if (!process.env.ANTHROPIC_API_KEY) {
    missing.push({
      what: "ANTHROPIC_API_KEY",
      fix: "cp .env.local.example .env.local and add your key — drafts can't generate without it",
    });
  }
  if (!existsSync(process.env.PROFILE_PATH ?? "./data/profile.md")) {
    missing.push({
      what: "data/profile.md",
      fix: "cp data/profile.md.template data/profile.md and fill it in — this is what makes drafts sound like you",
    });
  }
  if (!existsSync("./data/resume.pdf")) {
    missing.push({
      what: "data/resume.pdf",
      fix: "pnpm resume:build (or drop your PDF here) — new-grad applications attach this file",
    });
  }

  if (missing.length === 0) {
    if (!existsSync("./data/resume-internship.pdf")) {
      return (
        <div className="mb-5 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-[color:var(--color-muted)]">
          Tip: run <span className="font-mono text-[13px]">pnpm resume:build</span> to also generate{" "}
          <span className="font-mono text-[13px]">data/resume-internship.pdf</span> (B.S./M.S., May 2028) for
          internship applications.
        </div>
      );
    }
    return null;
  }
  return (
    <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-400">
        <AlertTriangle className="h-4 w-4" /> Setup incomplete — auto-drafting is off until this is fixed
      </div>
      <ul className="mt-2 space-y-1 text-[color:var(--color-muted)]">
        {missing.map((m) => (
          <li key={m.what}>
            <span className="font-mono text-[13px] text-amber-300/80">{m.what}</span> — {m.fix}
          </li>
        ))}
      </ul>
    </div>
  );
}
