import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyScopedPatch,
  maskedScopedListing,
  mergeScoped,
  splitScoped
} from "./variable-store";

/**
 * The unified variable list derives each key's scope from which of the two
 * encrypted maps hold it. These cover the round trip in both directions, since
 * a mistake either way silently changes what reaches a build.
 */
describe("scoped variables", () => {
  it("derives a scope from which maps hold the key", () => {
    const merged = mergeScoped(
      { DATABASE_URL: "postgres://x", NODE_ENV: "production" },
      { NIXPACKS_NODE_VERSION: "22", NODE_ENV: "production" }
    );
    assert.deepEqual(
      merged.map((v) => [v.key, v.scope]),
      [
        ["DATABASE_URL", "runtime"],
        ["NIXPACKS_NODE_VERSION", "build"],
        ["NODE_ENV", "both"]
      ]
    );
    // Key-sorted, and every entry carries a value.
    assert.equal(merged[2]?.value, "production");
  });

  it("flags a key the two maps disagree about instead of picking one", () => {
    const [entry] = mergeScoped({ API_URL: "runtime-value" }, { API_URL: "build-value" });
    assert.equal(entry?.scope, "both");
    assert.equal(entry?.value, "runtime-value");
    assert.equal(entry?.buildValue, "build-value");

    // The masked listing surfaces the disagreement without showing values.
    const item = maskedScopedListing(mergeScoped({ API_URL: "runtime-value" }, { API_URL: "build-value" })).items[0] as {
      conflict?: boolean;
      preview: string;
    };
    assert.equal(item.conflict, true);
    assert.doesNotMatch(item.preview, /runtime-value/);
  });

  it("splits a unified list back into the two maps", () => {
    const { env, build } = splitScoped([
      { key: "SECRET", value: "s", scope: "runtime" },
      { key: "TOOLCHAIN", value: "22", scope: "build" },
      { key: "PUBLIC_URL", value: "https://x", scope: "both" }
    ]);
    assert.deepEqual(env, { SECRET: "s", PUBLIC_URL: "https://x" });
    assert.deepEqual(build, { TOOLCHAIN: "22", PUBLIC_URL: "https://x" });
  });

  it("round-trips a merge through a split unchanged", () => {
    const env = { A: "1", C: "3" };
    const build = { B: "2", C: "3" };
    const back = splitScoped(
      mergeScoped(env, build).map((v) => ({ key: v.key, value: v.value, scope: v.scope }))
    );
    assert.deepEqual(back.env, env);
    assert.deepEqual(back.build, build);
  });

  it("narrowing a scope removes the key from the map it left", () => {
    // The whole point of the scope control: moving `both` -> `runtime` has to
    // stop the value reaching the image, not just add it to the container.
    const { env, build } = applyScopedPatch(
      { SHARED: "v" },
      { SHARED: "v" },
      [{ key: "SHARED", value: "v", scope: "runtime" }],
      undefined
    );
    assert.deepEqual(env, { SHARED: "v" });
    assert.deepEqual(build, {});
  });

  it("unset removes a key from both maps and wins over set", () => {
    const { env, build } = applyScopedPatch(
      { GONE: "v", KEPT: "k" },
      { GONE: "v" },
      [{ key: "GONE", value: "new", scope: "both" }],
      ["GONE"]
    );
    assert.deepEqual(env, { KEPT: "k" });
    assert.deepEqual(build, {});
  });

  it("treats an empty map pair as an empty list", () => {
    assert.deepEqual(mergeScoped({}, {}), []);
    assert.deepEqual(splitScoped([]), { env: {}, build: {} });
  });
});
