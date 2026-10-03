import { ConfigPathSchema } from "@sohwe/types";

export type DeployLinkPrefill = {
  repo: string;
  branch?: string;
  configPath?: string;
};

export type DeployLinkResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "valid"; value: DeployLinkPrefill };

export const PENDING_DEPLOY_LINK_KEY = "sohwe:pending-deploy-link";

/** Parse only non-secret import hints. The repository is inspected before use. */
export function parseDeployLink(search: string): DeployLinkResult {
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (!keys.some((key) => ["repo", "branch", "config"].includes(key))) return { kind: "none" };
  if (search.length > 4096 || keys.some((key) => !["repo", "branch", "config"].includes(key)) ||
    ["repo", "branch", "config"].some((key) => params.getAll(key).length > 1)) {
    return { kind: "invalid", message: "This deploy link contains unsupported or repeated parameters." };
  }

  const repo = params.get("repo")?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return { kind: "invalid", message: "This deploy link needs a valid HTTPS repository URL." };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (repo.length > 2048 || url.protocol !== "https:" || !url.hostname || url.username || url.password ||
    url.search || url.hash || parts.length === 0 ||
    (["github.com", "www.github.com"].includes(url.hostname) && parts.length !== 2)) {
    return { kind: "invalid", message: "This deploy link needs an HTTPS Git repository URL without credentials or extra URL parameters." };
  }

  const branch = params.get("branch") ?? undefined;
  if (branch !== undefined && (!branch.trim() || branch.length > 255 || /\s/.test(branch) || branch.includes("\0"))) {
    return { kind: "invalid", message: "This deploy link has an invalid branch name." };
  }
  const configPath = params.get("config") ?? undefined;
  if (configPath !== undefined && !ConfigPathSchema.safeParse(configPath).success) {
    return { kind: "invalid", message: "This deploy link needs a repository-relative sohwe.yaml config path." };
  }

  return {
    kind: "valid",
    value: { repo, ...(branch ? { branch } : {}), ...(configPath ? { configPath } : {}) }
  };
}

/** Keep a link through first-run setup or sign-in without trusting a redirect URL. */
export function rememberDeployLink(): void {
  if (window.location.pathname !== "/apps" || window.location.search.length > 4096) return;
  if (parseDeployLink(window.location.search).kind === "valid") {
    sessionStorage.setItem(PENDING_DEPLOY_LINK_KEY, `/apps${window.location.search}`);
  }
}

export function consumeDeployLink(): string | null {
  const path = sessionStorage.getItem(PENDING_DEPLOY_LINK_KEY);
  sessionStorage.removeItem(PENDING_DEPLOY_LINK_KEY);
  if (!path) return null;
  const url = new URL(path, window.location.origin);
  return url.origin === window.location.origin && url.pathname === "/apps" &&
    parseDeployLink(url.search).kind === "valid" ? `${url.pathname}${url.search}` : null;
}
