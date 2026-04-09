export class JobExecutor {
  /**
   * Execute a handler with timeout and structured context.
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

    try {
      const result = await handler(job.data, context);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Create a structured logger that writes to BullMQ job logs.
 */
function createJobLogger(job) {
  const write = (level, message, data) => {
    const entry = data
      ? `[${level.toUpperCase()}] ${message} ${JSON.stringify(data)}`
      : `[${level.toUpperCase()}] ${message}`;
    job.log(entry);
  };

  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data)
  };
}
