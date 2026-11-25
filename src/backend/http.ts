import type { z } from 'zod';

/** Abort a backend HTTP request that hangs, so a stuck backend never stalls the agent forever. */
export const HTTP_TIMEOUT_MS = 30_000;

/** Cap the echoed error body so a large/hostile response can't flood the agent's context. */
const MAX_ERROR_BODY = 500;

/** Read the response body as text for an error message, tolerant of a non-text/consumed body. */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text;
  } catch {
    return '';
  }
}

/** POST JSON to `url` and validate the response against `schema`. */
export async function postJson<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Include the body — a 400 from /auth/verify carries the reason the agent needs to debug.
    const detail = await readErrorBody(response);
    throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`POST ${url} returned an unexpected response shape: ${issues}`);
  }
  return parsed.data;
}
