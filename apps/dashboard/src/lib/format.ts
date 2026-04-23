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
