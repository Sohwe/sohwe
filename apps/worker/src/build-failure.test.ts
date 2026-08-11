import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatBuildFailureSummary,
  MAX_FAILURE_SUMMARY_BYTES,
  summarizeBuildFailure
} from "./build-failure";

/** The shape almost every real build failure arrives in. */
const GENERIC = "docker build failed with exit code 1";

function summarize(recentLines: string[], errorMessage = GENERIC) {
  return summarizeBuildFailure({ errorMessage, recentLines });
}

describe("summarizeBuildFailure", () => {
  it("names a disk-space failure", () => {
    const s = summarize([
      "#8 [4/6] RUN npm ci",
      "#8 12.4 write /app/node_modules/x: no space left on device"
    ]);
    assert.match(s.headline, /disk space/i);
    assert.match(s.hint ?? "", /prune/);
  });

  it("names a Node heap exhaustion", () => {
    const s = summarize([
      "<--- Last few GCs --->",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"
    ]);
    assert.match(s.headline, /out of memory/i);
    assert.match(s.hint ?? "", /max-old-space-size/);
  });

  it("reads an OOM kill as a memory problem", () => {
    const s = summarize(["#9 45.1 Killed", "exit code: 137"]);
    assert.match(s.headline, /memory/i);
  });

  it("names an inaccessible base image", () => {
    const s = summarize([
      "#1 [internal] load metadata for docker.io/library/private-thing:1",
      "pull access denied for private-thing, repository does not exist"
    ]);
    assert.match(s.headline, /private-thing/);
    assert.match(s.headline, /access denied/i);
  });

  it("names a base image tag that does not exist", () => {
    const s = summarize(["manifest for node:99-alpine not found"]);
    assert.match(s.headline, /node:99-alpine/);
  });

  it("names the npm error code", () => {
    const s = summarize([
      "#7 8.2 npm ERR! code ERESOLVE",
      "#7 8.2 npm ERR! ERESOLVE unable to resolve dependency tree"
    ]);
    assert.match(s.headline, /npm/i);
    assert.match(s.headline, /ERESOLVE/);
  });

  it("names a pnpm error", () => {
    const s = summarize(["ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile"]);
    assert.match(s.headline, /pnpm/i);
    assert.match(s.headline, /outdated lockfile/);
  });

  it("names an unresolvable pip requirement", () => {
    const s = summarize([
      "ERROR: Could not find a version that satisfies the requirement flask==99.0"
    ]);
    assert.match(s.headline, /flask==99\.0/);
  });

  it("names a TypeScript compile failure", () => {
    const s = summarize([
      "src/index.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'."
    ]);
    assert.match(s.headline, /TypeScript/);
  });

  it("names the failing Dockerfile step and its exit code", () => {
    const s = summarize([
      "The command '/bin/sh -c npm run build' returned a non-zero code: 2"
    ]);
    assert.match(s.headline, /exit 2/);
    assert.match(s.headline, /npm run build/);
  });

  it("carries through a BuildKit solve failure", () => {
    const s = summarize([
      "failed to solve: process \"/bin/sh -c go build ./...\" did not complete successfully"
    ]);
    assert.match(s.headline, /Docker build failed/);
    assert.match(s.headline, /go build/);
  });

  it("prefers the last matching signature", () => {
    // An early npm warning must not outrank the error that stopped the build.
    const s = summarize([
      "npm ERR! code EEARLY",
      "later output",
      "no space left on device"
    ]);
    assert.match(s.headline, /disk space/i);
  });

  it("falls back to the raw error with recent lines as evidence", () => {
    const s = summarize(["something unusual happened", "and then it stopped"]);
    assert.equal(s.headline, GENERIC);
    assert.deepEqual(s.evidence, ["something unusual happened", "and then it stopped"]);
  });

  it("does not treat BuildKit progress noise as evidence", () => {
    const s = summarize([
      "#5 DONE 0.1s",
      "#6 CACHED",
      "#7 transferring context: 2.1MB",
      "[sohwe] Engine: docker build (Dockerfile detected)",
      "the only real line"
    ]);
    assert.deepEqual(s.evidence, ["the only real line"]);
  });

  it("handles an empty log", () => {
    const s = summarize([]);
    assert.equal(s.headline, GENERIC);
    assert.deepEqual(s.evidence, []);
  });

  it("only scans the tail of a long log", () => {
    // A stale match far above the failure must not win.
    const noise = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`);
    const s = summarize(["no space left on device", ...noise]);
    assert.equal(s.headline, GENERIC);
  });
});

describe("formatBuildFailureSummary", () => {
  it("leads with the headline and keeps the raw error", () => {
    const text = formatBuildFailureSummary(
      { headline: "Something broke", evidence: ["line one"], hint: "do a thing" },
      GENERIC
    );
    const lines = text.split("\n");
    assert.equal(lines[0], "Something broke");
    assert.match(text, /line one/);
    assert.match(text, /Try: do a thing/);
    assert.match(text, /Build error: docker build failed with exit code 1/);
  });

  it("does not repeat the raw error when it is the headline", () => {
    const text = formatBuildFailureSummary(
      { headline: GENERIC, evidence: [] },
      GENERIC
    );
    assert.equal(text, GENERIC);
  });

  it("stays within the stored size cap", () => {
    const text = formatBuildFailureSummary(
      {
        headline: "x".repeat(500),
        evidence: Array.from({ length: 200 }, () => "y".repeat(400))
      },
      GENERIC
    );
    assert.ok(Buffer.byteLength(text, "utf8") <= MAX_FAILURE_SUMMARY_BYTES);
  });

  it("survives a round trip from a realistic failed build", () => {
    const log = [
      "[sohwe] Engine: docker build (Dockerfile detected)",
      "#5 [2/5] RUN npm ci",
      "#5 DONE 12.0s",
      "#6 [3/5] RUN npm run build",
      "#6 4.1 src/app.ts(9,3): error TS2554: Expected 1 arguments, but got 0.",
      "#6 ERROR: process \"/bin/sh -c npm run build\" did not complete successfully"
    ];
    const text = formatBuildFailureSummary(summarize(log), GENERIC);
    assert.match(text, /TypeScript compilation failed/);
    assert.match(text, /TS2554/);
  });
});
