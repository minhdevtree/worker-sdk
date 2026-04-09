import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

const mockAdd = vi.fn().mockResolvedValue({id: 'job-1'});

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function(name, opts) {
    this.name = name;
    this.opts = opts;
    this.add = mockAdd;
    this.close = vi.fn();
  })
}));

import {Queue} from 'bullmq';
import {createClient} from '../src/client/client.js';
import {writeFileSync, mkdirSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';

describe('createClient', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    vi.mocked(Queue).mockClear();
    mockAdd.mockClear();

    tmpDir = join(tmpdir(), `worker-sdk-client-${Date.now()}`);
    mkdirSync(tmpDir, {recursive: true});
    configPath = join(tmpDir, 'worker.config.yml');

    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
jobs:
  revertBatch:
    tier: medium
    timeout: 540000
  lightJob:
    tier: light
    timeout: 5000
`);
  });

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it('should add a job to the correct tier queue', async () => {
    const client = createClient(configPath);

    await client.add('revertBatch', {shopId: '123'});

    expect(Queue).toHaveBeenCalled();
    const queueCall = Queue.mock.calls.find(c => c[0] === 'worker:medium');
    expect(queueCall).toBeTruthy();

    expect(mockAdd).toHaveBeenCalledWith(
      'revertBatch',
      {shopId: '123'},
      expect.objectContaining({
        attempts: 1
      })
    );
  });

  it('should use job retry config as attempts', async () => {
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
jobs:
  retryJob:
    tier: heavy
    timeout: 30000
    retry:
      maxAttempts: 5
      baseDelay: 2000
`);

    const client = createClient(configPath);
    await client.add('retryJob', {data: true});

    expect(mockAdd).toHaveBeenCalledWith(
      'retryJob',
      {data: true},
      expect.objectContaining({
        attempts: 5,
        backoff: {type: 'exponential', delay: 2000}
      })
    );
  });

  it('should throw for unknown job name', async () => {
    const client = createClient(configPath);

    await expect(client.add('unknownJob', {})).rejects.toThrow('Unknown job: unknownJob');
  });

  it('should lazily create queues (not on init)', () => {
    const client = createClient(configPath);

    expect(Queue).not.toHaveBeenCalled();
  });

  it('should reuse queue instances for same tier', async () => {
    const client = createClient(configPath);

    await client.add('revertBatch', {a: 1});
    await client.add('revertBatch', {a: 2});

    const mediumCalls = Queue.mock.calls.filter(c => c[0] === 'worker:medium');
    expect(mediumCalls.length).toBe(1);
  });
});
