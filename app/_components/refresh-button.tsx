"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  async function refresh() {
    setStatus("Checking sources…");
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "refresh failed");
      setStatus(
        data.backfill
          ? `backfilled ${data.newJobs} jobs`
          : `+${data.newJobs} new · ${data.drafted} drafted · ${data.closedJobs} closed`,
      );
      startTransition(() => router.refresh());
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "error");
    }
  }

  return (
    <div className="flex items-center gap-3">
      {status && <span className="text-xs text-[color:var(--color-muted)]">{status}</span>}
      <button
        onClick={refresh}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-50"
      >
        <RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />
        Refresh
      </button>
    </div>
  );
}
