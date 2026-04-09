import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {writeFileSync, mkdirSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';

const addedJobs = [];
const schedulers = [];

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function(name, processor, opts) {
    this.name = name;
    this.processor = processor;
    this.opts = opts;
    this.close = vi.fn();
    this.on = vi.fn();
  }),
  Queue: vi.fn().mockImplementation(function(name) {
    this.name = name;
    this.add = vi.fn(async (jobName, data, opts) => {
      addedJobs.push({queue: name, jobName, data, opts});
      return {id: `job-${addedJobs.length}`};
    });
    this.upsertJobScheduler = vi.fn(async (id, repeat, template) => {
      schedulers.push({queue: name, id, repeat, template});
    });
    this.close = vi.fn();
  })
}));

vi.mock('@bull-board/api', () => ({createBullBoard: vi.fn()}));
vi.mock('@bull-board/api/bullMQAdapter', () => ({BullMQAdapter: vi.fn().mockImplementation(function(q) { this.queue = q; })}));
vi.mock('@bull-board/express', () => ({
  ExpressAdapter: vi.fn().mockImplementation(function() {
    this.setBasePath = vi.fn();
    this.getRouter = vi.fn().mockReturnValue((req, res, next) => next());
  })
}));

import {createWorker, createClient} from '../src/index.js';

describe('Integration', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    addedJobs.length = 0;
    schedulers.length = 0;
    tmpDir = join(tmpdir(), `worker-sdk-int-${Date.now()}`);
    mkdirSync(tmpDir, {recursive: true});
    configPath = join(tmpDir, 'worker.config.yml');

    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
dashboard:
  port: 0
concurrency:
  heavy: 1
  medium: 3
  light: 5
jobs:
  processOrder:
    tier: heavy
    timeout: 60000
    retry:
      maxAttempts: 3
      baseDelay: 2000
  sendEmail:
    tier: light
    timeout: 10000
  dailyReport:
    tier: medium
    timeout: 300000
    cron: "0 0 * * *"
    retry:
      maxAttempts: 1
`);
  });

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it('should wire worker with handlers and start without error', async () => {
    const worker = createWorker(configPath);

    worker.register('processOrder', async (payload, ctx) => ({ok: true}));
    worker.register('sendEmail', async (payload, ctx) => ({sent: true}));
    worker.register('dailyReport', async (payload, ctx) => ({rows: 100}));

    await worker.start();

    // Cron should be registered
    expect(schedulers.length).toBe(1);
    expect(schedulers[0].id).toBe('dailyReport');
    expect(schedulers[0].repeat).toEqual({pattern: '0 0 * * *'});

    await worker.stop();
  });

  it('should push job from client to correct tier queue', async () => {
    const client = createClient(configPath);

    await client.add('processOrder', {orderId: 42});
    await client.add('sendEmail', {to: 'test@example.com'});

    expect(addedJobs.length).toBe(2);
    expect(addedJobs[0].queue).toBe('worker-heavy');
    expect(addedJobs[0].jobName).toBe('processOrder');
    expect(addedJobs[0].data).toEqual({orderId: 42});

    expect(addedJobs[1].queue).toBe('worker-light');
    expect(addedJobs[1].jobName).toBe('sendEmail');

    await client.close();
  });
});
