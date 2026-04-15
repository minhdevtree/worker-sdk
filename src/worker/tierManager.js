import {Worker} from 'bullmq';

const QUEUE_PREFIX = 'worker';

export class TierManager {
  constructor(concurrency, redisOpts, processor) {
    this._workers = [];

    let createdCount = 0;
    for (const [tier, limit] of Object.entries(concurrency)) {
      if (!Number.isInteger(limit)) {
        console.warn(
          `[worker-sdk] TierManager: invalid concurrency for tier "${tier}": ${JSON.stringify(limit)} (expected integer >= 0). Skipping this tier.`
        );
        continue;
      }
      if (limit <= 0) {
        console.warn(`[worker-sdk] Skipping tier: ${tier} (concurrency: ${limit})`);
        continue;
      }
      const queueName = TierManager.queueName(tier);
      const worker = new Worker(queueName, processor, {
        connection: redisOpts,
        concurrency: limit
      });
      worker.on('error', err => {
        console.error(`[worker-sdk] Worker error on ${queueName}:`, err.message);
      });
      this._workers.push(worker);
      createdCount++;
    }

    if (createdCount === 0) {
      const tierCount = Object.keys(concurrency).length;
      if (tierCount === 0) {
        console.warn(
          '[worker-sdk] TierManager: concurrency object is empty — no tier workers created. ' +
          'Set at least one tier (heavy/medium/light) to a positive integer.'
        );
      } else {
        console.warn(
          '[worker-sdk] TierManager: all tiers have concurrency: 0 — this worker will not process any jobs. ' +
          'This is almost certainly a config mistake.'
        );
      }
    }
  }

  static queueName(tier) {
    return `${QUEUE_PREFIX}-${tier}`;
  }

  async closeAll() {
    await Promise.all(this._workers.map(w => w.close()));
  }
}
