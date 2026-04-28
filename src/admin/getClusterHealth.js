import {listWorkers} from './listWorkers.js';
import {pingRedis} from './pingRedis.js';
import {getQueueDepths} from './getQueueDepths.js';
import {checkDashboard} from './checkDashboard.js';

/**
 * Aggregate cluster health: Redis, workers, queue depths, (optional) dashboard.
 *
 * All probes run in parallel. A failure in one probe does not short-circuit
 * the others — each section reports its own `ok` flag. The top-level `ok` is
 * true only when every probed section is ok.
 *
 * `status` classifies the rollup:
 *   - `'healthy'`   — every probed section ok
 *   - `'unhealthy'` — Redis is down (the critical dependency)
 *   - `'degraded'`  — Redis ok, but at least one other section failed
 *
 * Throws only on programmer error (missing `redis`); never on transient failures.
 *
 * @param {object} params
 * @param {import('ioredis').Redis} params.redis - ioredis client (used for PING + listWorkers)
 * @param {object|import('ioredis').Redis} [params.connection] - Passed to BullMQ Queue. Defaults to `redis`.
 * @param {string[]} [params.tiers] - Tier names to probe (e.g. ['heavy','medium','light']). Omit to skip queue depths.
 * @param {string} [params.dashboardUrl] - Base URL (e.g. 'http://host:3800'). Omit to skip dashboard probe.
 * @param {object} [params.timeouts] - Per-probe timeouts in ms
 * @param {number} [params.timeouts.redisMs=2000]
 * @param {number} [params.timeouts.dashboardMs=3000]
 * @param {number} [params.timeouts.queuesMs=5000]
 * @param {number} [params.timeouts.workersMs=5000]
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'healthy' | 'degraded' | 'unhealthy',
 *   checkedAt: string,
 *   redis: object,
 *   workers: {ok: boolean, count: number, items: Array, error?: string},
 *   queues?: {ok: boolean, byTier?: object, error?: string},
 *   dashboard?: object
 * }>}
 */
export async function getClusterHealth({
  redis,
  connection,
  tiers,
  dashboardUrl,
  timeouts = {}
}) {
  if (!redis) {
    throw new Error('getClusterHealth: `redis` is required');
  }

  const {
    redisMs = 2000,
    dashboardMs = 3000,
    queuesMs = 5000,
    workersMs = 5000
  } = timeouts;
  const queueConnection = connection || redis;

  const [redisResult, workersResult, queuesResult, dashboardResult] = await Promise.all([
    pingRedis(redis, {timeoutMs: redisMs}),
    safeRunWithTimeout(() => listWorkers(redis), workersMs),
    tiers && tiers.length > 0
      ? safeRunWithTimeout(() => getQueueDepths(queueConnection, tiers, {timeoutMs: queuesMs}), queuesMs)
      : null,
    dashboardUrl ? checkDashboard(dashboardUrl, {timeoutMs: dashboardMs}) : null
  ]);

  const workers = workersResult.ok
    ? {ok: true, count: workersResult.value.length, items: workersResult.value}
    : {ok: false, count: 0, items: [], error: workersResult.error};

  const sections = {
    checkedAt: new Date().toISOString(),
    redis: redisResult,
    workers
  };

  if (queuesResult) {
    if (!queuesResult.ok) {
      sections.queues = {ok: false, error: queuesResult.error};
    } else {
      const byTier = queuesResult.value;
      const allTiersOk = Object.values(byTier).every(t => t.ok !== false);
      sections.queues = {ok: allTiersOk, byTier};
    }
  }

  if (dashboardResult) {
    sections.dashboard = dashboardResult;
  }

  sections.ok =
    sections.redis.ok &&
    sections.workers.ok &&
    (sections.queues?.ok ?? true) &&
    (sections.dashboard?.ok ?? true);

  sections.status = sections.ok
    ? 'healthy'
    : !sections.redis.ok
      ? 'unhealthy'
      : 'degraded';

  return sections;
}

async function safeRunWithTimeout(fn, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
    return {ok: true, value: result};
  } catch (err) {
    return {ok: false, error: err.message};
  } finally {
    clearTimeout(timer);
  }
}
