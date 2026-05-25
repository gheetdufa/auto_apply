"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { JobStatus } from "@/db/schema";
import { ExternalLink, FileText, Sparkles, Check, X } from "lucide-react";

export function JobActions({
  jobId,
  status,
  applyUrl,
  hasJd,
  hasDraft,
}: {
  jobId: number;
  status: JobStatus;
  applyUrl: string;
  hasJd: boolean;
  hasDraft: boolean;
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

  async function fetchJd() {
    setMsg("Fetching JD…");
    try {
      await call(`/api/job/${jobId}/jd`, { method: "POST" });
      setMsg(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    }
  }
  async function draft() {
    setMsg("Generating…");
    try {
      await call(`/api/job/${jobId}/draft`, { method: "POST" });
      setMsg(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    }
  }
  async function setStatus(next: JobStatus) {
    setMsg(`Marking ${next}…`);
    try {
      await call(`/api/job/${jobId}/status`, { method: "POST", body: JSON.stringify({ status: next }) });
      setMsg(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    }
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      {msg && <span className="text-xs text-[color:var(--color-muted)]">{msg}</span>}
      {!hasJd && (
        <button onClick={fetchJd} disabled={pending} className={btn()}>
          <FileText className="h-3.5 w-3.5" /> Fetch JD
        </button>
      )}
      {hasJd && !hasDraft && (
        <button onClick={draft} disabled={pending} className={btn("accent")}>
          <Sparkles className="h-3.5 w-3.5" /> Generate Draft
        </button>
      )}
      {hasJd && hasDraft && (
        <button onClick={draft} disabled={pending} className={btn()}>
          <Sparkles className="h-3.5 w-3.5" /> Regenerate
        </button>
      )}
      <a href={applyUrl} target="_blank" rel="noreferrer" className={btn("accent")}>
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
