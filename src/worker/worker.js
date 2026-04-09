import {Queue} from 'bullmq';
import {loadConfig} from '../config/loader.js';
import {HandlerRegistry} from './handlerRegistry.js';
import {JobExecutor} from './jobExecutor.js';
import {TierManager} from './tierManager.js';
import {CronManager} from '../cron/cronManager.js';
import {createDashboardApp} from '../dashboard/server.js';
import {ShutdownManager} from '../shutdown/shutdownManager.js';

/**
 * Create a worker instance.
 * @param {string} configPath - Path to YAML config file
 * @returns {{register: Function, start: Function, stop: Function}}
 */
export function createWorker(configPath) {
  const config = loadConfig(configPath);
  const registry = new HandlerRegistry();
  const executor = new JobExecutor();
  const shutdown = new ShutdownManager();

  let tierManager;
  let cronManager;
  let dashboardServer;
  let dashboardQueues = [];

  return {
    register(name, handler) {
      registry.register(name, handler);
    },

    async start() {
      // Validate all registered handlers have config
      const unconfigured = registry.names().filter(n => !config.jobs[n]);
      if (unconfigured.length > 0) {
        throw new Error(`Registered handlers not defined in config: ${unconfigured.join(', ')}`);
      }

      // Clean up Redis options — remove empty password
      const cleanRedis = {...config.redis};
      if (!cleanRedis.password) delete cleanRedis.password;
      config.redis = cleanRedis;

      const redisOpts = {...config.redis, maxRetriesPerRequest: null};

      // Job processor — shared across all tier workers
      const processor = async (job) => {
        const handler = registry.get(job.name);
        const jobConfig = config.jobs[job.name] || {};
        const timeout = jobConfig.timeout || 30000;
        return executor.run(handler, job, timeout);
      };

      // Create tier workers
      tierManager = new TierManager(config.concurrency, redisOpts, processor);

      // Create queues for dashboard visibility
      for (const tier of Object.keys(config.concurrency)) {
        const queueName = TierManager.queueName(tier);
        dashboardQueues.push(new Queue(queueName, {connection: config.redis}));
      }

      // Register cron jobs
      cronManager = new CronManager(config.redis);
      await cronManager.register(config.jobs);

      // Start dashboard
      if (config.dashboard?.port) {
        const app = createDashboardApp({
          queues: dashboardQueues,
          auth: config.dashboard.auth
        });

        dashboardServer = app.listen(config.dashboard.port, () => {
          console.info(`[worker-sdk] Dashboard running on port ${config.dashboard.port}`);
        });
      }

      // Register shutdown handlers
      shutdown.register('tierManager', () => tierManager.closeAll());
      shutdown.register('cronManager', () => cronManager.closeAll());
      shutdown.register('dashboardQueues', () =>
        Promise.all(dashboardQueues.map(q => q.close()))
      );
      if (dashboardServer) {
        shutdown.register('dashboard', () =>
          new Promise(resolve => dashboardServer.close(resolve))
        );
      }
      shutdown.installSignalHandlers(() => process.exit(0));

      console.info('[worker-sdk] Worker started');
      console.info(`[worker-sdk] Jobs: ${registry.names().join(', ')}`);
      console.info(`[worker-sdk] Tiers: ${JSON.stringify(config.concurrency)}`);
    },

    async stop() {
      await shutdown.shutdown();
    }
  };
}
