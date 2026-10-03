import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { pullPublicImage } from "./image-source";

describe("public image import", () => {
  it("waits for the pull and returns the immutable image ID", async () => {
    const calls: string[] = [];
    const stream = new PassThrough();
    const docker = {
      pull: async (ref: string) => { calls.push(`pull:${ref}`); return stream; },
      modem: { followProgress: (_stream: PassThrough, done: (error?: Error) => void) => { calls.push("finished"); done(); } },
      getImage: (ref: string) => ({ inspect: async () => { calls.push(`inspect:${ref}`); return { Id: "sha256:fixed-image-id" }; } })
    } as unknown as Docker;
    assert.equal(await pullPublicImage(docker, "ghcr.io/acme/web:1.0.0"), "sha256:fixed-image-id");
    assert.deepEqual(calls, ["pull:ghcr.io/acme/web:1.0.0", "finished", "inspect:ghcr.io/acme/web:1.0.0"]);
  });

  it("rejects URL-shaped references before contacting Docker", async () => {
    const docker = { pull: () => { throw new Error("called Docker"); } } as unknown as Docker;
    await assert.rejects(pullPublicImage(docker, "https://registry.example/web"));
  });
});
