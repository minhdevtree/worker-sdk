import {Queue} from 'bullmq';
import {TierManager} from '../worker/tierManager.js';

/**
 * Get BullMQ queue depths for the given tiers.
 *
 * Returns one entry per tier with `{ok, ...counts, total}`. A failure on one
 * tier does not abort the others — that tier's entry becomes
 * `{ok: false, error}` and the rest still report their counts.
 *
 * Creates short-lived Queue instances and closes them before returning.
 * If `connection` is an ioredis instance, BullMQ reuses it; the instance is
 * not closed by this helper.
 *
 * @param {object|import('ioredis').Redis} connection - ioredis client OR connection options
 * @param {string[]} tiers - tier names (e.g. ['heavy', 'medium', 'light'])
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000] - Per-tier timeout for getJobCounts
 * @returns {Promise<Record<string, {ok: boolean, waiting?, active?, delayed?, completed?, failed?, paused?, total?, error?: string}>>}
 */
export async function getQueueDepths(connection, tiers, {timeoutMs = 5000} = {}) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return {};
  }

  const queues = tiers.map(tier => ({
    tier,
    queue: new Queue(TierManager.queueName(tier), {connection})
  }));

  try {
    const settled = await Promise.allSettled(
      queues.map(async ({queue}) => {
        const counts = await withTimeout(
          queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'completed',
            'failed',
            'paused'
          ),
          timeoutMs
        );
        const total =
          (counts.waiting || 0) +
          (counts.active || 0) +
          (counts.delayed || 0) +
          (counts.paused || 0);
        return {ok: true, ...counts, total};
      })
    );

    const out = {};
    settled.forEach((r, i) => {
      const tier = tiers[i];
      out[tier] = r.status === 'fulfilled'
        ? r.value
        : {ok: false, error: r.reason?.message || String(r.reason)};
    });
    return out;
  } finally {
    await Promise.all(queues.map(({queue}) => queue.close().catch(() => {})));
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
