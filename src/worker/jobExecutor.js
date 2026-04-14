import {AsyncLocalStorage} from 'node:async_hooks';

const jobStorage = new AsyncLocalStorage();
let consolePatched = false;
let fileLogger = null;

/**
 * Set the file logger instance. Called by createWorker after loading config.
 * @param {import('../logging/fileLogger.js').FileLogger|null} logger
 */
export function setFileLogger(logger) {
  fileLogger = logger;
}

/**
 * Write to the file logger if configured.
 */
function writeToFile(entry) {
  if (fileLogger) {
    fileLogger.write(entry);
  }
}

/**
 * Patch console once at module load to route logs to the active job (if any).
 * Uses AsyncLocalStorage so each concurrent job gets its own context — no race conditions.
 */
function patchConsoleOnce() {
  if (consolePatched) return;
  consolePatched = true;

  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  const capture = (originalFn, level) => {
    return (...args) => {
      originalFn.apply(console, args);

      const store = jobStorage.getStore();
      if (store) {
        const message = args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ');
        store.job.log(`[${level}] ${message}`).catch(() => {});
        writeToFile({job: store.jobName, id: store.jobId, level, msg: message});
      }
    };
  };

  console.log = capture(originalLog, 'LOG');
  console.info = capture(originalInfo, 'INFO');
  console.warn = capture(originalWarn, 'WARN');
  console.error = capture(originalError, 'ERROR');
}

export class JobExecutor {
  constructor() {
    patchConsoleOnce();
  }

  /**
   * Execute a handler with timeout and structured context.
   * Console output is automatically captured to the job's BullMQ logs
   * and file logs via AsyncLocalStorage (concurrency-safe).
   *
   * @param {Function} handler - async function(payload, context)
   * @param {import('bullmq').Job} job - BullMQ job instance
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<*>} Handler result
   */
  async run(handler, job, timeoutMs) {
    const ac = new AbortController();
    let timer;

    if (timeoutMs > 0) {
      timer = setTimeout(() => ac.abort(), timeoutMs);
    }

    const logger = createJobLogger(job);

    const context = {
      jobId: job.id,
      attempt: job.attemptsMade + 1,
      signal: ac.signal,
      logger
    };

    // Store both the BullMQ job (for job.log) and metadata (for file logging)
    const store = {job, jobName: job.name, jobId: job.id};

    try {
      const result = await jobStorage.run(store, () => handler(job.data, context));
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Create a structured logger that writes to BullMQ job logs + terminal + file.
 */
function createJobLogger(job) {
  const prefix = `[${job.name}:${job.id}]`;

  const write = (level, message, data) => {
    const entry = data
      ? `[${level.toUpperCase()}] ${message} ${JSON.stringify(data)}`
      : `[${level.toUpperCase()}] ${message}`;

    // Write to Redis (visible in Bull Board)
    job.log(entry).catch(() => {});

    // Write to terminal
    const output = `${prefix} ${entry}\n`;
    if (level === 'error') {
      process.stderr.write(output);
    } else {
      process.stdout.write(output);
    }

    // Write to file log
    writeToFile({
      job: job.name,
      id: job.id,
      level: level.toUpperCase(),
      msg: message,
      data
    });
  };

  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data)
  };
}
