const BASE = "http://localhost:3001";

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

export async function api<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init
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
