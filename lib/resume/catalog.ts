/**
 * Canonical resume project blocks. Tailoring only reorders / selects from these —
 * never invents experience. Bullets are LaTeX-safe (escape specials yourself).
 */
export type ResumeProject = {
  id: string;
  /** Match keys from github-projects.json when ranking. */
  githubNames: string[];
  heading: string;
  location: string;
  role: string;
  bullets: string[];
  /** Soft tags for keyword / family boosts beyond GitHub scores. */
  tags: string[];
};

export const RESUME_PROJECTS: ResumeProject[] = [
  {
    id: "auto-trader",
    githubNames: ["auto-trader"],
    heading: "auto-trader",
    location: "College Park, Maryland",
    role: "Automated Swing-Trading System",
    bullets: [
      "Built a deterministic Python signals engine (momentum / RSI(2) / SPY regime filter) with inverse-volatility weighting, ATR trailing stops, and ring-fenced stock + options sleeves.",
      "Designed a reviewer/executor agent workflow that proposes orders as JSON, applies hard validation, and executes PASS trades via Robinhood Agentic MCP with journaled fills.",
    ],
    tags: ["quant", "trading", "python", "backtest", "momentum", "options", "fintech", "systematic"],
  },
  {
    id: "sketch2solve",
    githubNames: ["Sketch2Solve"],
    heading: "Sketch2Solve",
    location: "College Park, Maryland",
    role: "Multimodal AI Coding Coach",
    bullets: [
      "Built a Next.js coach fusing Whisper speech, tldraw + GPT-4o vision, and Monaco pseudocode to infer algorithmic intent and return Socratic hints.",
      "Orchestrated foundation models over structured LeetCode context via FastAPI + SQLite with WebSocket live transcript sync.",
    ],
    tags: ["ml", "ai", "llm", "next.js", "fastapi", "python", "typescript", "vision"],
  },
  {
    id: "audit-ai",
    githubNames: ["Bitcamp2024", "SignLanguage_Extension"],
    heading: "Audit.AI (Bitcamp 2024 Hackathon Winner)",
    location: "College Park, Maryland",
    role: "Full Stack Developer",
    bullets: [
      "Built a YOLOv6-based multimodal ML system using Python and PyTorch to detect misinformation at scale.",
      "Engineered scalable backend with MongoDB and Redis caching for real-time media auditing, earning best overall hack.",
    ],
    tags: ["ml", "ai", "pytorch", "computer vision", "yolo", "python", "mongodb", "redis"],
  },
  {
    id: "asktestudo",
    githubNames: ["HoyaHacksAskTestudo"],
    heading: "askTestudo",
    location: "Georgetown, Maryland",
    role: "Lead Backend Developer",
    bullets: [
      "Trained an LLM chatbot with Azure OpenAI \\& Retrieval-Augmented Generation (RAG) for precise query handling.",
      "Integrated vector search indexing, multimodal video responses, and chat UI in a React/FastAPI/MongoDB app.",
    ],
    tags: ["llm", "rag", "azure", "fastapi", "react", "mongodb", "fullstack"],
  },
];

/** Skills bank — only these may appear; tailoring reorders to surface JD matches. */
export const SKILLS = {
  languages: ["Python", "Java", "JavaScript", "TypeScript", "C++", "C", "SQL", "R", "HTML", "CSS"],
  frameworks: ["React.js", "Node.js", "FastAPI", "Flask", "React Native", "PyTorch", "TensorFlow", "Bootstrap"],
  cloud: ["AWS", "Azure", "Google Cloud", "Docker", "Kubernetes", "Cloudflare", "GitHub Actions", "CI/CD", "Linux", "Ubuntu"],
  databases: ["PostgreSQL", "MongoDB", "Redis", "MySQL", "Jupyter", "Colab", "VS Code", "IntelliJ", "Git", "Eclipse", "Bash"],
} as const;

