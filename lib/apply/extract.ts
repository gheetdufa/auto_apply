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

  // Lever / Greenhouse chrome that gets sucked into label textContent.
  const stripNoise = (s) => clean(s)
    .replace(/ATTACH RESUME\\/CV.*/i, "")
    .replace(/Couldn't auto-read resume\\.?/i, "")
    .replace(/Analyzing resume\\.?/i, "")
    .replace(/Success!/i, "")
    .replace(/No location found\\.?[^.]*\\.?/i, "")
    .replace(/Try entering a different location/i, "")
    .replace(/\\bLoading\\b/gi, "")
    .replace(/File exceeds the maximum upload size.*/i, "")
    .replace(/\\s+/g, " ")
    .trim();

  /** Lever nests question copy in .application-question > .application-label. */
  const leverLabel = (el) => {
    const q = el.closest(".application-question");
    if (!q) return "";
    const lab = q.querySelector(".application-label .text, .application-label");
    return lab ? stripNoise(lab.textContent) : "";
  };

  /** Ashby question title (not an option label). */
  const ashbyQuestionTitle = (entry) => {
    if (!entry) return "";
    const lab = entry.querySelector("label.ashby-application-form-question-title");
    return lab ? stripNoise(lab.textContent) : "";
  };

  const labelFor = (el) => {
    const fromLever = leverLabel(el);
    if (fromLever) return fromLever;

    const ashbyEntry = el.closest(".ashby-application-form-field-entry, [class*='fieldEntry']");
    const fromAshby = ashbyQuestionTitle(ashbyEntry);
    if (fromAshby) return fromAshby;

    const id = el.getAttribute("id");
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      // Skip short option labels — prefer longer question titles via walk below.
      if (lab && lab.textContent && lab.textContent.trim() && !lab.classList.contains("ashby-application-form-question-title")) {
        const t = stripNoise(lab.textContent);
        // Only use for= label when it looks like a field title, not "Product"/"Yes".
        if (t.length > 40) return t;
      } else if (lab && lab.classList.contains("ashby-application-form-question-title")) {
        return stripNoise(lab.textContent);
      }
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return stripNoise(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((lid) => {
        const n = document.getElementById(lid);
        return n ? n.textContent || "" : "";
      }).join(" ");
      if (text.trim()) return stripNoise(text);
    }
    const wrap = el.closest("label");
    if (wrap && wrap.textContent && wrap.textContent.trim()) {
      // Option labels ("English (ENG)") are not the question — skip tiny wraps.
      const t = stripNoise(wrap.textContent);
      if (t && t.length > 40) return t;
    }
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++) {
      const lab = node.querySelector(":scope > label.ashby-application-form-question-title, :scope > legend");
      if (lab && lab.textContent && lab.textContent.trim() && !lab.contains(el)) {
        return stripNoise(lab.textContent);
      }
      const lab2 = node.querySelector(":scope > label, :scope legend");
      if (lab2 && lab2.textContent && lab2.textContent.trim() && !lab2.contains(el)) {
        const t = stripNoise(lab2.textContent);
        if (t.length > 40) return t;
      }
      node = node.parentElement;
    }
    return stripNoise(el.placeholder);
  };

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

  const visible = (el) =>
    el.tagName.toLowerCase() === "select" || el.offsetParent !== null || el.getAttribute("role") === "combobox"
    || el.classList.contains("location-input");

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
    // Greenhouse react-select injects a hidden required <input> next to the
    // real combobox — it has no label and used to become "Untitled input",
    // which Claude then filled with the school name.
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (/requiredInput|a11yText/i.test(el.className || "")) continue;
    if (
      el.closest(".phone-input") &&
      type !== "tel" &&
      el.id !== "phone" &&
      el.id !== "country" &&
      el.getAttribute("role") !== "combobox"
    ) {
      continue;
    }
    const wrapLabel = el.closest("label");
    const ashbyEntry = el.closest(".ashby-application-form-field-entry, [class*='fieldEntry']");
    const required = !!el.required || el.getAttribute("aria-required") === "true" ||
      !!(el.closest(".required-field, .application-question") &&
        el.closest(".application-question")?.querySelector(".required, .application-label .required")) ||
      // Ashby: required marker is a class on the question title label (_required_…).
      !!(ashbyEntry && ashbyEntry.querySelector("label[class*='required'], [class*='_required_']"));

    if (type === "radio" || type === "checkbox") {
      // Group key: Ashby multi-select checkboxes use a DIFFERENT name per option
      // ("Product", "Growth", …). Group by field-entry so Claude sees one question
      // with options — otherwise each option becomes a fake required field and
      // fills flake run-to-run.
      const ashbyTitle = ashbyQuestionTitle(ashbyEntry);
      const ashbyGroupKey = ashbyEntry
        ? ("ashby:" + (ashbyEntry.getAttribute("data-field-entry-id")
          || ashbyEntry.getAttribute("data-field-path")
          || ashbyTitle
          || el.getAttribute("name")
          || ""))
        : "";
      const name = ashbyGroupKey || el.getAttribute("name") || labelFor(el);

      // Ashby Yes/No: two <button>s + a hidden checkbox. Treat as a radio so we
      // answer "Yes"/"No" and click the button (checking the input alone does
      // not update Ashby's React state → client validation fails).
      const yesNoHost = el.closest("[class*='yesno'], [class*='_yesno_']");
      const siblingButtons = yesNoHost
        ? Array.from(yesNoHost.querySelectorAll("button")).map((b) => clean(b.textContent)).filter(Boolean)
        : [];
      const isYesNo =
        !!yesNoHost &&
        siblingButtons.length >= 2 &&
        siblingButtons.some((t) => /^yes$/i.test(t)) &&
        siblingButtons.some((t) => /^no$/i.test(t));
      if (isYesNo) {
        if (seenGroups.has(name)) {
          el.setAttribute("data-aa-idx", String(seenGroups.get(name)));
          continue;
        }
        const groupLabel = ashbyTitle || leverLabel(el) || labelFor(el) || name;
        el.setAttribute("data-aa-idx", String(idx));
        el.setAttribute("data-aa-yesno", "1");
        seenGroups.set(name, idx);
        fields.push({
          idx,
          label: groupLabel,
          kind: "radio",
          options: ["Yes", "No"],
          required,
        });
        idx += 1;
        continue;
      }

      // Option text: Greenhouse/Ashby put it in label[for=id], not value= (often "on").
      let forLabel = "";
      const inputId = el.getAttribute("id");
      if (inputId) {
        const lab = document.querySelector('label[for="' + CSS.escape(inputId) + '"]');
        if (lab && !lab.classList.contains("ashby-application-form-question-title")) {
          forLabel = lab.textContent || "";
        }
      }
      const wrapOpt = el.closest(".checkbox__wrapper, .radio__wrapper, .checkbox, .radio, [class*='option']");
      const wrapOptLabel = wrapOpt
        ? (wrapOpt.querySelector("label:not(.ashby-application-form-question-title):not(:has(input))")
          || wrapOpt.querySelector("label:not(.ashby-application-form-question-title)"))
        : null;
      // Ashby multi-checkbox: name attribute is the human option ("Security").
      const nameAsOpt = el.getAttribute("name") || "";
      const nameLooksLikeOption = !!ashbyEntry && nameAsOpt && !/^[0-9a-f-]{8,}$/i.test(nameAsOpt)
        && !/_systemfield_|labeled-/i.test(nameAsOpt);
      const optLabel = clean(
        (wrapLabel && wrapLabel.querySelector(".application-answer-alternative")
          ? wrapLabel.querySelector(".application-answer-alternative").textContent
          : null)
        || forLabel
        || (wrapOptLabel ? wrapOptLabel.textContent : "")
        || (wrapLabel && wrapLabel.textContent && wrapLabel.textContent.trim() !== el.value
          && !wrapLabel.classList.contains("ashby-application-form-question-title")
          ? wrapLabel.textContent
          : null)
        || (nameLooksLikeOption ? nameAsOpt : "")
        || (el.nextElementSibling && el.nextElementSibling.tagName !== "SVG"
          ? el.nextElementSibling.textContent
          : "")
        || el.value
      );
      if (seenGroups.has(name)) {
        const gi = seenGroups.get(name);
        el.setAttribute("data-aa-idx", String(gi));
        el.setAttribute("data-aa-opt", optLabel);
        if (optLabel && !fields[gi].options.includes(optLabel)) fields[gi].options.push(optLabel);
      } else {
        let groupLabel = ashbyTitle || leverLabel(el);
        if (!groupLabel) {
          const fieldset = el.closest("fieldset");
          if (fieldset) {
            const legend = fieldset.querySelector("legend");
            if (legend) groupLabel = stripNoise(legend.textContent);
          }
        }
        if (!groupLabel) {
          let node = el.parentElement;
          for (let depth = 0; node && depth < 6 && !groupLabel; depth++) {
            const lab = node.querySelector(
              ":scope > label.ashby-application-form-question-title, :scope > legend, :scope > .application-label",
            );
            if (lab && !lab.contains(el) && lab.textContent && lab.textContent.trim()) {
              groupLabel = stripNoise(lab.textContent);
              break;
            }
            // Only accept generic labels that look like questions, not option text.
            const lab2 = node.querySelector(":scope > label, :scope > .label, :scope > p");
            if (lab2 && !lab2.contains(el) && lab2.textContent && lab2.textContent.trim()) {
              const t = stripNoise(lab2.textContent);
              if (t.length > 40 || /[?]$/.test(t)) groupLabel = t;
            }
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
    let label = labelFor(el);
    // Lever card controls often have no <label for> — still must fill them.
    // Never invent "Untitled input" for required chrome (react-select dummies).
    if (!label) {
      const n = el.getAttribute("name") || "";
      if (/^cards\\[/i.test(n) || tag === "select" || tag === "textarea") {
        label = n ? ("Field: " + n) : ("Untitled " + tag);
      } else {
        continue;
      }
    }

    let kind;
    let options;
    const isLocation =
      el.classList.contains("location-input") ||
      el.getAttribute("data-qa") === "location-input" ||
      (/location/i.test(label) && el.getAttribute("name") === "location");

    if (tag === "select") {
      kind = "select";
      const all = Array.from(el.options).map((o) => clean(o.label || o.textContent))
        .filter((o) => o && !/^select|^choose|^--|click here/i.test(o));
      // Huge school lists: don't dump 3k options into Claude — filler still
      // selectOption()'s against the live <select>.
      options = all.length > 80 ? undefined : all.slice(0, 50);
      if (all.length > 80) {
        label = label + " (large dropdown — answer with the exact school/option name)";
      }
    } else if (
      isLocation ||
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-autocomplete") === "list"
    ) {
      kind = "combobox";
    } else if (tag === "textarea") {
      kind = "textarea";
    } else {
      kind = "text";
    }

    const labelKey = label.toLowerCase().replace(/\\s*\\(large dropdown[^)]*\\)\\s*$/i, "").trim();
    if (seenLabels.has(labelKey)) continue;
    if (labelKey === "search" || labelKey === "type your response") continue;
    seenLabels.add(labelKey);

    el.setAttribute("data-aa-idx", String(idx));
    fields.push({ idx, label, kind, options, required: !!required });
    idx += 1;
  }

  return fields;
})()`;

export async function extractLiveFields(frame: Frame): Promise<LiveField[]> {
  return (await frame.evaluate(EXTRACT_SCRIPT)) as LiveField[];
}
