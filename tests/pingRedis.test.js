import {describe, it, expect, vi} from 'vitest';
import {pingRedis} from '../src/admin/pingRedis.js';

describe('pingRedis', () => {
  it('returns ok on PONG', async () => {
    const redis = {ping: vi.fn().mockResolvedValue('PONG')};
    const result = await pingRedis(redis);
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns not ok on unexpected response', async () => {
    const redis = {ping: vi.fn().mockResolvedValue('SOMETHING_ELSE')};
    const result = await pingRedis(redis);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unexpected response/);
  });

  it('returns not ok when ping throws', async () => {
    const redis = {ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))};
    const result = await pingRedis(redis);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('times out if ping hangs', async () => {
    const redis = {ping: vi.fn().mockReturnValue(new Promise(() => {}))};
    const result = await pingRedis(redis, {timeoutMs: 20});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout after 20ms/);
  });

  it('returns clear error when redis client is missing', async () => {
    const result = await pingRedis(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redis client is required/);
  });
});
