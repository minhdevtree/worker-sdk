import {Worker} from 'bullmq';

const QUEUE_PREFIX = 'worker';

export class TierManager {
  constructor(concurrency, redisOpts, processor) {
    this._workers = [];

    for (const [tier, limit] of Object.entries(concurrency)) {
      const queueName = TierManager.queueName(tier);
      const worker = new Worker(queueName, processor, {
        connection: redisOpts,
        concurrency: limit
      });
      worker.on('error', err => {
        console.error(`[worker-sdk] Worker error on ${queueName}:`, err.message);
      });
      this._workers.push(worker);
    }
  }

  static queueName(tier) {
    return `${QUEUE_PREFIX}-${tier}`;
  }

  async closeAll() {
    await Promise.all(this._workers.map(w => w.close()));
  }
}
