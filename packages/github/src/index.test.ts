import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createHmac,
  createVerify,
  generateKeyPairSync,
  randomBytes
} from "node:crypto";
import {
  appInstallUrl,
  branchFromRef,
  buildAppManifest,
  createAppJwt,
  manifestCreateUrl,
  parseGitHubRepoUrl,
  parsePushEvent,
  parseRepoFullName,
  redactSecret,
  repoFullName,
  tokenizedCloneUrl,
  verifyWebhookSignature
} from "./index";

describe("parseGitHubRepoUrl", () => {
  const cases: [string, string, string][] = [
    ["https://github.com/acme/widget", "acme", "widget"],
    ["https://github.com/acme/widget.git", "acme", "widget"],
    ["https://github.com/acme/widget/", "acme", "widget"],
    ["http://github.com/acme/widget", "acme", "widget"],
    ["https://www.github.com/acme/widget", "acme", "widget"],
    ["git@github.com:acme/widget.git", "acme", "widget"],
    ["ssh://git@github.com/acme/widget.git", "acme", "widget"],
    ["  https://github.com/acme/widget  ", "acme", "widget"],
    ["https://GitHub.com/Acme/Widget.Net", "Acme", "Widget.Net"],
    ["https://github.com/a-b_c/d.e-f_g", "a-b_c", "d.e-f_g"]
  ];

  for (const [url, owner, repo] of cases) {
    it(`parses ${url}`, () => {
      assert.deepEqual(parseGitHubRepoUrl(url), { owner, repo });
    });
  }

  const rejected = [
    "",
    "   ",
    "not a url",
    "https://gitlab.com/acme/widget",
    "https://bitbucket.org/acme/widget",
    // A lookalike host must not be treated as GitHub.
    "https://github.com.evil.test/acme/widget",
    "https://evilgithub.com/acme/widget",
    "https://github.com/acme",
    "https://github.com/acme/widget/extra",
    "https://github.com//widget",
    "https://github.com/acme/..",
    "ftp://github.com/acme/widget"
  ];

  for (const url of rejected) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      assert.equal(parseGitHubRepoUrl(url), null);
    });
  }
});

describe("repoFullName / parseRepoFullName", () => {
  it("round-trips", () => {
    const ref = { owner: "acme", repo: "widget" };
    assert.equal(repoFullName(ref), "acme/widget");
    assert.deepEqual(parseRepoFullName("acme/widget"), ref);
  });

  it("strips a .git suffix", () => {
    assert.deepEqual(parseRepoFullName("acme/widget.git"), {
      owner: "acme",
      repo: "widget"
    });
  });

  for (const bad of ["", "acme", "acme/widget/extra", "acme/", "/widget", "a b/c"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(parseRepoFullName(bad), null);
    });
  }
});

describe("branchFromRef", () => {
  it("extracts a branch", () => {
    assert.equal(branchFromRef("refs/heads/main"), "main");
  });

  it("keeps slashes in the branch name", () => {
    assert.equal(branchFromRef("refs/heads/feature/foo"), "feature/foo");
  });

  it("rejects tags and other refs", () => {
    assert.equal(branchFromRef("refs/tags/v1.0.0"), null);
    assert.equal(branchFromRef("refs/pull/12/merge"), null);
    assert.equal(branchFromRef("refs/heads/"), null);
    assert.equal(branchFromRef("main"), null);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "s3cret-webhook-token";
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }), "utf8");

  const sign = (withSecret: string, payload: Buffer) =>
    `sha256=${createHmac("sha256", withSecret).update(payload).digest("hex")}`;

  it("accepts a signature over the exact raw bytes", () => {
    // Fixed vector: GitHub sends lowercase hex prefixed with `sha256=`, over
    // the raw body. If this changes, deliveries silently stop verifying.
    const sig = sign(secret, body);
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(verifyWebhookSignature(secret, body, sig), true);
  });

  it("rejects a signature made with a different secret", () => {
    assert.equal(verifyWebhookSignature(secret, body, sign("other", body)), false);
  });

  it("rejects a tampered body", () => {
    const sig = sign(secret, body);
    const tampered = Buffer.from(
      JSON.stringify({ ref: "refs/heads/evil" }),
      "utf8"
    );
    assert.equal(verifyWebhookSignature(secret, tampered, sig), false);
  });

  it("rejects a missing, empty, or malformed header", () => {
    assert.equal(verifyWebhookSignature(secret, body, undefined), false);
    assert.equal(verifyWebhookSignature(secret, body, ""), false);
    assert.equal(verifyWebhookSignature(secret, body, "sha256=zz"), false);
    assert.equal(verifyWebhookSignature(secret, body, "not-a-signature"), false);
  });

  it("rejects when no secret is configured", () => {
    assert.equal(verifyWebhookSignature("", body, "sha256=abc"), false);
  });
});

