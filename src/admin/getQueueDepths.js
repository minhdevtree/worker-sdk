import {Queue} from 'bullmq';
import {TierManager} from '../worker/tierManager.js';

/**
 * Get BullMQ queue depths for the given tiers.
 * Returns one entry per tier with counts of jobs in each state.
 *
 * Creates short-lived Queue instances and closes them before returning.
 * If `connection` is an ioredis instance, BullMQ reuses it; the instance is
 * not closed by this helper.
 *
 * @param {object|import('ioredis').Redis} connection - ioredis client OR connection options
 * @param {string[]} tiers - tier names (e.g. ['heavy', 'medium', 'light'])
 * @returns {Promise<Record<string, {waiting, active, delayed, completed, failed, paused, total}>>}
 */
export async function getQueueDepths(connection, tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return {};
  }

  const queues = tiers.map(tier => ({
    tier,
    queue: new Queue(TierManager.queueName(tier), {connection})
  }));

  try {
    const results = await Promise.all(
      queues.map(async ({tier, queue}) => {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'completed',
          'failed',
          'paused'
        );
        const total =
          (counts.waiting || 0) +
          (counts.active || 0) +
          (counts.delayed || 0) +
          (counts.paused || 0);
        return [tier, {...counts, total}];
      })
    );
    return Object.fromEntries(results);
  } finally {
    await Promise.all(queues.map(({queue}) => queue.close().catch(() => {})));
  }
}
