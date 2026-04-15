import {describe, it, expect, vi, afterEach} from 'vitest';
import {JobExecutor, setLokiShipper} from '../src/worker/jobExecutor.js';

describe('JobExecutor', () => {
  afterEach(() => {
    // Reset Loki shipper so it doesn't leak between tests
    setLokiShipper(null);
  });

  it('should execute handler with payload and context', async () => {
    const handler = vi.fn().mockResolvedValue({done: true});
    const executor = new JobExecutor();

    const mockJob = {
      name: 'testJob',
      data: {shopId: '123'},
      id: 'job-1',
      attemptsMade: 0,
      log: vi.fn().mockResolvedValue(0),
      updateProgress: vi.fn()
    };

    const result = await executor.run(handler, mockJob, 30000);

    expect(handler).toHaveBeenCalledTimes(1);
    const [payload, context] = handler.mock.calls[0];
    expect(payload).toEqual({shopId: '123'});
    expect(context.jobId).toBe('job-1');
    expect(context.attempt).toBe(1);
    expect(typeof context.logger.info).toBe('function');
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({done: true});
  });

  it('should abort via signal when timeout expires', async () => {
    let capturedSignal;
    const handler = vi.fn(async (payload, context) => {
      capturedSignal = context.signal;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
    });

    const executor = new JobExecutor();
    const mockJob = {
      name: 'slowJob',
      data: {},
      id: 'job-2',
      attemptsMade: 0,
      log: vi.fn().mockResolvedValue(0),
      updateProgress: vi.fn()
    };

    await expect(executor.run(handler, mockJob, 100)).rejects.toThrow('Aborted');
    expect(capturedSignal.aborted).toBe(true);
  });

  it('should provide a logger that writes to job.log', async () => {
    const handler = vi.fn(async (payload, context) => {
      context.logger.info('test message', {key: 'value'});
      context.logger.error('error occurred');
    });

    const mockJob = {
      name: 'logJob',
      data: {},
      id: 'job-3',
      attemptsMade: 0,
      log: vi.fn().mockResolvedValue(0),
      updateProgress: vi.fn()
    };

    const executor = new JobExecutor();
    await executor.run(handler, mockJob, 30000);

    // logger writes directly to job.log (no double-write — console capture uses process.stdout)
    const logCalls = mockJob.log.mock.calls.map(c => c[0]);
    expect(logCalls.some(entry => entry.includes('test message'))).toBe(true);
    expect(logCalls.some(entry => entry.includes('error occurred'))).toBe(true);
  });

  it('should capture console.log inside handler to job.log via AsyncLocalStorage', async () => {
    const handler = vi.fn(async (payload, context) => {
      console.log('captured message');
    });

    const mockJob = {
      name: 'consoleJob',
      data: {},
      id: 'job-5',
      attemptsMade: 0,
      log: vi.fn().mockResolvedValue(0),
      updateProgress: vi.fn()
    };

    const executor = new JobExecutor();
    await executor.run(handler, mockJob, 30000);

    const logCalls = mockJob.log.mock.calls.map(c => c[0]);
    expect(logCalls.some(entry => entry.includes('captured message'))).toBe(true);
  });

  it('should propagate handler errors', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('Handler failed'));
    const executor = new JobExecutor();

    const mockJob = {
      name: 'failJob',
      data: {},
      id: 'job-4',
      attemptsMade: 0,
      log: vi.fn().mockResolvedValue(0),
      updateProgress: vi.fn()
    };

    await expect(executor.run(handler, mockJob, 30000)).rejects.toThrow('Handler failed');
  });

  it('should ship logs to LokiShipper when one is registered', async () => {
    const pushMock = vi.fn();
    setLokiShipper({push: pushMock});

    const handler = vi.fn(async (payload, context) => {
      context.logger.info('to loki', {shopId: 'xyz'});
    });

    const mockJob = {
      name: 'lokiJob',
      data: {},
      id: 'job-loki-1',
      attemptsMade: 0,
      log: vi.fn().mockResolvedValue(0),
      updateProgress: vi.fn()
    };

    const executor = new JobExecutor();
    await executor.run(handler, mockJob, 30000);

    expect(pushMock).toHaveBeenCalledTimes(1);
    const [entry] = pushMock.mock.calls[0];
    expect(entry.job).toBe('lokiJob');
    expect(entry.id).toBe('job-loki-1');
    expect(entry.level).toBe('INFO');
    expect(entry.msg).toBe('to loki');
    expect(entry.data).toEqual({shopId: 'xyz'});
  });

  it('should ship console.log output to LokiShipper via AsyncLocalStorage', async () => {
    const pushMock = vi.fn();
    setLokiShipper({push: pushMock});

    const handler = vi.fn(async () => {
      console.log('captured');
    });

    const mockJob = {
      name: 'lokiConsoleJob',
      data: {},
      id: 'job-loki-2',
      attemptsMade: 0,
      log: vi.fn().mockResolvedValue(0),
      updateProgress: vi.fn()
    };

    const executor = new JobExecutor();
    await executor.run(handler, mockJob, 30000);

    expect(pushMock).toHaveBeenCalled();
    const entries = pushMock.mock.calls.map(c => c[0]);
    const consoleEntry = entries.find(e => e.msg === 'captured');
    expect(consoleEntry).toBeDefined();
    expect(consoleEntry.job).toBe('lokiConsoleJob');
    expect(consoleEntry.id).toBe('job-loki-2');
    expect(consoleEntry.level).toBe('LOG');
  });
});
