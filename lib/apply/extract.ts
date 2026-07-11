import type { Frame } from "playwright";

/**
 * Live-DOM form extraction: instead of trusting any ATS API, read the fields
 * the page actually renders. Each control gets tagged with data-aa-idx so the
 * filler can address it precisely afterwards.
 *
 * The in-page script is a raw string: tsx/esbuild decorate serialized TS
 * closures with a __name helper that doesn't exist in the browser context.
 */

export type LiveField = {
  idx: number;
  label: string;
  kind: "text" | "textarea" | "select" | "combobox" | "radio" | "checkbox";
  options?: string[];
  required: boolean;
};

const EXTRACT_SCRIPT = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").replace(/\\s*\\*\\s*$/, "").trim();

  const labelFor = (el) => {
    const id = el.getAttribute("id");
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab && lab.textContent && lab.textContent.trim()) return clean(lab.textContent);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((lid) => {
        const n = document.getElementById(lid);
        return n ? n.textContent || "" : "";
      }).join(" ");
      if (text.trim()) return clean(text);
    }
    const wrap = el.closest("label");
    if (wrap && wrap.textContent && wrap.textContent.trim()) return clean(wrap.textContent);
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++) {
      const lab = node.querySelector(":scope > label, :scope legend");
      if (lab && lab.textContent && lab.textContent.trim()) return clean(lab.textContent);
      node = node.parentElement;
    }
    return clean(el.placeholder);
  };

  // Pick the densest form-like container (real app forms dwarf newsletter boxes).
  const candidates = Array.from(document.querySelectorAll("form"));
  if (candidates.length === 0) candidates.push(document.body);
  let best = candidates[0];
  let bestScore = -1;
  for (const form of candidates) {
    const controls = form.querySelectorAll("input:not([type=hidden]), textarea, select").length;
    const hasFile = form.querySelector('input[type="file"]') ? 10 : 0;
    const submitTxt = Array.from(form.querySelectorAll('button, input[type="submit"]'))
      .map((b) => (b.textContent || b.value || "")).join(" ");
    const applySubmit = /submit|apply/i.test(submitTxt) ? 5 : 0;
    const score = controls + hasFile + applySubmit;
    if (score > bestScore) { bestScore = score; best = form; }
  }
  best.setAttribute("data-aa-form", "1");

  // Native selects are ALWAYS included even when hidden — select2-style widgets
  // hide the real <select> behind a styled combobox; filling the native one is
  // the reliable path (change events update the widget).
  const visible = (el) =>
    el.tagName.toLowerCase() === "select" || el.offsetParent !== null || el.getAttribute("role") === "combobox";

  const fields = [];
  const seenGroups = new Map();
  const seenLabels = new Set();
  let idx = 0;

  const controls = Array.from(best.querySelectorAll(
    'input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]):not([type=search]), textarea, select, [role="combobox"]'
  ));

  for (const el of controls) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const wrapLabel = el.closest("label");
    const required = !!el.required || el.getAttribute("aria-required") === "true" ||
      /\\*\\s*$/.test(wrapLabel && wrapLabel.textContent ? wrapLabel.textContent : "");

    if (type === "radio" || type === "checkbox") {
      const name = el.getAttribute("name") || labelFor(el);
      const optLabel = clean(wrapLabel ? wrapLabel.textContent : "") || labelFor(el) ||
        clean(el.nextElementSibling ? el.nextElementSibling.textContent : "");
      if (seenGroups.has(name)) {
        const gi = seenGroups.get(name);
        el.setAttribute("data-aa-idx", String(gi));
        el.setAttribute("data-aa-opt", optLabel);
        fields[gi].options.push(optLabel);
      } else {
        let groupLabel = "";
        const fieldset = el.closest("fieldset");
        if (fieldset) {
          const legend = fieldset.querySelector("legend");
          if (legend) groupLabel = clean(legend.textContent);
        }
        if (!groupLabel) {
          let node = el.parentElement;
          for (let depth = 0; node && depth < 5 && !groupLabel; depth++) {
            const lab = node.querySelector(":scope > label, :scope > legend, :scope > .label, :scope > p");
            if (lab && !lab.contains(el) && lab.textContent && lab.textContent.trim()) groupLabel = clean(lab.textContent);
            node = node.parentElement;
          }
        }
        el.setAttribute("data-aa-idx", String(idx));
        el.setAttribute("data-aa-opt", optLabel);
        seenGroups.set(name, idx);
        fields.push({ idx, label: groupLabel || name, kind: type, options: [optLabel], required });
        idx += 1;
      }
      continue;
    }

    if (!visible(el)) continue;
    const label = labelFor(el);
    if (!label) continue;

    let kind;
    let options;
    if (tag === "select") {
      kind = "select";
      options = Array.from(el.options).map((o) => clean(o.label))
        .filter((o) => o && !/^select|^choose|^--/i.test(o)).slice(0, 50);
    } else if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list") {
      kind = "combobox";
    } else if (tag === "textarea") {
      kind = "textarea";
    } else {
      kind = "text";
    }

    // Widget libraries (react-select, select2) render twin controls with the
    // same label — combobox + hidden state input. First in DOM wins.
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) continue;
    if (labelKey === "search") continue; // widget-internal search boxes
    seenLabels.add(labelKey);

    el.setAttribute("data-aa-idx", String(idx));
    fields.push({ idx, label, kind, options, required });
    idx += 1;
  }

  return fields;
})()`;

export async function extractLiveFields(frame: Frame): Promise<LiveField[]> {
  return (await frame.evaluate(EXTRACT_SCRIPT)) as LiveField[];
}
