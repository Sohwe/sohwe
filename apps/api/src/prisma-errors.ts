/**
 * Prisma reports failures in the database's vocabulary: an
 * "Invalid `prisma.application.create()` invocation" preamble, raw column
 * names, constraint names. The dashboard renders `message` straight into a
 * toast, so that text is both unhelpful to the person filling in a form and a
 * needless description of our schema. Every route funnels through
 * `mapPrismaError` in the server's error handler; routes that can say
 * something better (which field, which value) catch the specific case first
 * with `isUniqueViolation`.
 */

/** Known-request errors are all `P` + four digits (`P2002`, `P2025`, ...). */
function prismaCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string" || !/^P\d{4}$/.test(code)) return null;
  return code;
}

/** `organization_id` and `organizationId` are the same field to a caller. */
function normalizeField(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Columns named by a P2002 violation. Postgres reports the mapped column
 * names (`organization_id`), not the Prisma field names.
 */
export function uniqueViolationFields(err: unknown): string[] {
  if (prismaCode(err) !== "P2002") return [];
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (typeof target === "string") return [target];
  if (!Array.isArray(target)) return [];
  return target.filter((t): t is string => typeof t === "string");
}

/**
 * True when `err` is a unique-constraint violation — optionally only when it
 * involves `field`, so a route can be sure which value to complain about.
 */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (prismaCode(err) !== "P2002") return false;
  if (field === undefined) return true;
  const wanted = normalizeField(field);
  return uniqueViolationFields(err).some((f) => normalizeField(f) === wanted);
}

/**
 * Fields worth naming to a caller. Scoping columns (`organization_id`) are
 * dropped: the org is implicit in the session, and telling someone their
 * "organization_id, slug" is taken only confuses the actual problem.
 */
function reportableFields(err: unknown): string[] {
  return uniqueViolationFields(err).filter((f) => !/(^|_)id$/i.test(f));
}

/** An HTTP status and a message safe to show a user, or null to pass through. */
export function mapPrismaError(
  err: unknown
): { statusCode: number; message: string } | null {
  const code = prismaCode(err);
  if (!code) return null;
  switch (code) {
    case "P2002": {
      const fields = reportableFields(err);
      return {
        statusCode: 409,
        message: fields.length
          ? `That ${fields.join(" + ")} is already in use. Choose a different one.`
          : "A record with those values already exists."
      };
    }
    case "P2025":
      return { statusCode: 404, message: "Not found." };
    case "P2003":
      return {
        statusCode: 409,
        message: "That record is still referenced by something else."
      };
    default:
      // Any other Prisma error is ours to fix, not the caller's: log it (the
      // error handler does) and keep the internals out of the response.
      return { statusCode: 500, message: "Database error." };
  }
}
