import {Queue} from 'bullmq';
import {randomUUID} from 'crypto';
import {loadConfig} from '../config/loader.js';
import {TierManager} from '../worker/tierManager.js';

/**
 * Create a lightweight job-pushing client.
 * Reads YAML config for job-to-tier mapping. Lazily creates BullMQ queues.
 *
 * @param {string} configPath - Path to worker YAML config
 * @returns {{add: Function, close: Function}}
 */
export function createClient(configPath) {
  const config = loadConfig(configPath);
  const queues = new Map();

  function getQueue(tier) {
    const queueName = TierManager.queueName(tier);
    if (!queues.has(queueName)) {
      queues.set(queueName, new Queue(queueName, {connection: config.redis}));
    }
    return queues.get(queueName);
  }

  return {
    async add(jobName, payload) {
      const jobConfig = config.jobs[jobName];
      if (!jobConfig) {
        throw new Error(`Unknown job: ${jobName}. Define it in your worker config.`);
      }

      const queue = getQueue(jobConfig.tier || 'medium');
      const opts = buildJobOpts(jobConfig);
      opts.jobId = `${jobName}-${randomUUID()}`;

      return queue.add(jobName, payload, opts);
    },

    async close() {
      await Promise.all(Array.from(queues.values()).map(q => q.close()));
    }
  };
}

function buildJobOpts(jobConfig) {
  const opts = {
    attempts: jobConfig.retry?.maxAttempts || 1,
    removeOnComplete: {count: 1000},
    removeOnFail: {count: 5000}
  };

  if (jobConfig.retry?.baseDelay) {
    opts.backoff = {
      type: 'exponential',
      delay: jobConfig.retry.baseDelay
    };
  }

  return opts;
}
