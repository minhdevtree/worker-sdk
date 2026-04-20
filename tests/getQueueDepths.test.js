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
    expect(result.heavy.waiting).toBe(1);
    expect(result.heavy.total).toBe(3);
    expect(queueInstances).toHaveLength(2);
    expect(queueInstances[0].close).toHaveBeenCalled();
    expect(queueInstances[1].close).toHaveBeenCalled();
  });

  it('closes queues even if getJobCounts throws', async () => {
    queueInstances.length = 0;
    getJobCountsBehavior = () => Promise.reject(new Error('redis down'));
    await expect(getQueueDepths({}, ['heavy'])).rejects.toThrow('redis down');
    expect(queueInstances[0].close).toHaveBeenCalled();
  });
});
