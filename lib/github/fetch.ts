import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CONTACT_PATH = process.env.CONTACT_PATH ?? "./data/contact.json";
const API = "https://api.github.com";

export type RawGithubRepo = {
  name: string;
  url: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stars: number;
  pushedAt: string;
  fork: boolean;
  archived: boolean;
  private: boolean;
  readmeExcerpt: string;
};

type ContactShape = { github?: string; website?: string };

export function resolveGithubUsername(): string {
  if (process.env.GITHUB_USERNAME?.trim()) return process.env.GITHUB_USERNAME.trim();
  if (existsSync(CONTACT_PATH)) {
    const contact = JSON.parse(readFileSync(CONTACT_PATH, "utf-8")) as ContactShape;
    if (contact.github) {
      const m = contact.github.match(/github\.com\/([^/\s?#]+)/i);
      if (m) return m[1];
      if (/^[A-Za-z0-9-]+$/.test(contact.github)) return contact.github;
    }
  }
  throw new Error(
    "GitHub username not found. Set data/contact.json → \"github\": \"https://github.com/<user>\" or GITHUB_USERNAME.",
  );
}

/** Prefer GITHUB_TOKEN; fall back to `gh auth token` so private repos work. */
function resolveGithubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "auto-apply",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = resolveGithubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

type GhRepo = {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  pushed_at: string;
  fork: boolean;
  archived: boolean;
  private: boolean;
  default_branch: string;
  size: number;
  owner: { login: string };
};

async function fetchReadmeExcerpt(owner: string, repo: string): Promise<string> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/readme`, {
    headers: { ...authHeaders(), Accept: "application/vnd.github.raw" },
  });
  if (!res.ok) return "";
  const text = await res.text();
  return text.slice(0, 2500);
}

/**
 * List repos for a user with README excerpts.
 * With auth (GITHUB_TOKEN or `gh auth`): includes private repos via /user/repos.
 * Without auth: public repos only via /users/:user/repos.
 */
export async function fetchGithubRepos(username: string): Promise<RawGithubRepo[]> {
  const token = resolveGithubToken();
  let repos: GhRepo[];

  if (token) {
    // Authenticated: private + public owned by the user (affiliation=owner).
    const all = await ghJson<GhRepo[]>(
      `/user/repos?per_page=100&sort=updated&affiliation=owner`,
    );
    repos = all.filter((r) => r.owner.login.toLowerCase() === username.toLowerCase());
  } else {
    console.warn(
      "No GITHUB_TOKEN / gh auth — listing public repos only. Private repos (e.g. auto-trader) will be missed.",
    );
    repos = await ghJson<GhRepo[]>(
      `/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated&type=owner`,
    );
  }

  const kept = repos.filter((r) => !r.archived && r.size > 0);
  const out: RawGithubRepo[] = [];

  for (const r of kept) {
    const readmeExcerpt = await fetchReadmeExcerpt(r.owner.login, r.name);
    out.push({
      name: r.name,
      url: r.html_url,
      description: r.description,
      language: r.language,
      topics: r.topics ?? [],
      stars: r.stargazers_count,
      pushedAt: r.pushed_at,
      fork: r.fork,
      archived: r.archived,
      private: r.private,
      readmeExcerpt,
    });
  }
  return out;
}
