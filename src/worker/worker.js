import os from 'os';
import {Queue} from 'bullmq';
import Redis from 'ioredis';
import {loadConfig} from '../config/loader.js';
import {HandlerRegistry} from './handlerRegistry.js';
import {JobExecutor, setFileLogger, setLokiShipper} from './jobExecutor.js';
import {TierManager} from './tierManager.js';
import {CronManager} from '../cron/cronManager.js';
import {ShutdownManager} from '../shutdown/shutdownManager.js';
import {FileLogger} from '../logging/fileLogger.js';
import {LokiShipper} from '../logging/lokiShipper.js';
import {Heartbeat} from './heartbeat.js';

/**
 * Create a worker instance.
 * @param {string} configPath - Path to YAML config file
 * @returns {{register: Function, start: Function, stop: Function}}
 */
export function createWorker(configPath) {
  const config = loadConfig(configPath);
  const workerId = config.worker?.id || `${os.hostname()}-${process.pid}`;
  console.info(`[worker-sdk] Worker ID: ${workerId}`);
  const registry = new HandlerRegistry();
  const executor = new JobExecutor();
  const shutdown = new ShutdownManager();

  let tierManager;
  let cronManager;
  let dashboardQueues = [];

  function register(name, handler) {
    registry.register(name, handler);
  }

  async function start() {
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
        labels: config.logging.loki.labels,
        workerId
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
    await cronManager.register(config.jobs, {leader: config.cron?.leader === true});

    // Dashboard is no longer started by createWorker — run createDashboard separately
    if (config.dashboard?.port) {
      console.warn(
        '[worker-sdk] dashboard.port is set but createWorker no longer runs the dashboard. ' +
        'Use createDashboard("./worker.config.yml") in a separate process/container instead.'
      );
    }

    // Heartbeat — registered first so it shuts down first (signals "dead" within one TTL)
    let heartbeat = null;
    let heartbeatRedis = null;
    if (config.worker?.heartbeat?.enabled !== false) {
      heartbeatRedis = new Redis({
        ...redisOpts,
        lazyConnect: false,
        maxRetriesPerRequest: 3
      });
      try {
        heartbeat = new Heartbeat({
          redis: heartbeatRedis,
          workerId,
          tiers: config.concurrency,
          intervalMs: config.worker.heartbeat.intervalMs,
          ttlMs: config.worker.heartbeat.ttlMs
        });
        await heartbeat.start();
      } catch (err) {
        // Heartbeat constructor or start() failed — clean up the dedicated connection
        // before rethrowing so we don't leak a TCP socket.
        await heartbeatRedis.quit().catch(() => {});
        heartbeatRedis = null;
        heartbeat = null;
        throw err;
      }
      shutdown.register('heartbeat', async () => {
        await heartbeat.stop();
        await heartbeatRedis.quit();
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
    if (lokiShipper) {
      shutdown.register('lokiShipper', () => lokiShipper.stop());
    }
    shutdown.installSignalHandlers(() => process.exit(0));

    console.info('[worker-sdk] Worker started');
    console.info(`[worker-sdk] Jobs: ${registry.names().join(', ')}`);
    console.info(`[worker-sdk] Tiers: ${JSON.stringify(config.concurrency)}`);
  }

  async function stop() {
    await shutdown.shutdown();
  }

  return {
    start,
    stop,
    register,
    workerId
  };
}
