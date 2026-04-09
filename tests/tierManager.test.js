import {describe, it, expect, vi, beforeEach} from 'vitest';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function(queueName, processor, opts) {
    this.queueName = queueName;
    this.processor = processor;
    this.opts = opts;
    this.closed = false;
    this.close = vi.fn(async () => {});
  })
}));

import {Worker} from 'bullmq';
import {TierManager} from '../src/worker/tierManager.js';

describe('TierManager', () => {
  beforeEach(() => {
    vi.mocked(Worker).mockClear();
  });

  it('should create one BullMQ Worker per tier', () => {
    const concurrency = {heavy: 2, medium: 5, light: 10};
    const redisOpts = {host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null};

    const manager = new TierManager(concurrency, redisOpts, vi.fn());

    expect(Worker).toHaveBeenCalledTimes(3);

    const calls = Worker.mock.calls;
    const queueNames = calls.map(c => c[0]);
    expect(queueNames).toContain('worker:heavy');
    expect(queueNames).toContain('worker:medium');
    expect(queueNames).toContain('worker:light');

    const heavyCall = calls.find(c => c[0] === 'worker:heavy');
    expect(heavyCall[2].concurrency).toBe(2);

    const lightCall = calls.find(c => c[0] === 'worker:light');
    expect(lightCall[2].concurrency).toBe(10);
  });

  it('should return queue name for a given tier', () => {
    expect(TierManager.queueName('heavy')).toBe('worker:heavy');
    expect(TierManager.queueName('medium')).toBe('worker:medium');
    expect(TierManager.queueName('light')).toBe('worker:light');
  });

  it('should close all workers on shutdown', async () => {
    const manager = new TierManager({heavy: 2, medium: 5, light: 10}, {}, vi.fn());

    await manager.closeAll();

    const instances = Worker.mock.results.map(r => r.value);
    for (const w of instances) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }
  });
});
