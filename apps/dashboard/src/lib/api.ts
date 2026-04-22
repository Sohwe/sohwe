const BASE = import.meta.env.DEV ? "" : (import.meta.env.VITE_API_URL ?? "http://localhost:3001");

function errMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
  ) {
    return (body as { message: string }).message;
  }
  return fallback;
}

/** GET JSON (no Content-Type header). */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errMessage(body, res.statusText));
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function api<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  // Only set JSON content-type when there is a body. Fastify rejects
  // `Content-Type: application/json` with an empty body (e.g. POST /deploy).
  const headers = new Headers(init.headers);
  const hasBody = init.body != null && init.body !== "";
  if (hasBody && !headers.has("Content-Type") && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errMessage(body, res.statusText));
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Returns `null` when the user is not authenticated (401). */
export async function fetchMe<T>(): Promise<T | null> {
  const res = await fetch(`${BASE}/api/me`, { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errMessage(body, res.statusText));
  }
  return (await res.json()) as T;
}
