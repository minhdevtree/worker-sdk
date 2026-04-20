import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name) {
      this.name = name;
      this.getJobCounts = vi.fn().mockResolvedValue({
        waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, paused: 0
      });
      this.close = vi.fn().mockResolvedValue(undefined);
    }
  }
}));

const {getClusterHealth} = await import('../src/admin/getClusterHealth.js');

function makeRedis({pong = 'PONG', workers = []} = {}) {
  return {
    ping: vi.fn().mockResolvedValue(pong),
    scan: vi.fn().mockResolvedValue(['0', workers.map((_, i) => `worker:heartbeat:w${i}`)]),
    mget: vi.fn().mockResolvedValue(workers.map(w => JSON.stringify(w)))
  };
}

describe('getClusterHealth', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when redis is missing', async () => {
    await expect(getClusterHealth({})).rejects.toThrow(/redis.*required/);
  });

  it('aggregates redis + workers when tiers/dashboard are omitted', async () => {
    const redis = makeRedis({
      workers: [{workerId: 'w0', hostname: 'h', pid: 1, tiers: {}, startedAt: 0, lastBeat: 0}]
    });
    const result = await getClusterHealth({redis});
    expect(result.ok).toBe(true);
    expect(result.redis.ok).toBe(true);
    expect(result.workers.count).toBe(1);
    expect(result.queues).toBeUndefined();
    expect(result.dashboard).toBeUndefined();
    expect(typeof result.checkedAt).toBe('string');
  });

  it('includes queue depths when tiers are provided', async () => {
    const redis = makeRedis();
    const result = await getClusterHealth({redis, tiers: ['heavy']});
    expect(result.queues.ok).toBe(true);
    expect(result.queues.byTier.heavy).toBeDefined();
  });

  it('includes dashboard probe when url is provided', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({uptime: 10})
    });
    const redis = makeRedis();
    const result = await getClusterHealth({redis, dashboardUrl: 'http://host:3800'});
    expect(result.dashboard.ok).toBe(true);
    expect(result.dashboard.uptime).toBe(10);
  });

  it('top-level ok=false if any section fails', async () => {
    const redis = makeRedis({pong: 'NOPE'});
    const result = await getClusterHealth({redis});
    expect(result.ok).toBe(false);
    expect(result.redis.ok).toBe(false);
    expect(result.workers.ok).toBe(true);
  });

  it('continues when one section errors (workers failure does not block redis)', async () => {
    const redis = {
      ping: vi.fn().mockResolvedValue('PONG'),
      scan: vi.fn().mockRejectedValue(new Error('scan down')),
      mget: vi.fn()
    };
    const result = await getClusterHealth({redis});
    expect(result.redis.ok).toBe(true);
    expect(result.workers.ok).toBe(false);
    expect(result.workers.error).toBe('scan down');
    expect(result.ok).toBe(false);
  });
});
