import {describe, it, expect, vi} from 'vitest';
import {ShutdownManager} from '../src/shutdown/shutdownManager.js';

describe('ShutdownManager', () => {
  it('should call all registered shutdown handlers in order', async () => {
    const order = [];
    const manager = new ShutdownManager();

    manager.register('first', async () => { order.push('first'); });
    manager.register('second', async () => { order.push('second'); });
    manager.register('third', async () => { order.push('third'); });

    await manager.shutdown();

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('should continue shutdown even if a handler fails', async () => {
    const order = [];
    const manager = new ShutdownManager();

    manager.register('ok', async () => { order.push('ok'); });
    manager.register('fail', async () => { throw new Error('boom'); });
    manager.register('after', async () => { order.push('after'); });

    await manager.shutdown();

    expect(order).toEqual(['ok', 'after']);
  });

  it('should only run shutdown once even if called multiple times', async () => {
    let count = 0;
    const manager = new ShutdownManager();
    manager.register('counter', async () => { count++; });

    await Promise.all([manager.shutdown(), manager.shutdown()]);

    expect(count).toBe(1);
  });
});
