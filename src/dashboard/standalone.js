import {Queue} from 'bullmq';
import {loadConfig} from '../config/loader.js';
import {TierManager} from '../worker/tierManager.js';
import {createDashboardApp} from './server.js';

/**
 * Create a standalone Bull Board dashboard server.
 * Reads Redis + dashboard config from YAML, serves Bull Board on its own port.
 *
 * Usage:
 *   const dashboard = createDashboard('./worker.config.yml');
 *   await dashboard.start();
 *
 * @param {string} configPath - Path to worker YAML config
 * @returns {{start: Function, stop: Function, server: import('http').Server|null}}
 */
export function createDashboard(configPath) {
  const config = loadConfig(configPath);

  if (!config.dashboard || config.dashboard.port === undefined) {
    throw new Error('worker.config.yml: dashboard config is required for standalone dashboard.');
  }

  const redisOpts = {...config.redis, maxRetriesPerRequest: null};

  const queues = Object.keys(config.concurrency).map(tier =>
    new Queue(TierManager.queueName(tier), {connection: redisOpts})
  );

  if (!config.dashboard.auth?.username || !config.dashboard.auth?.password) {
    console.warn('[worker-sdk] WARNING: Standalone dashboard running without authentication!');
  }

  const app = createDashboardApp({
    queues,
    auth: config.dashboard.auth
  });

  const state = {server: null};

  return {
    get server() {
      return state.server;
    },
    async start() {
      return new Promise((resolve, reject) => {
        state.server = app.listen(config.dashboard.port);
        state.server.once('error', async (err) => {
          await Promise.all(queues.map(q => q.close().catch(() => {})));
          reject(err);
        });
        state.server.once('listening', () => {
          const addr = state.server.address();
          console.info(`[worker-sdk] Standalone dashboard running on port ${addr.port}`);
          resolve();
        });
      });
    },
    async stop() {
      if (state.server) {
        await new Promise(resolve => state.server.close(resolve));
        state.server = null;
      }
      await Promise.all(queues.map(q => q.close()));
    }
  };
}
