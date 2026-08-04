/**
 * Minimal JSON fetch helper for the app's own API routes. Returns the parsed body when the
 * response is ok, null on any failure (network error, non-ok status, unparseable body) — the
 * two shapes every hook in this app already falls back to via `catch {}` + `if (res.ok)`, so
 * swapping it in is behavior-preserving. Callers that need the raw response (SSE streams,
 * POST bodies with custom error handling) should keep using fetch directly.
 */
export async function apiFetchJson<T = any>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(path, init);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
