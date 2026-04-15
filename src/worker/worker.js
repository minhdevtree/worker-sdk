import {Queue} from 'bullmq';
import {loadConfig} from '../config/loader.js';
import {HandlerRegistry} from './handlerRegistry.js';
import {JobExecutor, setFileLogger, setLokiShipper} from './jobExecutor.js';
import {TierManager} from './tierManager.js';
import {CronManager} from '../cron/cronManager.js';
import {createDashboardApp} from '../dashboard/server.js';
import {ShutdownManager} from '../shutdown/shutdownManager.js';
import {FileLogger} from '../logging/fileLogger.js';
import {LokiShipper} from '../logging/lokiShipper.js';

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

      // Set up file logging if configured
      if (config.logging?.dir) {
        const fl = new FileLogger({
          dir: config.logging.dir,
          retentionDays: config.logging.retentionDays || 30
        });
        setFileLogger(fl);

        // Clean up old log files on startup
        fl.cleanup();

        console.info(`[worker-sdk] File logging enabled: ${config.logging.dir} (retention: ${config.logging.retentionDays || 30} days)`);
      }

      // Set up Loki log shipping if configured
      let lokiShipper = null;
      if (config.logging?.loki?.url) {
        lokiShipper = new LokiShipper({
          url: config.logging.loki.url,
          batchSize: config.logging.loki.batchSize,
          flushInterval: config.logging.loki.flushInterval,
          labels: config.logging.loki.labels
        });
        setLokiShipper(lokiShipper);
        console.info(`[worker-sdk] Loki shipping enabled: ${config.logging.loki.url}`);
      }

      // Shared Redis opts for all BullMQ instances (workers, queues, cron)
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

      // Create queues for dashboard visibility (same redisOpts for consistency)
      for (const tier of Object.keys(config.concurrency)) {
        const queueName = TierManager.queueName(tier);
        dashboardQueues.push(new Queue(queueName, {connection: redisOpts}));
      }

      // Register cron jobs (same redisOpts)
      cronManager = new CronManager(redisOpts);
      await cronManager.register(config.jobs);

      // Start dashboard
      if (config.dashboard?.port) {
        if (!config.dashboard.auth?.username || !config.dashboard.auth?.password) {
          console.warn('[worker-sdk] WARNING: Dashboard running without authentication!');
        }

        const app = createDashboardApp({
          queues: dashboardQueues,
          auth: config.dashboard.auth
        });

        dashboardServer = app.listen(config.dashboard.port, () => {
          console.info(`[worker-sdk] Dashboard running on port ${config.dashboard.port}`);
        });
      }

      // Register shutdown handlers (executed in FIFO registration order).
      // Loki shipper must be registered LAST so it flushes AFTER workers drain —
      // in-flight jobs can still push logs while BullMQ workers are closing.
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
      if (lokiShipper) {
        shutdown.register('lokiShipper', () => lokiShipper.stop());
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
