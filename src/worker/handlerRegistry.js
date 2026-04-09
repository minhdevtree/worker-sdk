export class HandlerRegistry {
  constructor() {
    this._handlers = new Map();
  }

  /**
   * Register a handler function for a job name.
   * @param {string} name - Job name
   * @param {Function} handler - async function(payload, context)
   */
  register(name, handler) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }
    this._handlers.set(name, handler);
  }

  /**
   * Get handler by job name. Throws if not found.
   * @param {string} name
   * @returns {Function}
   */
  get(name) {
    const handler = this._handlers.get(name);
    if (!handler) {
      throw new Error(`No handler registered for job: ${name}`);
    }
    return handler;
  }

  /**
   * Check if a handler is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._handlers.has(name);
  }

  /**
   * List all registered job names.
   * @returns {string[]}
   */
  names() {
    return Array.from(this._handlers.keys());
  }
}
