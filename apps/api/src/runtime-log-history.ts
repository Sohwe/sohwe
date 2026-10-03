export const MAX_RUNTIME_HISTORY_LINES = 1000;

/** Docker's timestamps are RFC3339Nano; JavaScript Date accepts that form. */
export function filterTimestampedRuntimeLogs(
  text: string,
  from: Date,
  to: Date,
  limit = MAX_RUNTIME_HISTORY_LINES
): { text: string; count: number; truncated: boolean } {
  const rows: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const timestamp = Date.parse(line.slice(0, space));
    if (!Number.isFinite(timestamp) || timestamp < from.getTime() || timestamp > to.getTime()) continue;
    rows.push(line);
  }
  const truncated = rows.length > limit;
  const shown = truncated ? rows.slice(-limit) : rows;
  return { text: shown.length ? `${shown.join("\n")}\n` : "", count: shown.length, truncated };
}
