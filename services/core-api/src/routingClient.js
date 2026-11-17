import { config } from './config.js';
import { HttpError } from './errors.js';

// Thin client for the Java routing service with a hard timeout so a slow
// downstream never holds API requests open.
export async function routingGet(path, params, { timeoutMs = 2000 } = {}) {
  const url = new URL(path, config.routingUrl);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new HttpError(503, 'routing service unavailable', { cause: err.name });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : res.status, body.error ?? 'routing service error');
  return body;
}
