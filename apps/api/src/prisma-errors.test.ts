import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUniqueViolation,
  mapPrismaError,
  uniqueViolationFields
} from "./prisma-errors";

/** Shape Prisma throws for a Postgres unique-constraint violation. */
function p2002(target: unknown): unknown {
  return Object.assign(
    new Error(
      "Invalid `prisma.application.create()` invocation:\n\nUnique constraint failed on the fields: (`organization_id`,`slug`)"
    ),
    { code: "P2002", meta: { target } }
  );
}

describe("prisma error mapping", () => {
  it("ignores non-Prisma errors so they keep their own handling", () => {
    assert.equal(mapPrismaError(new Error("boom")), null);
    assert.equal(mapPrismaError({ code: "ECONNREFUSED" }), null);
    assert.equal(mapPrismaError(null), null);
    assert.equal(isUniqueViolation(new Error("boom")), false);
  });

  it("reads the violated columns off a P2002", () => {
    assert.deepEqual(uniqueViolationFields(p2002(["organization_id", "slug"])), [
      "organization_id",
      "slug"
    ]);
    // Some connectors report a single constraint name instead of an array.
    assert.deepEqual(uniqueViolationFields(p2002("slug")), ["slug"]);
    assert.deepEqual(uniqueViolationFields(p2002(undefined)), []);
  });

  it("matches a field across snake_case and camelCase spellings", () => {
    const err = p2002(["organization_id", "slug"]);
    assert.equal(isUniqueViolation(err, "slug"), true);
    assert.equal(isUniqueViolation(err, "organizationId"), true);
    assert.equal(isUniqueViolation(err, "domain"), false);
    // No field named: any unique violation counts.
    assert.equal(isUniqueViolation(err), true);
  });

  it("turns a conflict into a 409 that names only the meaningful column", () => {
    const mapped = mapPrismaError(p2002(["organization_id", "slug"]));
    assert.equal(mapped?.statusCode, 409);
    assert.match(mapped!.message, /slug/);
    // Scoping columns are noise to the caller, and so is Prisma's own prose.
    assert.doesNotMatch(mapped!.message, /organization_id/);
    assert.doesNotMatch(mapped!.message, /prisma/i);
  });

  it("falls back to a generic message when no column is reportable", () => {
    const mapped = mapPrismaError(p2002(["organization_id"]));
    assert.equal(mapped?.statusCode, 409);
    assert.match(mapped!.message, /already exists/);
  });

  it("maps missing rows to 404 and anything else to an opaque 500", () => {
    assert.deepEqual(mapPrismaError({ code: "P2025" }), {
      statusCode: 404,
      message: "Not found."
    });
    const other = mapPrismaError(
      Object.assign(new Error("raw connection string in here"), { code: "P1001" })
    );
    assert.equal(other?.statusCode, 500);
    assert.equal(other?.message, "Database error.");
  });
});
