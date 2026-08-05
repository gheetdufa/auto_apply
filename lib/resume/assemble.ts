import type { JobKind } from "@/db/schema";
import { rankProjectsForJob, detectRoleWeights } from "@/lib/github/rank";
import { RESUME_PROJECTS, SKILLS, LATEX_EXPERIENCE, type ResumeProject } from "./catalog";

export type BulletDiff = { project: string; original: string; rewritten: string };

export type TailoredResumePlan = {
  internship: boolean;
  projects: ResumeProject[];
  skills: SkillsBanks;
  /** Why these projects / skills were chosen — shown in the UI. */
  rationale: string[];
  /** Who produced the plan; absent on meta.json written before LLM tailoring. */
  source?: "llm" | "heuristic";
  /** Original → rewritten bullets, for auditing LLM rewrites in the UI. */
  bulletDiffs?: BulletDiff[];
};

const LATEX_PREAMBLE = String.raw`% Auto-generated per-job resume — do not edit by hand; source is lib/resume/
\documentclass[letterpaper,10pt]{article}
\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\ifdefined\pdfgentounicode
  \input{glyphtounicode}
  \pdfgentounicode=1
\fi
\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}
\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.5in}
\addtolength{\textheight}{1.0in}
\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}
\titleformat{\section}{
  \vspace{-4pt}\scshape\raggedright\large
}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]
\newcommand{\resumeItem}[1]{\item\small{{#1 \vspace{-2pt}}}}
\newcommand{\resumeSubheading}[4]{
  \vspace{-2pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & #2 \\
      \textit{\small#3} & \textit{\small #4} \\
    \end{tabular*}\vspace{-7pt}
}
\renewcommand\labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}
`;

