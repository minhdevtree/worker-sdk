import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Heartbeat} from '../src/worker/heartbeat.js';

describe('Heartbeat', () => {
  let redis;

  beforeEach(() => {
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1)
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should write initial beat on start with correct key and payload', async () => {
    const hb = new Heartbeat({
      redis,
      workerId: 'w1',
      tiers: {heavy: 2, medium: 5, light: 10},
      intervalMs: 10000,
      ttlMs: 30000
    });

    await hb.start();

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = redis.set.mock.calls[0];
    expect(key).toBe('worker:heartbeat:w1');
    const parsed = JSON.parse(value);
    expect(parsed.workerId).toBe('w1');
    expect(parsed.tiers).toEqual({heavy: 2, medium: 5, light: 10});
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.hostname).toBe('string');
    expect(typeof parsed.startedAt).toBe('number');
    expect(typeof parsed.lastBeat).toBe('number');
    expect(mode).toBe('PX');
    expect(ttl).toBe(30000);

    await hb.stop();
  });

  it('should fire subsequent beats every intervalMs', async () => {
    vi.useFakeTimers();
    const hb = new Heartbeat({
      redis,
      workerId: 'w2',
      tiers: {},
      intervalMs: 5000,
      ttlMs: 15000
    });
    await hb.start();
    expect(redis.set).toHaveBeenCalledTimes(1); // initial

    await vi.advanceTimersByTimeAsync(5000);
    expect(redis.set).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(redis.set).toHaveBeenCalledTimes(3);

    await hb.stop();
  });

  it('should delete key on stop and clear interval', async () => {
    vi.useFakeTimers();
    const hb = new Heartbeat({
      redis,
      workerId: 'w3',
      tiers: {},
      intervalMs: 5000,
      ttlMs: 15000
    });
    await hb.start();
    expect(redis.set).toHaveBeenCalledTimes(1);

    await hb.stop();
    expect(redis.del).toHaveBeenCalledWith('worker:heartbeat:w3');

    // After stop, interval should no longer fire
    await vi.advanceTimersByTimeAsync(20000);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('should be safe to stop before start (no-op)', async () => {
    const hb = new Heartbeat({
      redis,
      workerId: 'w4',
      tiers: {},
      intervalMs: 5000,
      ttlMs: 15000
    });

    await expect(hb.stop()).resolves.not.toThrow();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('should continue beating even if a beat throws', async () => {
    vi.useFakeTimers();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    redis.set.mockRejectedValueOnce(new Error('redis down')).mockResolvedValue('OK');

    const hb = new Heartbeat({
      redis,
      workerId: 'w5',
      tiers: {},
      intervalMs: 5000,
      ttlMs: 15000
    });

    await hb.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(redis.set).toHaveBeenCalledTimes(3);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('beat failed')
    );

    stderrSpy.mockRestore();
    await hb.stop();
  });

  it('should be safe to call stop twice', async () => {
    const hb = new Heartbeat({
      redis,
      workerId: 'w6',
      tiers: {},
      intervalMs: 5000,
      ttlMs: 15000
    });
    await hb.start();
    await hb.stop();
    await expect(hb.stop()).resolves.not.toThrow();
    expect(redis.del).toHaveBeenCalledTimes(1); // second stop is no-op
  });

  it('should reject restart after stop()', async () => {
    const hb = new Heartbeat({
      redis,
      workerId: 'w-restart',
      tiers: {},
      intervalMs: 5000,
      ttlMs: 15000
    });
    await hb.start();
    await hb.stop();
    await expect(hb.start()).rejects.toThrow(/cannot restart/i);
  });

  it('should ignore double start() with a warning', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const hb = new Heartbeat({
      redis,
      workerId: 'w-double',
      tiers: {},
      intervalMs: 5000,
      ttlMs: 15000
    });
    await hb.start();
    await hb.start(); // should warn, not throw, not fire another initial beat

    expect(redis.set).toHaveBeenCalledTimes(1); // still just the first beat
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('called twice')
    );

    stderrSpy.mockRestore();
    await hb.stop();
  });
});
