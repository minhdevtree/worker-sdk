/**
 * Ping Redis and measure round-trip latency.
 *
 * @param {object} redis - ioredis client
 * @param {object} [options]
 * @param {number} [options.timeoutMs=2000] - Reject if PING doesn't return in time
 * @returns {Promise<{ok: boolean, latencyMs: number, error?: string}>}
 */
export async function pingRedis(redis, {timeoutMs = 2000} = {}) {
  const start = Date.now();
  try {
    const result = await withTimeout(redis.ping(), timeoutMs);
    const latencyMs = Date.now() - start;
    if (result !== 'PONG') {
      return {ok: false, latencyMs, error: `unexpected response: ${result}`};
    }
    return {ok: true, latencyMs};
  } catch (err) {
    return {ok: false, latencyMs: Date.now() - start, error: err.message};
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms).unref?.()
    )
  ]);
}
