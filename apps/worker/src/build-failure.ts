/**
 * Turning a build failure into something a user can act on.
 *
 * The thrown error is usually shaped by the tool that exited, not by what went
 * wrong: `docker build failed with exit code 1` says nothing about the missing
 * dependency that caused it. That bare string is what `Deployment.errorMessage`
 * stored and what the dashboard showed, so every failure looked identical and
 * the only recourse was reading the whole build log.
 *
 * `summarizeBuildFailure` scans the tail of the build output for known failure
 * signatures and produces a headline, the log lines that justify it, and a hint
 * where one is genuinely useful. It is pure — the caller supplies the lines, so
 * this stays unit-testable and never reaches for the database or the network.
 */

export type BuildFailureSummary = {
  /** One line naming the actual cause, or the raw error if nothing matched. */
  headline: string;
  /** Log lines supporting the headline, oldest first. May be empty. */
  evidence: string[];
  /** Actionable next step, when the signature implies one. */
  hint?: string;
};

/** How many trailing log lines to consider. */
export const BUILD_FAILURE_SCAN_LINES = 200;

/** Cap on any single line copied into the summary. */
const MAX_EVIDENCE_LINE = 400;

/** Cap on the whole formatted summary, since it lands in a database column. */
export const MAX_FAILURE_SUMMARY_BYTES = 4000;

type Rule = {
  /** Matched against a single log line. */
  pattern: RegExp;
  headline: (match: RegExpMatchArray, line: string) => string;
  hint?: string;
  /** Extra lines to keep around the match, for context. */
  context?: number;
};

/**
 * Ordered most specific first. The scan walks the log backwards, so the last
 * occurrence wins, which is normally the one that stopped the build.
 */
const RULES: Rule[] = [
  {
    pattern: /no space left on device/i,
    headline: () => "The host ran out of disk space during the build",
    hint: "Free space on the server (`docker system prune -af` removes unused images and build cache), then redeploy."
  },
  {
    pattern: /JavaScript heap out of memory|Reached heap limit/i,
    headline: () => "The build ran out of memory (Node heap exhausted)",
    hint: "Raise the app's memory limit, or set NODE_OPTIONS=--max-old-space-size=<MB> as a build-time environment variable."
  },
  {
    pattern: /(?:^|\s)Killed(?:\s|$)|signal: killed|exit code:? 137/i,
    headline: () => "The build process was killed, which usually means it ran out of memory",
    hint: "Raise the app's memory limit and redeploy."
  },
  {
    pattern: /pull access denied for (\S+)|denied: requested access to the resource is denied/i,
    headline: (m) =>
      m[1]
        ? `Cannot pull the base image "${m[1]}" — access denied`
        : "Cannot pull the base image — registry access denied",
    hint: "Check the FROM line in your Dockerfile. Private base images are not supported yet."
  },
  {
    pattern: /manifest for (\S+) not found|manifest unknown/i,
    headline: (m) =>
      m[1]
        ? `Base image "${m[1]}" does not exist`
        : "The requested base image tag does not exist",
    hint: "Check the image name and tag in your Dockerfile's FROM line."
  },
  {
    pattern: /^\s*ERR_PNPM_([A-Z_]+)\s*(.*)$/,
    headline: (m) => `pnpm failed: ${m[1]?.toLowerCase().replace(/_/g, " ") ?? "error"}`,
    context: 2
  },
  {
    pattern: /npm ERR! code (\S+)/,
    headline: (m) => `npm failed with ${m[1] ?? "an error"}`,
    context: 4
  },
  {
    pattern: /ERROR: Could not find a version that satisfies the requirement (\S+)/,
    headline: (m) => `pip could not resolve the requirement "${m[1] ?? "?"}"`,
    hint: "Check the package name and version pin in requirements.txt."
  },
  {
    pattern: /error TS\d+:/,
    headline: () => "TypeScript compilation failed",
    context: 4
  },
  {
    pattern: /The command '(.+)' returned a non-zero code: (\d+)/,
    headline: (m) =>
      `A Dockerfile step failed (exit ${m[2] ?? "?"}): ${truncate(m[1] ?? "", 160)}`,
    context: 4
  },
  {
    pattern: /^failed to solve: (.+)$/,
    headline: (m) => `Docker build failed: ${truncate(m[1] ?? "", 200)}`,
    context: 3
  },
  {
    pattern: /(?:not found|No such file or directory)/i,
    headline: (m, line) => `A build step referenced something missing: ${truncate(line, 200)}`,
    context: 2
  }
];

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Lines that carry no diagnostic value. Docker's BuildKit progress output is
 * mostly these, and letting them into the evidence buries the real error.
 */
function isNoise(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^#\d+\s+(\d+\.\d+\s+)?(DONE|CACHED|sha256:|extracting|resolve |transferring|load )/i.test(t)) {
    return true;
  }
  if (/^\[sohwe\]/.test(t)) return true;
  if (/^\s*(-{3,}|={3,})\s*$/.test(t)) return true;
  return false;
}

export function summarizeBuildFailure(input: {
  /** The thrown, already-redacted error message. */
  errorMessage: string;
  /** Trailing build log lines, oldest first. */
  recentLines: string[];
}): BuildFailureSummary {
  const lines = input.recentLines.slice(-BUILD_FAILURE_SCAN_LINES);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || isNoise(line)) continue;
    for (const rule of RULES) {
      const m = line.match(rule.pattern);
      if (!m) continue;
      const span = rule.context ?? 1;
      const evidence = lines
        .slice(Math.max(0, i - span + 1), i + 1)
        .filter((l) => !isNoise(l))
        .map((l) => truncate(l, MAX_EVIDENCE_LINE));
      return {
        headline: rule.headline(m, line),
        evidence,
        ...(rule.hint ? { hint: rule.hint } : {})
      };
    }
  }

  // Nothing recognized. The last few meaningful lines still beat the bare
  // "exit code 1", so surface them as evidence under the raw error.
  const evidence = lines
    .filter((l) => !isNoise(l))
    .slice(-4)
    .map((l) => truncate(l, MAX_EVIDENCE_LINE));
  return { headline: truncate(input.errorMessage, 300), evidence };
}

/**
 * Render a summary for `Deployment.errorMessage`. The raw error is kept as the
 * last line so the underlying failure is never hidden, and the whole thing is
 * capped because it is stored and returned by the API.
 */
export function formatBuildFailureSummary(
  summary: BuildFailureSummary,
  rawError: string
): string {
  const parts = [summary.headline];
  if (summary.evidence.length > 0) {
    parts.push("", ...summary.evidence.map((l) => `  ${l}`));
  }
  if (summary.hint) parts.push("", `Try: ${summary.hint}`);
  if (summary.headline !== truncate(rawError, 300)) {
    parts.push("", `Build error: ${truncate(rawError, 300)}`);
  }
  const text = parts.join("\n");
  if (Buffer.byteLength(text, "utf8") <= MAX_FAILURE_SUMMARY_BYTES) return text;

  // Budget for the ellipsis in *bytes*, not characters: "…" is three UTF-8
  // bytes, and the cap exists to bound what goes into a database column.
  const ellipsis = "…";
  const budget = MAX_FAILURE_SUMMARY_BYTES - Buffer.byteLength(ellipsis, "utf8");
  const cut = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  // Slicing bytes can split a multi-byte character into U+FFFD; drop it.
  return `${cut.replace(/�+$/, "")}${ellipsis}`;
}
