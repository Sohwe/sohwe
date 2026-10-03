import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeployLink } from "./deploy-link.ts";

describe("Deploy with Sohwe links", () => {
  it("ignores ordinary application URLs", () => {
    assert.deepEqual(parseDeployLink(""), { kind: "none" });
    assert.deepEqual(parseDeployLink("?page=2"), { kind: "none" });
  });

  it("accepts repository hints without carrying variable values", () => {
    assert.deepEqual(
      parseDeployLink("?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb.git&branch=release%2Fnext&config=apps%2Fweb%2Fsohwe.yaml"),
      {
        kind: "valid",
        value: {
          repo: "https://github.com/acme/web.git",
          branch: "release/next",
          configPath: "apps/web/sohwe.yaml"
        }
      }
    );
    assert.deepEqual(parseDeployLink("?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb"), {
      kind: "valid",
      value: { repo: "https://github.com/acme/web" }
    });
  });

  it("rejects malformed, secret-bearing, and repeated hints", () => {
    for (const search of [
      "?branch=main",
      "?repo=http%3A%2F%2Fgithub.com%2Facme%2Fweb",
      "?repo=https%3A%2F%2Ftoken%40github.com%2Facme%2Fweb",
      "?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb%3Ftoken%3Dvalue",
      "?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb&env=SECRET",
      "?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb&repo=https%3A%2F%2Fgithub.com%2Fother%2Fweb",
      "?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb&config=..%2Fsohwe.yaml",
      "?repo=https%3A%2F%2Fgithub.com%2Facme%2Fweb&branch=bad%20branch"
    ]) {
      assert.equal(parseDeployLink(search).kind, "invalid", search);
    }
  });
});
