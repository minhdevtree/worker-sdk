import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name, opts) {
      this.name = name;
      this.opts = opts;
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

function mockResponse({ok = true, status = 200, body = {}} = {}) {
  return {
    ok,
    status,
    headers: {get: () => null},
    json: async () => body
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

  it('aggregates redis + workers when tiers/dashboard are omitted, status=healthy', async () => {
    const redis = makeRedis({
      workers: [{workerId: 'w0', hostname: 'h', pid: 1, tiers: {}, startedAt: 0, lastBeat: 0}]
    });
    const result = await getClusterHealth({redis});
    expect(result.ok).toBe(true);
    expect(result.status).toBe('healthy');
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
    expect(result.queues.byTier.heavy.ok).toBe(true);
  });

  it('includes dashboard probe when url is provided', async () => {
    globalThis.fetch.mockResolvedValue(mockResponse({body: {uptime: 10}}));
    const redis = makeRedis();
    const result = await getClusterHealth({redis, dashboardUrl: 'http://host:3800'});
    expect(result.dashboard.ok).toBe(true);
    expect(result.dashboard.uptime).toBe(10);
  });

  it('status=unhealthy when redis ping fails', async () => {
    const redis = makeRedis({pong: 'NOPE'});
    const result = await getClusterHealth({redis});
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.redis.ok).toBe(false);
    expect(result.workers.ok).toBe(true);
  });

  it('status=degraded when workers fail but redis is up', async () => {
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
    expect(result.status).toBe('degraded');
  });

  it('status=degraded when dashboard is unreachable but redis+workers are ok', async () => {
    globalThis.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const redis = makeRedis();
    const result = await getClusterHealth({redis, dashboardUrl: 'http://host:3800'});
    expect(result.redis.ok).toBe(true);
    expect(result.dashboard.ok).toBe(false);
    expect(result.status).toBe('degraded');
  });
});
