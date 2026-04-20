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
 * @param {object} params
 * @param {import('ioredis').Redis} params.redis - ioredis client (used for PING + listWorkers)
 * @param {object|import('ioredis').Redis} [params.connection] - Passed to BullMQ Queue. Defaults to `redis`.
 * @param {string[]} [params.tiers] - Tier names to probe (e.g. ['heavy','medium','light']). Omit to skip queue depths.
 * @param {string} [params.dashboardUrl] - Base URL (e.g. 'http://host:3800'). Omit to skip dashboard probe.
 * @param {object} [params.timeouts] - Per-probe timeouts in ms
 * @param {number} [params.timeouts.redisMs=2000]
 * @param {number} [params.timeouts.dashboardMs=3000]
 * @returns {Promise<{
 *   ok: boolean,
 *   checkedAt: string,
 *   redis: object,
 *   workers: {ok: boolean, count: number, items: Array},
 *   queues?: object,
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

  const {redisMs = 2000, dashboardMs = 3000} = timeouts;
  const queueConnection = connection || redis;

  const [redisResult, workersResult, queuesResult, dashboardResult] = await Promise.all([
    pingRedis(redis, {timeoutMs: redisMs}),
    safeRun(() => listWorkers(redis)),
    tiers && tiers.length > 0 ? safeRun(() => getQueueDepths(queueConnection, tiers)) : null,
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
    sections.queues = queuesResult.ok
      ? {ok: true, byTier: queuesResult.value}
      : {ok: false, error: queuesResult.error};
  }

  if (dashboardResult) {
    sections.dashboard = dashboardResult;
  }

  sections.ok =
    sections.redis.ok &&
    sections.workers.ok &&
    (sections.queues?.ok ?? true) &&
    (sections.dashboard?.ok ?? true);

  return sections;
}

async function safeRun(fn) {
  try {
    return {ok: true, value: await fn()};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}
