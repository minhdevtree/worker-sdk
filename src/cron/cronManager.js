import {Queue} from 'bullmq';
import {TierManager} from '../worker/tierManager.js';

export class CronManager {
  constructor(redisOpts) {
    this._redisOpts = redisOpts;
    this._queues = new Map();
  }

  async register(jobs) {
    for (const [jobName, jobConfig] of Object.entries(jobs)) {
      if (!jobConfig.cron) continue;

      const tier = jobConfig.tier || 'medium';
      const queue = this._getQueue(tier);

      await queue.upsertJobScheduler(
        jobName,
        {pattern: jobConfig.cron},
        {
          name: jobName,
          opts: {
            attempts: jobConfig.retry?.maxAttempts || 1,
            removeOnComplete: {count: 1000},
            removeOnFail: {count: 5000}
          }
        }
      );
    }
  }

  _getQueue(tier) {
    const queueName = TierManager.queueName(tier);
    if (!this._queues.has(queueName)) {
      this._queues.set(queueName, new Queue(queueName, {connection: this._redisOpts}));
    }
    return this._queues.get(queueName);
  }

  async closeAll() {
    await Promise.all(Array.from(this._queues.values()).map(q => q.close()));
  }
}
