import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {checkDashboard} from '../src/admin/checkDashboard.js';

describe('checkDashboard', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns error when baseUrl is missing', async () => {
    const result = await checkDashboard('');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/baseUrl is required/);
  });

  it('returns ok with uptime on 200', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({status: 'ok', uptime: 123, timestamp: '2026-04-20T00:00:00Z'})
    });
    const result = await checkDashboard('http://host:3800');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.uptime).toBe(123);
    expect(result.timestamp).toBe('2026-04-20T00:00:00Z');
  });

  it('strips trailing slashes before appending /health', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({uptime: 1})
    });
    await checkDashboard('http://host:3800///');
    expect(globalThis.fetch.mock.calls[0][0]).toBe('http://host:3800/health');
  });

  it('returns not ok on non-2xx status', async () => {
    globalThis.fetch.mockResolvedValue({ok: false, status: 503, json: async () => ({})});
    const result = await checkDashboard('http://host:3800');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBe('HTTP 503');
  });

  it('returns timeout error when fetch aborts', async () => {
    globalThis.fetch.mockImplementation((_url, {signal}) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
    );
    const result = await checkDashboard('http://host:3800', {timeoutMs: 20});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout after 20ms/);
  });

  it('returns not ok on network error', async () => {
    globalThis.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkDashboard('http://host:3800');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });
});
