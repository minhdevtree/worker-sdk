/**
 * Probe the Bull Board dashboard `/health` endpoint.
 *
 * The `/health` route is unauthenticated — no credentials needed.
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

  const url = baseUrl.replace(/\/+$/, '') + '/health';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const start = Date.now();
  try {
    const res = await fetch(url, {signal: controller.signal});
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {ok: false, latencyMs, status: res.status, error: `HTTP ${res.status}`};
    }
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      latencyMs,
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
