/**
 * Persistence for `Deployment.buildLogs`.
 *
 * Build output streams live over Redis pub/sub; this module owns the *stored*
 * copy, which exists only so the SSE route can replay a build to a client that
 * connects (or reconnects) after lines were already emitted.
 *
 * Two properties matter and neither is free:
 *
 * - **Bounded size.** The stored copy is replayed in full on every reconnect
 *   and lives in a Postgres `TEXT` column forever. An unbounded log turns a
 *   noisy build into a multi-megabyte row and a multi-megabyte SSE frame.
 * - **Bounded write cost.** Appending must not re-send the accumulated log on
 *   every flush, or a long build costs O(n^2) in database traffic.
 *
 * The sink keeps the head and a rolling tail in memory (capped, so at most
 * `BUILD_LOG_MAX_BYTES`) and persists through two operations: cheap `append`
 * while the head still has room, then occasional whole-value `replace` once the
 * log is being truncated. Most builds never leave the append path.
 */

/** Total stored size ceiling for a single deployment's build log. */
export const BUILD_LOG_MAX_BYTES = 512 * 1024;

/** How much of the ceiling is reserved for the beginning of the build. */
export const BUILD_LOG_HEAD_BYTES = 128 * 1024;

/** The remainder holds the most recent output, which is what failures need. */
export const BUILD_LOG_TAIL_BYTES = BUILD_LOG_MAX_BYTES - BUILD_LOG_HEAD_BYTES;

/** Debounce for coalescing lines into one write. */
export const BUILD_LOG_FLUSH_MS = 200;

/**
 * Once truncating, each flush rewrites the whole capped value, so flush far
 * less often. Live viewers are unaffected — they read the Redis stream.
 */
export const BUILD_LOG_TAIL_FLUSH_MS = 3000;

export const BUILD_LOG_TRUNCATION_NOTICE =
  "\n[sohwe] ---- build log truncated: this build exceeded the stored log limit, " +
  "so the middle was dropped. The beginning and the most recent output are kept; " +
  "the full log streamed live while the build ran. ----\n\n";

/** How the sink writes to storage. Injected so the sink stays testable. */
export interface BuildLogStore {
  /** Concatenate `text` onto the stored value without reading it back. */
  append(text: string): Promise<void>;
  /** Overwrite the stored value with `text`. */
  replace(text: string): Promise<void>;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Longest prefix of `text` that fits in `maxBytes`, cut at a line boundary.
 *
 * Slicing a UTF-8 buffer can split a multi-byte character, and `toString`
 * turns the partial tail into U+FFFD. Cutting back to the last newline avoids
 * that in the line-oriented case; the fallback strips a trailing replacement
 * character for input that has no newline at all.
 */
export function takeHeadBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  const nl = cut.lastIndexOf("\n");
  if (nl >= 0) return cut.slice(0, nl + 1);
  return cut.replace(/�+$/, "");
}

/** Newest `maxBytes` of `text`, starting at a line boundary. */
export function takeTailBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  const kept = buf.subarray(buf.length - maxBytes).toString("utf8");
  const nl = kept.indexOf("\n");
  if (nl >= 0) return kept.slice(nl + 1);
  return kept.replace(/^�+/, "");
}

export class LogSink {
  /** Lines accepted but not yet folded into head/tail. */
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Beginning of the build, never dropped. */
  private head = "";
  /** Part of `head` not yet appended to storage. */
  private unwritten = "";
  private headFull = false;

  /** Rolling window of the most recent output, capped. */
  private tail = "";
  private tailDirty = false;
  private lastReplaceAt = 0;

  private closed = false;

  constructor(
    private readonly store: BuildLogStore,
    private readonly now: () => number = Date.now
  ) {}

  line(text: string): void {
    if (this.closed) return;
    this.pending += text.endsWith("\n") ? text : `${text}\n`;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush(false);
    }, BUILD_LOG_FLUSH_MS);
  }

  /** Flush everything and stop accepting lines. */
  async end(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush(true);
    this.closed = true;
  }

  /** True once output started being dropped. */
  get isTruncated(): boolean {
    return this.headFull;
  }

  /**
   * Last `maxLines` lines the sink has seen, for failure diagnosis. Reads from
   * the in-memory copy, so it never touches the database.
   */
  recentLines(maxLines: number): string[] {
    const all = `${this.head}${this.tail}${this.pending}`;
    const lines = all.split("\n").filter((l) => l.length > 0);
    return lines.slice(Math.max(0, lines.length - maxLines));
  }

  private absorb(text: string): void {
    let rest = text;
    if (!this.headFull) {
      const room = BUILD_LOG_HEAD_BYTES - byteLength(this.head);
      const take = takeHeadBytes(rest, room);
      this.head += take;
      this.unwritten += take;
      rest = rest.slice(take.length);
      if (rest.length === 0) return;
      // Anything left over means the head budget is spent.
      this.headFull = true;
    }
    this.tail = takeTailBytes(this.tail + rest, BUILD_LOG_TAIL_BYTES);
    this.tailDirty = true;
  }

  private async flush(final: boolean): Promise<void> {
    if (this.pending) {
      this.absorb(this.pending);
      this.pending = "";
    }

    if (!this.headFull) {
      if (!this.unwritten) return;
      const addition = this.unwritten;
      this.unwritten = "";
      await this.store.append(addition);
      return;
    }

    if (!this.tailDirty && !this.unwritten) return;
    // Each rewrite costs the full capped value, so rate-limit it. A skipped
    // flush is picked up by the next line's timer, and `end()` always writes.
    if (!final && this.now() - this.lastReplaceAt < BUILD_LOG_TAIL_FLUSH_MS) {
      return;
    }
    this.unwritten = "";
    this.tailDirty = false;
    this.lastReplaceAt = this.now();
    await this.store.replace(
      `${this.head}${BUILD_LOG_TRUNCATION_NOTICE}${this.tail}`
    );
  }
}
