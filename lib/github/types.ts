/** Role families used to score which GitHub projects to highlight for a JD. */
export const ROLE_FAMILIES = [
  "quant",
  "ml_ai",
  "fullstack_product",
  "backend_infra",
  "data",
  "systems",
  "general_swe",
] as const;

export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export type GithubProject = {
  name: string;
  url: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stars: number;
  pushedAt: string;
  /** First ~2k chars of README (or empty). */
  readmeExcerpt: string;
  /** One-line grounded summary from classification. */
  summary: string;
  /** Resume-style bullets grounded in the repo (never fabricated). */
  bullets: string[];
  /** 0–100 affinity per role family. */
  roleFits: Record<RoleFamily, number>;
  /** True for homework, forks-with-no-work, empty shells, etc. */
  skip: boolean;
  skipReason?: string;
};

export type GithubCatalog = {
  username: string;
  syncedAt: string;
  projects: GithubProject[];
};

export type RankedProject = GithubProject & { fitScore: number; why: string };
