import {describe, it, expect, vi} from 'vitest';
import {listWorkers} from '../src/admin/listWorkers.js';

describe('listWorkers', () => {
  it('should return empty array when no heartbeat keys exist', async () => {
    const redis = {
      scan: vi.fn().mockResolvedValue(['0', []]),
      mget: vi.fn().mockResolvedValue([])
    };
    const result = await listWorkers(redis);
    expect(result).toEqual([]);
  });

  it('should return parsed WorkerInfo for multiple heartbeat keys', async () => {
    const redis = {
      scan: vi.fn().mockResolvedValue(['0', [
        'worker:heartbeat:mac-mini-1',
        'worker:heartbeat:mac-mini-2'
      ]]),
      mget: vi.fn().mockResolvedValue([
        JSON.stringify({workerId: 'mac-mini-1', hostname: 'mm', pid: 1, tiers: {heavy: 2}, startedAt: 1000, lastBeat: 2000}),
        JSON.stringify({workerId: 'mac-mini-2', hostname: 'mm', pid: 2, tiers: {heavy: 0}, startedAt: 1100, lastBeat: 2100})
      ])
    };
    const result = await listWorkers(redis);
    expect(result).toHaveLength(2);
    expect(result[0].workerId).toBe('mac-mini-1');
    expect(result[1].workerId).toBe('mac-mini-2');
    expect(result[1].tiers).toEqual({heavy: 0});
  });

  it('should skip malformed JSON without throwing', async () => {
    const redis = {
      scan: vi.fn().mockResolvedValue(['0', [
        'worker:heartbeat:good',
        'worker:heartbeat:bad'
      ]]),
      mget: vi.fn().mockResolvedValue([
        JSON.stringify({workerId: 'good', hostname: 'h', pid: 1, tiers: {}, startedAt: 0, lastBeat: 0}),
        'not valid json'
      ])
    };
    const result = await listWorkers(redis);
    expect(result).toHaveLength(1);
    expect(result[0].workerId).toBe('good');
  });

  it('should iterate SCAN cursor across multiple batches', async () => {
    const scanSpy = vi.fn()
      .mockResolvedValueOnce(['5', ['worker:heartbeat:a', 'worker:heartbeat:b']])
      .mockResolvedValueOnce(['0', ['worker:heartbeat:c']]);
    const redis = {
      scan: scanSpy,
      mget: vi.fn().mockResolvedValue([
        JSON.stringify({workerId: 'a', hostname: 'h', pid: 1, tiers: {}, startedAt: 0, lastBeat: 0}),
        JSON.stringify({workerId: 'b', hostname: 'h', pid: 2, tiers: {}, startedAt: 0, lastBeat: 0}),
        JSON.stringify({workerId: 'c', hostname: 'h', pid: 3, tiers: {}, startedAt: 0, lastBeat: 0})
      ])
    };
    const result = await listWorkers(redis);
    expect(scanSpy).toHaveBeenCalledTimes(2);
    expect(scanSpy.mock.calls[0][0]).toBe('0');     // first cursor
    expect(scanSpy.mock.calls[1][0]).toBe('5');     // continued from previous response
    expect(result).toHaveLength(3);
  });

  it('should skip null values (key expired between SCAN and MGET)', async () => {
    const redis = {
      scan: vi.fn().mockResolvedValue(['0', [
        'worker:heartbeat:alive',
        'worker:heartbeat:expired'
      ]]),
      mget: vi.fn().mockResolvedValue([
        JSON.stringify({workerId: 'alive', hostname: 'h', pid: 1, tiers: {}, startedAt: 0, lastBeat: 0}),
        null
      ])
    };
    const result = await listWorkers(redis);
    expect(result).toHaveLength(1);
    expect(result[0].workerId).toBe('alive');
  });

  it('should skip parsed values that are not WorkerInfo-shaped', async () => {
    const redis = {
      scan: vi.fn().mockResolvedValue(['0', [
        'worker:heartbeat:good',
        'worker:heartbeat:wrong-shape',
        'worker:heartbeat:string-value'
      ]]),
      mget: vi.fn().mockResolvedValue([
        JSON.stringify({workerId: 'good', hostname: 'h', pid: 1, tiers: {}, startedAt: 0, lastBeat: 0}),
        JSON.stringify({foo: 'bar'}),       // valid JSON, wrong shape (no workerId)
        JSON.stringify('hello')              // valid JSON, scalar string
      ])
    };
    const result = await listWorkers(redis);
    expect(result).toHaveLength(1);
    expect(result[0].workerId).toBe('good');
  });
});
