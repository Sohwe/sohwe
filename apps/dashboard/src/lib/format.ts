export function shortDepId(id: string): string {
  return id.replace(/-/g, "").slice(0, 9);
}

export function shortCommitSha(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.slice(0, 7);
}

export function formatDuration(
  start: string | null | undefined,
  end: string | null | undefined
): string {
  if (!start || !end) return "—";
  const ms = +new Date(end) - +new Date(start);
  if (ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

export function formatRelativeTime(iso: string): string {
  const t = +new Date(iso);
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function truncMsg(s: string | null | undefined, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const v = bytes / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** What started a deployment: `manual`, `push`, or `rollback`. */
export function triggerLabel(trigger: string): string {
  if (trigger === "push") return "Triggered by push";
  if (trigger === "rollback") return "Roll back";
  if (trigger === "manual") return "Manual deploy";
  return trigger;
}

/**
 * When a deployment ran, phrased for whichever stage it is in. A queued
 * deployment has no start time and a running one has no end, so the generic
 * "started → finished" duration reads as "—" for exactly the states a user is
 * most likely to be staring at.
 */
export function formatDeploymentTiming(d: {
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}): string {
  if (d.status === "pending") return `Queued ${formatRelativeTime(d.createdAt)}`;
  if (d.status === "building") {
    return d.startedAt ? `Started ${formatRelativeTime(d.startedAt)}` : "Starting…";
  }
  const dur = formatDuration(d.startedAt, d.finishedAt);
  const when = formatRelativeTime(d.finishedAt ?? d.createdAt);
  return dur === "—" ? when : `${when} · took ${dur}`;
}

export function deploymentResultLabel(status: string): {
  text: string;
  className: string;
} {
  if (status === "success")
    return { text: "Ready", className: "text-emerald-500" };
  if (status === "building" || status === "pending" || status === "running")
    return {
      text: status === "pending" ? "Queued" : "Building",
      className: "text-amber-500",
    };
  if (status === "failed")
    return { text: "Error", className: "text-destructive" };
  if (status === "cancelled")
    return { text: "Cancelled", className: "text-muted-foreground" };
  return { text: status, className: "text-muted-foreground" };
}

/**
 * Absolute local date and time. Use for values that `formatRelativeTime` would
 * garble — notably future timestamps like an invitation's expiry, which it
 * would render as "just now".
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
