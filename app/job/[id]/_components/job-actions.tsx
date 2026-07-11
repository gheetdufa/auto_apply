"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { JobStatus } from "@/db/schema";
import { ExternalLink, FileText, Sparkles, Check, X, Rocket } from "lucide-react";

export function JobActions({
  jobId,
  status,
  applyUrl,
  hasDraft,
  canAutoApply,
}: {
  jobId: number;
  status: JobStatus;
  applyUrl: string;
  hasDraft: boolean;
  canAutoApply: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data;
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    setMsg(label);
    try {
      await fn();
      setMsg(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    }
  }

  const enrich = () => run("Fetching JD + form…", () => call(`/api/job/${jobId}/enrich`, { method: "POST" }));
  const draft = () => run("Drafting…", () => call(`/api/job/${jobId}/draft`, { method: "POST" }));
  const autoApply = async (force = false) => {
    setMsg("Applying — a browser window will open…");
    try {
      const res = await fetch(`/api/job/${jobId}/apply${force ? "?force=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string; message?: string; blocked?: string; error?: string };
      if (res.status === 409 && data.blocked) {
        if (window.confirm(`${data.blocked}\n\nApply anyway?`)) return autoApply(true);
        setMsg("skipped (already applied to this company)");
        return;
      }
      if (!res.ok) throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
      setMsg(data.message ?? data.status ?? "done");
      startTransition(() => router.refresh());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    }
  };
  const setStatus = (next: JobStatus) =>
    run(`Marking ${next}…`, () => call(`/api/job/${jobId}/status`, { method: "POST", body: JSON.stringify({ status: next }) }));

  return (
    <div className="flex items-center gap-2 text-sm">
      {msg && <span className="text-xs text-[color:var(--color-muted)]">{msg}</span>}
      <button onClick={enrich} disabled={pending} className={btn()}>
        <FileText className="h-3.5 w-3.5" /> Fetch details
      </button>
      <button onClick={draft} disabled={pending} className={btn(hasDraft ? "default" : "accent")}>
        <Sparkles className="h-3.5 w-3.5" /> {hasDraft ? "Regenerate" : "Generate Draft"}
      </button>
      {canAutoApply && (
        <button onClick={() => autoApply()} disabled={pending || status === "applied"} className={btn("accent")}>
          <Rocket className="h-3.5 w-3.5" /> Auto-apply
        </button>
      )}
      <a href={applyUrl} target="_blank" rel="noreferrer" className={btn()}>
        Open application <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <button onClick={() => setStatus("applied")} disabled={pending || status === "applied"} className={btn("success")}>
        <Check className="h-3.5 w-3.5" /> Applied
      </button>
      <button onClick={() => setStatus("skipped")} disabled={pending || status === "skipped"} className={btn("danger")}>
        <X className="h-3.5 w-3.5" /> Skip
      </button>
    </div>
  );
}

function btn(variant: "default" | "accent" | "success" | "danger" = "default") {
  const base = "inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs disabled:opacity-50";
  if (variant === "accent") return `${base} bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] border-[color:var(--color-accent)]`;
  if (variant === "success") return `${base} text-[color:var(--color-success)] hover:bg-white/5`;
  if (variant === "danger") return `${base} text-[color:var(--color-danger)] hover:bg-white/5`;
  return `${base} hover:bg-white/5`;
}
