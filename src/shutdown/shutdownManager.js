export class ShutdownManager {
  constructor() {
    this._handlers = [];
    this._shuttingDown = false;
  }

  register(name, handler) {
    this._handlers.push({name, handler});
  }

  async shutdown() {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

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
      await this.shutdown();
      if (onComplete) onComplete();
    };

    process.on('SIGTERM', () => handle('SIGTERM'));
    process.on('SIGINT', () => handle('SIGINT'));
  }
}
