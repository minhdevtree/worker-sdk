import {Queue} from 'bullmq';
import {TierManager} from '../worker/tierManager.js';

export class CronManager {
  constructor(redisOpts) {
    this._redisOpts = redisOpts;
    this._queues = new Map();
  }

  async register(jobs, {leader = false} = {}) {
    const cronJobs = Object.entries(jobs).filter(([, cfg]) => cfg.cron);

    if (cronJobs.length === 0) return;

    if (!leader) {
      console.warn(
        `[worker-sdk] cron.leader=false — skipping registration of ${cronJobs.length} cron job(s). ` +
        `One worker in the pool must set cron.leader=true to register schedules.`
      );
      return;
    }

    for (const [jobName, jobConfig] of cronJobs) {
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
