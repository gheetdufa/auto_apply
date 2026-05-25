"use client";

import { useState } from "react";
import { Save, Check } from "lucide-react";

type QA = { question: string; answer: string };

export function DraftEditor({
  jobId,
  initial,
}: {
  jobId: number;
  initial: { coverLetterMd: string; qa: QA[] };
}) {
  const [cover, setCover] = useState(initial.coverLetterMd);
  const [qa, setQa] = useState<QA[]>(initial.qa);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/job/${jobId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coverLetterMd: cover, qa }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-h-[75vh] overflow-y-auto">
      <div className="border-b px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs uppercase text-[color:var(--color-muted)]">Cover letter</h3>
          <button
            onClick={() => navigator.clipboard.writeText(cover)}
            className="text-[10px] uppercase text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]"
          >
            Copy
          </button>
        </div>
        <textarea
          value={cover}
          onChange={(e) => setCover(e.target.value)}
          className="w-full resize-y rounded border bg-black/30 p-3 text-[13px] font-mono leading-relaxed min-h-[260px]"
        />
      </div>

      <div className="px-4 py-3 space-y-3">
        <h3 className="text-xs uppercase text-[color:var(--color-muted)]">Screening answers</h3>
        {qa.map((item, i) => (
          <div key={i} className="rounded border bg-black/20 p-3">
            <div className="text-[12px] font-medium mb-1.5">{item.question}</div>
            <textarea
              value={item.answer}
              onChange={(e) => {
                const next = [...qa];
                next[i] = { ...item, answer: e.target.value };
                setQa(next);
              }}
              className="w-full resize-y rounded border bg-black/30 p-2 text-[12px] leading-relaxed min-h-[60px]"
            />
            <button
              onClick={() => navigator.clipboard.writeText(item.answer)}
              className="mt-1 text-[10px] uppercase text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]"
            >
              Copy answer
            </button>
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 border-t bg-[color:var(--color-panel)] px-4 py-2 flex items-center justify-between">
        <span className="text-xs text-[color:var(--color-muted)]">
          {savedAt ? `Saved ${secondsAgo(savedAt)}s ago` : "Edit freely — save creates a new draft version"}
        </span>
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs hover:bg-white/5 disabled:opacity-50"
        >
          {savedAt && Date.now() - savedAt < 3000 ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          Save edits
        </button>
      </div>
    </div>
  );
}

function secondsAgo(ts: number): number {
  return Math.max(0, Math.round((Date.now() - ts) / 1000));
}