export function escapeLatex(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([{}$&#_%])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

export type SkillsBanks = {
  languages: string[];
  frameworks: string[];
  cloud: string[];
  databases: string[];
};

/** Prefer JD-matching skills first within each bank (stable otherwise). */
export function orderSkillsForJd(jdText: string, title: string): SkillsBanks {
  const hay = `${title}\n${jdText}`.toLowerCase();
  const rank = (items: readonly string[]) =>
    [...items].sort((a, b) => {
      const aHit = hay.includes(a.toLowerCase()) || hay.includes(a.toLowerCase().replace(/\.js$/, ""));
      const bHit = hay.includes(b.toLowerCase()) || hay.includes(b.toLowerCase().replace(/\.js$/, ""));
      if (aHit === bHit) return 0;
      return aHit ? -1 : 1;
    });
  return {
    languages: rank(SKILLS.languages),
    frameworks: rank(SKILLS.frameworks),
    cloud: rank(SKILLS.cloud),
    databases: rank(SKILLS.databases),
  };
}

/**
 * Pick the two best projects for this JD.
 * Uses GitHub role-affinity ranking when available, plus tag hits in the JD.
 */
export function pickProjectsForJob(title: string, jdText: string): { projects: ResumeProject[]; rationale: string[] } {
  const ranked = rankProjectsForJob({ title, jdText, limit: 8 });
  const weights = detectRoleWeights(title, jdText);
  const hay = `${title}\n${jdText}`.toLowerCase();
  const rationale: string[] = [];

  const scored = RESUME_PROJECTS.map((p) => {
    const gh = ranked.find((r) => p.githubNames.some((n) => n.toLowerCase() === r.name.toLowerCase()));
    let score = gh?.fitScore ?? 0;
    for (const tag of p.tags) {
      if (hay.includes(tag.toLowerCase())) score += 12;
    }
    // Quant JDs: hard-boost auto-trader
    if (p.id === "auto-trader" && weights.quant > 0.15) score += 40;
    if (p.id === "sketch2solve" && weights.ml_ai > 0.2) score += 25;
    if (p.id === "audit-ai" && (weights.ml_ai > 0.15 || /\b(vision|cv|pytorch|yolo)\b/i.test(hay))) score += 20;
    if (p.id === "asktestudo" && (weights.ml_ai > 0.1 || /\brag\b|\bllm\b/i.test(hay))) score += 15;
    return { p, score, why: gh ? `github fit ${Math.round(gh.fitScore)}` : "catalog tags" };
  }).sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 2).map((t, i) => ({
    ...t,
    // Keep page budget: lead project gets full bullets, runner-up one bullet.
    p: i === 0 ? t.p : { ...t.p, bullets: t.p.bullets.slice(0, 1) },
  }));
  for (const t of top) {
    rationale.push(`${t.p.heading}: score ${Math.round(t.score)} (${t.why})`);
  }
  return { projects: top.map((t) => t.p), rationale };
}

export function planResume(args: {
  kind: JobKind | string | null | undefined;
  title: string;
  jdText: string;
}): TailoredResumePlan {
  const internship = args.kind === "internship";
  const { projects, rationale } = pickProjectsForJob(args.title, args.jdText);
  const skills = orderSkillsForJd(args.jdText, args.title);
  const eduNote = internship
    ? "Education: B.S./M.S., expected May 2028 (internship track)"
    : "Education: B.S., expected May 2027 (new-grad track)";
  return {
    internship,
    projects,
    skills,
    rationale: [eduNote, ...rationale],
    source: "heuristic",
  };
}

export function assembleLatex(plan: TailoredResumePlan): string {
  const degree = plan.internship
    ? String.raw`B.S./M.S. in Computer Science \& Math, Minor in Business Analytics \& Data Science`
    : String.raw`B.S. in Computer Science \& Math, Minor in Business Analytics \& Data Science`;
  const grad = plan.internship ? "Expected Graduation, May 2028" : "Expected Graduation, May 2027";

  const projectsLatex = plan.projects
    .map((p) => {
      const bullets = p.bullets.map((b) => `        \\resumeItem{${b}}`).join("\n");
      return String.raw`
    \resumeSubheading
      {${escapeLatex(p.heading)}}{${escapeLatex(p.location)}}
      {${escapeLatex(p.role)}}{}
      \resumeItemListStart
${bullets}
      \resumeItemListEnd`;
    })
    .join("\n");

  const skills = plan.skills;
  return `${LATEX_PREAMBLE}
\\begin{document}
\\begin{center}
    \\textbf{\\Huge \\scshape Dheer Guda} \\\\ \\vspace{1pt}
    \\small
    \\href{mailto:gudadheer@gmail.com}{gudadheer@gmail.com} $|$
    (732)-268-0687 $|$
    \\href{https://linkedin.com/in/dheer-guda/}{linkedin.com/in/dheer-guda} $|$
    \\href{https://dheerguda.com}{dheerguda.com}
\\end{center}

\\section{Education}
  \\resumeSubHeadingListStart
    \\resumeSubheading
      {University of Maryland College Park}{College Park, Maryland}
      {${degree}}{${grad}}
      \\resumeItemListStart
        \\resumeItem{\\textbf{Honors:} Dean's List, QUEST Honors Program, Telora Fellowship S25, Startup Shell Grant Winner}
        \\resumeItem{\\textbf{Related Coursework:} Data Structures \\& Algorithms, Operating Systems, Database Design, Machine Learning, Artificial Intelligence, Software Engineering, Probability \\& Statistics}
      \\resumeItemListEnd
  \\resumeSubHeadingListEnd

${LATEX_EXPERIENCE}

\\section{Projects}
  \\resumeSubHeadingListStart
${projectsLatex}
  \\resumeSubHeadingListEnd

\\section{Technical Skills}
 \\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
     \\textbf{Languages:} ${skills.languages.join(", ")} \\\\
     \\textbf{Frameworks \\& Libraries:} ${skills.frameworks.join(", ")} \\\\
     \\textbf{Cloud \\& DevOps:} ${skills.cloud.join(", ")} \\\\
     \\textbf{Databases \\& Tools:} ${skills.databases.join(", ")}
    }}
 \\end{itemize}

\\end{document}
`;
}
