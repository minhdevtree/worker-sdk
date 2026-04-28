const MAX_BODY_BYTES = 64 * 1024;

/**
 * Probe the Bull Board dashboard `/health` endpoint.
 *
 * The `/health` route is unauthenticated — no credentials needed.
 *
 * Hardening:
 *  - `baseUrl` must parse as a URL with `http:` or `https:` scheme. Other
 *    schemes (file:, gopher:, ...) are rejected to limit SSRF surface.
 *  - Redirects are not followed (`redirect: 'manual'`) so a misbehaving
 *    dashboard cannot bounce the probe to an internal metadata endpoint.
 *  - Response bodies larger than 64 KiB (by Content-Length) are rejected.
 *  - The abort timer covers both the request and the JSON body parse.
 *
 * Caller is still responsible for not exposing `baseUrl` to untrusted input
 * without additional allow-listing.
 *
 * @param {string} baseUrl - Dashboard URL (e.g. 'http://192.168.1.162:3800')
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000]
 * @returns {Promise<{ok: boolean, latencyMs: number, status?: number, uptime?: number, timestamp?: string, error?: string}>}
 */
export async function checkDashboard(baseUrl, {timeoutMs = 3000} = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    return {ok: false, latencyMs: 0, error: 'baseUrl is required'};
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return {ok: false, latencyMs: 0, error: 'invalid baseUrl'};
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {ok: false, latencyMs: 0, error: `unsupported protocol: ${parsed.protocol}`};
  }

  const url = baseUrl.replace(/\/+$/, '') + '/health';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const start = Date.now();
  try {
    const res = await fetch(url, {signal: controller.signal, redirect: 'manual'});
    if (!res.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        status: res.status,
        error: `HTTP ${res.status}`
      };
    }
    const contentLength = Number(res.headers?.get?.('content-length') ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        status: res.status,
        error: `response too large (${contentLength} bytes)`
      };
    }
    const body = await res.json().catch(() => ({}));
    if (body && typeof body.status === 'string' && body.status !== 'ok') {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        status: res.status,
        error: `dashboard status: ${body.status}`
      };
    }
    return {
      ok: true,
      latencyMs: Date.now() - start,
      status: res.status,
      uptime: body.uptime,
      timestamp: body.timestamp
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
    return {ok: false, latencyMs, error: message};
  } finally {
    clearTimeout(timer);
  }
}
