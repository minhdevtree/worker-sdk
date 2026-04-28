import {describe, it, expect, vi} from 'vitest';

const queueInstances = [];
let getJobCountsBehavior = () => Promise.resolve({
  waiting: 1, active: 2, delayed: 0, completed: 10, failed: 3, paused: 0
});

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name, opts) {
      this.name = name;
      this.opts = opts;
      this.getJobCounts = vi.fn((...states) => getJobCountsBehavior(states));
      this.close = vi.fn().mockResolvedValue(undefined);
      queueInstances.push(this);
    }
  }
}));

const {getQueueDepths} = await import('../src/admin/getQueueDepths.js');

describe('getQueueDepths', () => {
  it('returns empty object when tiers is empty', async () => {
    const result = await getQueueDepths({}, []);
    expect(result).toEqual({});
  });

  it('returns counts keyed by tier and closes queues', async () => {
    queueInstances.length = 0;
    getJobCountsBehavior = () => Promise.resolve({
      waiting: 1, active: 2, delayed: 0, completed: 10, failed: 3, paused: 0
    });
    const result = await getQueueDepths({}, ['heavy', 'medium']);
    expect(Object.keys(result)).toEqual(['heavy', 'medium']);
    expect(result.heavy.ok).toBe(true);
    expect(result.heavy.waiting).toBe(1);
    expect(result.heavy.total).toBe(3);
    expect(queueInstances).toHaveLength(2);
    expect(queueInstances[0].close).toHaveBeenCalled();
    expect(queueInstances[1].close).toHaveBeenCalled();
  });

  it('total excludes completed and failed', async () => {
    queueInstances.length = 0;
    getJobCountsBehavior = () => Promise.resolve({
      waiting: 1, active: 2, delayed: 0, completed: 100, failed: 50, paused: 0
    });
    const result = await getQueueDepths({}, ['heavy']);
    expect(result.heavy.total).toBe(3);
    expect(result.heavy.completed).toBe(100);
    expect(result.heavy.failed).toBe(50);
  });

  it('reports per-tier failure without losing other tiers, and closes all queues', async () => {
    queueInstances.length = 0;
    let call = 0;
    getJobCountsBehavior = () => {
      call++;
      return call === 1
        ? Promise.reject(new Error('redis down'))
        : Promise.resolve({waiting: 5, active: 0, delayed: 0, completed: 0, failed: 0, paused: 0});
    };
    const result = await getQueueDepths({}, ['heavy', 'medium']);
    expect(result.heavy.ok).toBe(false);
    expect(result.heavy.error).toBe('redis down');
    expect(result.medium.ok).toBe(true);
    expect(result.medium.waiting).toBe(5);
    expect(queueInstances[0].close).toHaveBeenCalled();
    expect(queueInstances[1].close).toHaveBeenCalled();
  });

  it('per-tier timeout marks the slow tier as not ok', async () => {
    queueInstances.length = 0;
    getJobCountsBehavior = () => new Promise(() => {});
    const result = await getQueueDepths({}, ['heavy'], {timeoutMs: 20});
    expect(result.heavy.ok).toBe(false);
    expect(result.heavy.error).toMatch(/timeout after 20ms/);
    expect(queueInstances[0].close).toHaveBeenCalled();
  });
});