describe("createAppJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const pem = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  it("produces a verifiable RS256 JWT with the expected claims", () => {
    const now = 1_700_000_000;
    const jwt = createAppJwt(1234, pem, now);
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);

    const [headerPart, payloadPart, signaturePart] = parts;
    assert.ok(headerPart && payloadPart && signaturePart);

    const header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    assert.deepEqual(header, { alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    assert.equal(payload.iss, "1234");
    // Backdated to tolerate clock skew, and inside GitHub's 10-minute cap.
    assert.equal(payload.iat, now - 60);
    assert.ok(typeof payload.exp === "number" && payload.exp - now <= 600);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart}.${payloadPart}`);
    verifier.end();
    assert.equal(
      verifier.verify(publicKey, Buffer.from(signaturePart, "base64url")),
      true
    );
  });

  it("does not verify against a different key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = createAppJwt(1234, pem, 1_700_000_000);
    const [h, p, s] = jwt.split(".");
    assert.ok(h && p && s);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    verifier.end();
    assert.equal(
      verifier.verify(other.publicKey, Buffer.from(s, "base64url")),
      false
    );
  });
});

describe("tokenizedCloneUrl / redactSecret", () => {
  const ref = { owner: "acme", repo: "widget" };
  const token = randomBytes(20).toString("hex");

  it("embeds the token as basic auth", () => {
    assert.equal(
      tokenizedCloneUrl(ref, token),
      `https://x-access-token:${token}@github.com/acme/widget.git`
    );
  });

  it("redacts every occurrence of the token", () => {
    const url = tokenizedCloneUrl(ref, token);
    const message = `fatal: could not read from ${url} (tried ${url})`;
    const safe = redactSecret(message, token);
    assert.equal(safe.includes(token), false);
    assert.equal(safe.includes("***"), true);
  });

  it("is a no-op without a secret", () => {
    assert.equal(redactSecret("plain text", undefined), "plain text");
    assert.equal(redactSecret("plain text", ""), "plain text");
  });
});

describe("parsePushEvent", () => {
  const base = {
    ref: "refs/heads/main",
    after: "a".repeat(40),
    deleted: false,
    repository: { full_name: "acme/widget" },
    head_commit: { message: "Fix the thing\n\nlonger body" }
  };

  it("narrows a branch push", () => {
    assert.deepEqual(parsePushEvent(base), {
      repoFullName: "acme/widget",
      branch: "main",
      headSha: "a".repeat(40),
      headMessage: "Fix the thing",
      deleted: false
    });
  });

  it("flags an explicit branch deletion", () => {
    const ev = parsePushEvent({ ...base, deleted: true });
    assert.equal(ev?.deleted, true);
  });

  it("flags a zero-sha deletion even without the deleted flag", () => {
    const ev = parsePushEvent({ ...base, after: "0".repeat(40) });
    assert.equal(ev?.deleted, true);
  });

  it("returns null for tag pushes", () => {
    assert.equal(parsePushEvent({ ...base, ref: "refs/tags/v1" }), null);
  });

  it("returns null for malformed payloads", () => {
    assert.equal(parsePushEvent(null), null);
    assert.equal(parsePushEvent("nope"), null);
    assert.equal(parsePushEvent({}), null);
    assert.equal(parsePushEvent({ ...base, repository: {} }), null);
  });

  it("tolerates a missing head_commit", () => {
    const ev = parsePushEvent({ ...base, head_commit: null });
    assert.equal(ev?.headMessage, null);
  });
});

describe("buildAppManifest", () => {
  const manifest = buildAppManifest({
    name: "Sohwe (deploy.example.com)",
    publicUrl: "https://deploy.example.com/",
    webhookPath: "/api/webhooks/github",
    redirectPath: "/api/github/manifest/callback",
    setupPath: "/api/github/setup/callback"
  });

  it("strips the trailing slash from the public URL", () => {
    assert.equal(manifest.url, "https://deploy.example.com");
    assert.deepEqual(manifest.hook_attributes, {
      url: "https://deploy.example.com/api/webhooks/github",
      active: true
    });
    assert.equal(
      manifest.redirect_url,
      "https://deploy.example.com/api/github/manifest/callback"
    );
  });

  it("requests only the permissions the feature needs", () => {
    assert.deepEqual(manifest.default_permissions, {
      contents: "read",
      metadata: "read",
      statuses: "write"
    });
    assert.deepEqual(manifest.default_events, ["push"]);
    assert.equal(manifest.public, false);
  });
});

describe("GitHub URLs", () => {
  it("targets the personal app-creation form by default", () => {
    assert.equal(
      manifestCreateUrl("abc123"),
      "https://github.com/settings/apps/new?state=abc123"
    );
  });

  it("targets an organization's form when given one", () => {
    assert.equal(
      manifestCreateUrl("abc 123", "my org"),
      "https://github.com/organizations/my%20org/settings/apps/new?state=abc%20123"
    );
  });

  it("builds the installation URL", () => {
    assert.equal(
      appInstallUrl("sohwe-deploy"),
      "https://github.com/apps/sohwe-deploy/installations/new"
    );
  });
});
