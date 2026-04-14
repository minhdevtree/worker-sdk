const FORCE_EXIT_TIMEOUT_MS = 30000;

export class ShutdownManager {
  constructor() {
    this._handlers = [];
    this._shutdownPromise = null;
  }

  register(name, handler) {
    this._handlers.push({name, handler});
  }

  /**
   * Execute all shutdown handlers in registration order.
   * Returns the same promise if called multiple times (idempotent).
   */
  async shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shutdownPromise = this._runHandlers();
    return this._shutdownPromise;
  }

  async _runHandlers() {
    for (const {name, handler} of this._handlers) {
      try {
        await handler();
      } catch (err) {
        console.error(`[shutdown] Error in "${name}":`, err.message);
      }
    }
  }

  installSignalHandlers(onComplete) {
    const handle = async (signal) => {
      console.info(`[shutdown] Received ${signal}, shutting down...`);

      const forceTimer = setTimeout(() => {
        console.error(`[shutdown] Force exit after ${FORCE_EXIT_TIMEOUT_MS}ms timeout`);
        process.exit(1);
      }, FORCE_EXIT_TIMEOUT_MS);
      forceTimer.unref();

      await this.shutdown();
      if (onComplete) onComplete();
    };

    process.on('SIGTERM', () => handle('SIGTERM'));
    process.on('SIGINT', () => handle('SIGINT'));
  }
}
