import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {writeFileSync, mkdirSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';

import {Queue} from 'bullmq';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function(name, opts) {
    this.name = name;
    this.opts = opts;
    this.close = vi.fn().mockResolvedValue(undefined);
  })
}));

vi.mock('@bull-board/api', () => ({
  createBullBoard: vi.fn()
}));

vi.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: vi.fn().mockImplementation(function(q) { this.queue = q; })
}));

vi.mock('@bull-board/express', () => ({
  ExpressAdapter: vi.fn().mockImplementation(function() {
    this.setBasePath = vi.fn();
    this.getRouter = vi.fn().mockReturnValue((req, res, next) => next());
  })
}));

import {createDashboard} from '../src/dashboard/standalone.js';

describe('createDashboard (standalone)', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    Queue.mockClear();
    tmpDir = join(tmpdir(), `worker-sdk-standalone-${Date.now()}`);
    mkdirSync(tmpDir, {recursive: true});
    configPath = join(tmpDir, 'worker.config.yml');

    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
dashboard:
  port: 0
  auth:
    username: admin
    password: secret
concurrency:
  heavy: 1
  medium: 2
  light: 3
jobs: {}
`);
  });

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  it('should return start and stop methods', () => {
    const dashboard = createDashboard(configPath);
    expect(typeof dashboard.start).toBe('function');
    expect(typeof dashboard.stop).toBe('function');

    const tierNames = Queue.mock.calls.map(call => call[0]);
    expect(tierNames).toEqual(expect.arrayContaining(['worker-heavy', 'worker-medium', 'worker-light']));

    for (const call of Queue.mock.calls) {
      expect(call[1]).toEqual({
        connection: expect.objectContaining({maxRetriesPerRequest: null})
      });
    }
  });

  it('should warn when auth credentials missing', () => {
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
dashboard:
  port: 0
concurrency:
  heavy: 1
  medium: 2
  light: 3
jobs: {}
`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDashboard(configPath);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: Standalone dashboard running without authentication')
    );
  });

  it('should start an HTTP server on dashboard.port', async () => {
    const dashboard = createDashboard(configPath);
    await dashboard.start();

    const address = dashboard.server.address();
    expect(address).toBeTruthy();
    expect(typeof address.port).toBe('number');

    await dashboard.stop();
  });

  it('should throw if dashboard config missing', () => {
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
jobs: {}
`);

    expect(() => createDashboard(configPath)).toThrow(/dashboard.*config/i);
  });
});
