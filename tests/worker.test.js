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
});
