import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {checkDashboard} from '../src/admin/checkDashboard.js';

function mockResponse({ok = true, status = 200, body = {}, contentLength = null} = {}) {
  return {
    ok,
    status,
    headers: {get: name => (name === 'content-length' ? contentLength : null)},
    json: async () => body
  };
}

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

  it('rejects malformed URLs', async () => {
    const result = await checkDashboard('not a url');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid baseUrl/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) protocols (SSRF guard)', async () => {
    const result = await checkDashboard('file:///etc/passwd');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsupported protocol/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns ok with uptime on 200', async () => {
    globalThis.fetch.mockResolvedValue(mockResponse({
      body: {status: 'ok', uptime: 123, timestamp: '2026-04-20T00:00:00Z'}
    }));
    const result = await checkDashboard('http://host:3800');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.uptime).toBe(123);
    expect(result.timestamp).toBe('2026-04-20T00:00:00Z');
  });

  it('passes redirect: manual to fetch', async () => {
    globalThis.fetch.mockResolvedValue(mockResponse({body: {uptime: 1}}));
    await checkDashboard('http://host:3800');
    expect(globalThis.fetch.mock.calls[0][1].redirect).toBe('manual');
  });

  it('strips trailing slashes before appending /health', async () => {
    globalThis.fetch.mockResolvedValue(mockResponse({body: {uptime: 1}}));
    await checkDashboard('http://host:3800///');
    expect(globalThis.fetch.mock.calls[0][0]).toBe('http://host:3800/health');
  });

  it('appends /health to subpath baseUrls (caller-supplied path is preserved)', async () => {
    globalThis.fetch.mockResolvedValue(mockResponse({body: {uptime: 1}}));
    await checkDashboard('http://host:3800/dashboard');
    expect(globalThis.fetch.mock.calls[0][0]).toBe('http://host:3800/dashboard/health');
  });

  it('returns not ok on non-2xx status', async () => {
    globalThis.fetch.mockResolvedValue(mockResponse({ok: false, status: 503}));
    const result = await checkDashboard('http://host:3800');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBe('HTTP 503');
  });

  it('rejects oversize responses by Content-Length', async () => {
    globalThis.fetch.mockResolvedValue(mockResponse({
      contentLength: String(10 * 1024 * 1024)
    }));
    const result = await checkDashboard('http://host:3800');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/response too large/);
  });

  it('flags non-ok body.status as unhealthy', async () => {
    globalThis.fetch.mockResolvedValue(mockResponse({body: {status: 'degraded'}}));
    const result = await checkDashboard('http://host:3800');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dashboard status: degraded/);
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
