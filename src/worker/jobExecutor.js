export class JobExecutor {
  /**
   * Execute a handler with timeout and structured context.
   * Intercepts console.log/warn/error during execution and pipes to job.log().
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

    // Intercept console output during job execution
    const restore = interceptConsole(job);

    try {
      const result = await handler(job.data, context);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      restore();
    }
  }
}

/**
 * Intercept console.log/warn/error and pipe to job.log() + original console.
 * Returns a restore function to undo the interception.
 */
function interceptConsole(job) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;

  const capture = (originalFn, level) => {
    return (...args) => {
      // Write to terminal (original behavior)
      originalFn.apply(console, args);

      // Write to Redis (visible in Bull Board)
      const message = args
        .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      job.log(`[${level}] ${message}`);
    };
  };

  console.log = capture(originalLog, 'LOG');
  console.info = capture(originalInfo, 'INFO');
  console.warn = capture(originalWarn, 'WARN');
  console.error = capture(originalError, 'ERROR');

  return () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

/**
 * Create a structured logger that writes to BullMQ job logs + terminal.
 */
function createJobLogger(job) {
  const prefix = `[${job.name}:${job.id}]`;

  const write = (level, message, data) => {
    const entry = data
      ? `[${level.toUpperCase()}] ${message} ${JSON.stringify(data)}`
      : `[${level.toUpperCase()}] ${message}`;

    // Write to Redis (visible in Bull Board)
    job.log(entry);

    // Write to terminal (uses original console, not intercepted)
    const consoleFn = level === 'error' ? console.error : console.info;
    consoleFn(`${prefix} ${entry}`);
  };

  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data)
  };
}
