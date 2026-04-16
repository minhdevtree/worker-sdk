import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {writeFileSync, mkdirSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';

vi.mock('bullmq', () => {
  const mockWorkerClose = vi.fn();
  const mockQueueClose = vi.fn();
  return {
    Worker: vi.fn().mockImplementation(function(name, processor, opts) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      this.close = mockWorkerClose;
      this.on = vi.fn();
    }),
    Queue: vi.fn().mockImplementation(function(name, opts) {
      this.name = name;
      this.add = vi.fn().mockResolvedValue({id: '1'});
      this.upsertJobScheduler = vi.fn().mockResolvedValue({});
      this.close = mockQueueClose;
    }),
    _mockWorkerClose: mockWorkerClose,
    _mockQueueClose: mockQueueClose
  };
});

import {createWorker} from '../src/worker/worker.js';

describe('createWorker', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `worker-sdk-worker-${Date.now()}`);
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
    password: test
concurrency:
  heavy: 1
  medium: 2
  light: 3
jobs:
  testJob:
    tier: medium
    timeout: 5000
  cronJob:
    tier: light
    timeout: 5000
    cron: "0 0 * * *"
`);
  });

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it('should create a worker with register and start methods', () => {
    const worker = createWorker(configPath);

    expect(typeof worker.register).toBe('function');
    expect(typeof worker.start).toBe('function');
    expect(typeof worker.stop).toBe('function');
  });

  it('should register handlers', () => {
    const worker = createWorker(configPath);
    const handler = vi.fn();

    worker.register('testJob', handler);

    expect(() => worker.register('testJob', handler)).not.toThrow();
  });

  it('should validate all registered handlers have config on start', async () => {
    const worker = createWorker(configPath);
    worker.register('testJob', vi.fn());
    worker.register('unknownJob', vi.fn());

    await expect(worker.start()).rejects.toThrow('not defined in config: unknownJob');
  });

  it('should warn if dashboard config is set (use createDashboard instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
dashboard:
  port: 3800
  auth:
    username: admin
    password: test
concurrency:
  heavy: 1
  medium: 2
  light: 3
jobs:
  testJob:
    tier: medium
    timeout: 5000
`);

    const worker = createWorker(configPath);
    worker.register('testJob', vi.fn());
    await worker.start();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dashboard')
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('createDashboard')
    );

    warn.mockRestore();
  });

  it('should auto-generate workerId from hostname and pid when worker.id is empty', async () => {
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  id:
concurrency:
  heavy: 1
  medium: 2
  light: 3
jobs:
  testJob:
    tier: medium
    timeout: 5000
`);
    const worker = createWorker(configPath);
    worker.register('testJob', vi.fn());
    await worker.start();

    const os = await import('os');
    const expected = `${os.hostname()}-${process.pid}`;
    expect(worker.workerId).toBe(expected);

    await worker.stop();
  });

  it('should use config.worker.id when set', async () => {
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  id: custom-worker-123
concurrency:
  heavy: 1
  medium: 2
  light: 3
jobs:
  testJob:
    tier: medium
    timeout: 5000
`);
    const worker = createWorker(configPath);
    worker.register('testJob', vi.fn());
    await worker.start();
    expect(worker.workerId).toBe('custom-worker-123');
    await worker.stop();
  });

  it('should register heartbeat as first shutdown handler when enabled', async () => {
    const {ShutdownManager} = await import('../src/shutdown/shutdownManager.js');
    const registerSpy = vi.spyOn(ShutdownManager.prototype, 'register');

    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  id: w-hb
concurrency:
  heavy: 1
  medium: 2
  light: 3
jobs:
  testJob:
    tier: medium
    timeout: 5000
`);
    const worker = createWorker(configPath);
    worker.register('testJob', vi.fn());
    await worker.start();

    const names = registerSpy.mock.calls.map(c => c[0]);
    expect(names[0]).toBe('heartbeat');
    expect(names.indexOf('heartbeat')).toBeLessThan(names.indexOf('tierManager'));

    registerSpy.mockRestore();
    await worker.stop();
  });

  it('should skip heartbeat when worker.heartbeat.enabled is false', async () => {
    const {ShutdownManager} = await import('../src/shutdown/shutdownManager.js');
    const registerSpy = vi.spyOn(ShutdownManager.prototype, 'register');

    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  id: w-no-hb
  heartbeat:
    enabled: false
concurrency:
  heavy: 1
  medium: 2
  light: 3
jobs:
  testJob:
    tier: medium
    timeout: 5000
`);
    const worker = createWorker(configPath);
    worker.register('testJob', vi.fn());
    await worker.start();

    const names = registerSpy.mock.calls.map(c => c[0]);
    expect(names).not.toContain('heartbeat');

    expect(worker.workerId).toBe('w-no-hb');
    registerSpy.mockRestore();
    await worker.stop();
  });
});
