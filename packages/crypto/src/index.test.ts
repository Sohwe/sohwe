import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  decryptJson,
  decryptToUtf8,
  deriveBundleKey,
  encryptJson,
  encryptUtf8,
  getSohweEncryptionKey,
  hmacSign,
  hmacVerify,
  maskedPreview,
  randomBundleSalt,
  SCRYPT_PARAMS,
  toDockerEnvList
} from "./index";

const KEY = randomBytes(32);

describe("getSohweEncryptionKey", () => {
  function withKey<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.SOHWE_ENCRYPTION_KEY;
    if (value === undefined) delete process.env.SOHWE_ENCRYPTION_KEY;
    else process.env.SOHWE_ENCRYPTION_KEY = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.SOHWE_ENCRYPTION_KEY;
      else process.env.SOHWE_ENCRYPTION_KEY = prev;
    }
  }

  it("throws when unset", () => {
    withKey(undefined, () => {
      assert.throws(() => getSohweEncryptionKey(), /not set or is empty/);
    });
  });

  it("throws when empty or whitespace", () => {
    withKey("   ", () => {
      assert.throws(() => getSohweEncryptionKey(), /not set or is empty/);
    });
  });

  it("throws when the key does not decode to 32 bytes", () => {
    withKey(Buffer.alloc(16).toString("base64"), () => {
      assert.throws(() => getSohweEncryptionKey(), /exactly 32 bytes/);
    });
  });

  it("returns a 32-byte buffer for a valid base64 key", () => {
    const b64 = randomBytes(32).toString("base64");
    withKey(b64, () => {
      const key = getSohweEncryptionKey();
      assert.equal(key.length, 32);
      assert.deepEqual(key, Buffer.from(b64, "base64"));
    });
  });

  it("accepts a 64-char hex key (pre-v0.6.0 installer format)", () => {
    const bytes = randomBytes(32);
    withKey(bytes.toString("hex"), () => {
      const key = getSohweEncryptionKey();
      assert.equal(key.length, 32);
      assert.deepEqual(key, bytes);
    });
  });

  it("decodes hex as hex, not as base64", () => {
    // Hex chars are all valid base64, so a naive base64 decode of a 64-char
    // hex string "succeeds" — at 48 bytes. The hex path must win.
    const hex = "ab".repeat(32);
    withKey(hex, () => {
      assert.deepEqual(getSohweEncryptionKey(), Buffer.from(hex, "hex"));
    });
  });

  it("rejects a 64-char string that is not hex", () => {
    // 64 base64 chars decode to 48 bytes and 'z'/'Z' break the hex regex.
    withKey("z".repeat(64), () => {
      assert.throws(() => getSohweEncryptionKey(), /exactly 32 bytes/);
    });
  });
});

describe("encryptUtf8 / decryptToUtf8", () => {
  it("round-trips arbitrary UTF-8 including multibyte", () => {
    for (const plain of ["", "hello", "sk-secret-123", "emoji 🚀 and ümlaut"]) {
      assert.equal(decryptToUtf8(encryptUtf8(plain, KEY), KEY), plain);
    }
  });

  it("produces a fresh IV each call (non-deterministic ciphertext)", () => {
    const a = encryptUtf8("same", KEY);
    const b = encryptUtf8("same", KEY);
    assert.notDeepEqual(a, b);
    // ...but both decrypt to the same plaintext.
    assert.equal(decryptToUtf8(a, KEY), "same");
    assert.equal(decryptToUtf8(b, KEY), "same");
  });

  it("uses the iv(12)|tag(16)|ciphertext layout", () => {
    const ct = encryptUtf8("x", KEY);
    // 12 + 16 + at least 1 byte of ciphertext for a non-empty plaintext.
    assert.ok(ct.length >= 12 + 16 + 1, `unexpected length ${ct.length}`);
  });

  it("rejects a buffer shorter than iv+tag", () => {
    assert.throws(() => decryptToUtf8(Buffer.alloc(27), KEY), /too short/);
  });

  it("rejects a wrong key (GCM auth failure)", () => {
    const ct = encryptUtf8("secret", KEY);
    assert.throws(() => decryptToUtf8(ct, randomBytes(32)));
  });

  it("rejects tampered ciphertext", () => {
    const ct = encryptUtf8("secret", KEY);
    const tampered = Buffer.from(ct);
    const last = tampered.length - 1;
    tampered[last] = tampered[last]! ^ 0xff; // flip a ciphertext byte
    assert.throws(() => decryptToUtf8(tampered, KEY));
  });

  it("rejects a tampered auth tag", () => {
    const ct = encryptUtf8("secret", KEY);
    const tampered = Buffer.from(ct);
    tampered[12] = tampered[12]! ^ 0xff; // first tag byte
    assert.throws(() => decryptToUtf8(tampered, KEY));
  });
});