export const LATEX_EXPERIENCE = String.raw`
\section{Experience}
  \resumeSubHeadingListStart

    \resumeSubheading
      {Software Development Engineer Intern, Amazon}{Seattle, Washington}
      {LLM Deployment Cost Optimization (MARS)}{}
      \resumeItemListStart
        \resumeItem{Extended MARS, Amazon's internal system for finding a model's cheapest deployment configuration, beyond weight-only optimizations (e.g.\ quantization) by adding knowledge distillation, its first parameter-modifying technique.}
        \resumeItem{Built hard-label, soft-label, and feature-based distillation pipelines with NVIDIA Model-Opt, Axolotl, and LLaMA-Factory to fine-tune the production Qwen 3.5 model that fills missing product type attributes (PTA) on Amazon's catalog.}
        \resumeItem{Designed a pipeline-composition framework spanning Model-Opt techniques (speculative decoding, pruning, quantization, distillation), using heuristic and surrogate-model search to find the best-serving combination.}
      \resumeItemListEnd

    \resumeSubheading
      {CEO, Synari}{College Park, Maryland}
      {AI-Powered Practice Management Startup for Cognitive Therapy (\href{https://synari.org}{synari.org})}{}
      \resumeItemListStart
        \resumeItem{Grew platform to \$1,000 monthly recurring revenue (MRR) within 3 months by acquiring paying therapist clients.}
        \resumeItem{Built and launched core features (billing, treatment planning, clinical notes) with Python, FastAPI, React, and Stripe, reducing documentation time for therapists by 40\%. Built and deployed with Docker on Railway through Git.}
        \resumeItem{Implemented secure HIPAA-compliant AWS infra (EC2, S3, RDS) with encryption, IAM, and VPC isolation.}
        \resumeItem{Selected for Telora Fellowship and engaged with Mokhtarzada Hatchery, refining strategy and pitching to investors.}
      \resumeItemListEnd

    \resumeSubheading
      {Software Engineer, University Career Center (UCC)}{Remote, New Jersey}
      {Full-Stack Software Engineering (Academic-Year Internship)}{}
      \resumeItemListStart
        \resumeItem{Built and maintained Intern for a Day (\href{https://ifad.umd.edu}{ifad.umd.edu}) serving 1,000+ students/cycle on FastAPI, React/TS, PostgreSQL.}
        \resumeItem{Built custom student matching algorithm integrating Google Gemini for semantic checks, halving coordinator time.}
        \resumeItem{Led a \$35K Do Good-funded upgrade adding RBAC, FERPA-aware PII controls, audit logs, and data-retention policies.}
        \resumeItem{Shipped CI/CD (GitHub Actions + Docker) and monitoring; query tuning and caching cut p50 page load $\sim$30\%.}
      \resumeItemListEnd

    \resumeSubheading
      {Startup Software Engineer Intern, SPARK}{Remote, New Jersey}
      {Full Stack Software Development Internship}{}
      \resumeItemListStart
        \resumeItem{Built and deployed scalable web applications using React, Python, and FastAPI, improving UX load time by 35\%.}
        \resumeItem{Integrated Stripe, AWS Lambda, and ElevenLabs voice API for secure payments, cutting latency by 20\%.}
        \resumeItem{Designed backend microservices and REST APIs using PostgreSQL and Docker to support concurrent user sessions.}
      \resumeItemListEnd

    \resumeSubheading
      {SAR Synthetic Dataset Research Intern, Professor Triet Le}{College Park, Maryland}
      {Software/ML Research Assistant}{}
      \resumeItemListStart
        \resumeItem{Developed SAR dataset in MATLAB/Python/C to reduce data scarcity and enable self-supervised learning.}
        \resumeItem{Implemented a preprocessing pipeline (calibration, speckle filtering, normalization, tiling, augmentation) to improve model signal-to-noise and training stability.}
        \resumeItem{Benchmarked CNN baselines against classical ML (SVM/Random Forest) with k-fold CV on SAR classification, segmentation, and backscatter-regression tasks.}
      \resumeItemListEnd

  \resumeSubHeadingListEnd
`.trim();
