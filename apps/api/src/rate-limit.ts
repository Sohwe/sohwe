/**
 * Per-route opt-in throttle for unauthenticated, internet-facing credential
 * endpoints (login, setup unlock, invitation lookup/accept). `@fastify/rate-limit`
 * is registered with `global: false`, so only routes that set this in their
 * `config` are limited — a blanket limit would break the dashboard's metrics
 * polling and long-lived SSE streams.
 */
export const AUTH_RATE_LIMIT = {
  rateLimit: { max: 10, timeWindow: "1 minute" }
} as const;