describe("encryptJson / decryptJson", () => {
  it("round-trips a string map", () => {
    const obj = { API_KEY: "sk-1", DEBUG: "false", EMPTY: "" };
    assert.deepEqual(decryptJson(encryptJson(obj, KEY), KEY), obj);
  });

  it("rejects a JSON array payload", () => {
    const ct = encryptUtf8(JSON.stringify(["a", "b"]), KEY);
    assert.throws(() => decryptJson(ct, KEY), /must be a JSON object/);
  });

  it("rejects a JSON null payload", () => {
    const ct = encryptUtf8("null", KEY);
    assert.throws(() => decryptJson(ct, KEY), /must be a JSON object/);
  });

  it("rejects non-string values", () => {
    const ct = encryptUtf8(JSON.stringify({ PORT: 3000 }), KEY);
    assert.throws(() => decryptJson(ct, KEY), /must be a string/);
  });
});

describe("maskedPreview", () => {
  it("returns a dash for empty input", () => {
    assert.equal(maskedPreview(""), "—");
  });

  it("fully masks short values", () => {
    assert.equal(maskedPreview("short"), "••••");
    assert.equal(maskedPreview("12345678"), "••••"); // exactly head+tail
  });

  it("shows head and tail for long values", () => {
    assert.equal(maskedPreview("sk_live_abcd1234"), "sk_l•••1234");
  });

  it("never reveals the middle of a long secret", () => {
    const secret = "supersecretvalue";
    const masked = maskedPreview(secret);
    assert.ok(!masked.includes("secret"));
  });
});

describe("toDockerEnvList", () => {
  it("formats name=value entries", () => {
    assert.deepEqual(toDockerEnvList({ A: "1", B: "two" }), ["A=1", "B=two"]);
  });

  it("preserves = and empty values", () => {
    assert.deepEqual(toDockerEnvList({ URL: "a=b", EMPTY: "" }), [
      "URL=a=b",
      "EMPTY="
    ]);
  });
});

describe("deriveBundleKey", () => {
  const salt = randomBundleSalt();

  it("is deterministic for the same passphrase and salt", () => {
    assert.deepEqual(
      deriveBundleKey("passphrase", salt),
      deriveBundleKey("passphrase", salt)
    );
  });

  it("returns a 32-byte key", () => {
    assert.equal(deriveBundleKey("passphrase", salt).length, 32);
  });

  it("differs for a different salt", () => {
    assert.notDeepEqual(
      deriveBundleKey("passphrase", salt),
      deriveBundleKey("passphrase", randomBundleSalt())
    );
  });

  it("differs for a different passphrase", () => {
    assert.notDeepEqual(
      deriveBundleKey("passphrase", salt),
      deriveBundleKey("different", salt)
    );
  });

  it("throws on an empty passphrase", () => {
    assert.throws(() => deriveBundleKey("", salt), /Passphrase is required/);
  });

  it("uses the documented scrypt parameters", () => {
    assert.deepEqual(SCRYPT_PARAMS, { N: 16384, r: 8, p: 1 });
  });
});

describe("hmacSign / hmacVerify", () => {
  const key = randomBytes(32);

  it("verifies a matching signature", () => {
    const sig = hmacSign(key, "payload");
    assert.equal(hmacVerify(key, "payload", sig), true);
  });

  it("rejects altered data", () => {
    const sig = hmacSign(key, "payload");
    assert.equal(hmacVerify(key, "payload-x", sig), false);
  });

  it("rejects a different key", () => {
    const sig = hmacSign(key, "payload");
    assert.equal(hmacVerify(randomBytes(32), "payload", sig), false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    assert.equal(hmacVerify(key, "payload", Buffer.alloc(8)), false);
  });
});

describe("randomBundleSalt", () => {
  it("returns 16 random bytes that differ between calls", () => {
    const a = randomBundleSalt();
    const b = randomBundleSalt();
    assert.equal(a.length, 16);
    assert.equal(b.length, 16);
    assert.notDeepEqual(a, b);
  });
});
