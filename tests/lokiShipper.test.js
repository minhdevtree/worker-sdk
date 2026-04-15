import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {LokiShipper} from '../src/logging/lokiShipper.js';

describe('LokiShipper', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn().mockResolvedValue({ok: true, status: 204});
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should batch entries and flush when batchSize reached', async () => {
    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 3,
      flushInterval: 60000,
      labels: {app: 'seo-worker'}
    });

    shipper.push({job: 'myJob', id: 'j1', level: 'INFO', msg: 'one'});
    shipper.push({job: 'myJob', id: 'j2', level: 'INFO', msg: 'two'});
    expect(fetchMock).not.toHaveBeenCalled();

    shipper.push({job: 'myJob', id: 'j3', level: 'INFO', msg: 'three'});

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://loki:3100/loki/api/v1/push');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].stream.app).toBe('seo-worker');
    expect(body.streams[0].stream.level).toBe('INFO');
    expect(body.streams[0].stream.job).toBe('myJob');
    expect(body.streams[0].values).toHaveLength(3);
    expect(body.streams[0].values[0][1]).toContain('"msg":"one"');

    shipper.stop();
  });

  it('should flush on interval even if batchSize not reached', async () => {
    vi.useFakeTimers();
    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 100,
      flushInterval: 1000,
      labels: {}
    });

    shipper.push({job: 'j', id: 'i1', level: 'INFO', msg: 'only one'});

    await vi.advanceTimersByTimeAsync(1100);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.streams[0].values).toHaveLength(1);

    shipper.stop();
    vi.useRealTimers();
  });

  it('should group entries by stream labels (job + level)', async () => {
    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 4,
      flushInterval: 60000,
      labels: {app: 'seo-worker'}
    });

    shipper.push({job: 'jobA', id: 'a1', level: 'INFO', msg: 'a-info'});
    shipper.push({job: 'jobA', id: 'a2', level: 'ERROR', msg: 'a-err'});
    shipper.push({job: 'jobB', id: 'b1', level: 'INFO', msg: 'b-info'});
    shipper.push({job: 'jobB', id: 'b2', level: 'INFO', msg: 'b-info2'});

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Three streams: (jobA, INFO), (jobA, ERROR), (jobB, INFO)
    expect(body.streams).toHaveLength(3);

    const jobBInfoStream = body.streams.find(
      s => s.stream.job === 'jobB' && s.stream.level === 'INFO'
    );
    expect(jobBInfoStream.values).toHaveLength(2);

    shipper.stop();
  });

  it('should retry on fetch failure with exponential backoff', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce({ok: true, status: 204});

    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 1,
      flushInterval: 60000,
      labels: {}
    });

    shipper.push({job: 'j', id: '1', level: 'INFO', msg: 'retry test'});

    // First attempt fails immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second attempt after 1s backoff
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Third attempt after 2s backoff
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    shipper.stop();
    vi.useRealTimers();
  });

  it('should drop logs when buffer exceeds maxBufferSize', async () => {
    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 10000, // never flushes by size
      flushInterval: 60000, // never flushes by time in test
      maxBufferSize: 5,
      labels: {}
    });

    // Push 10 entries — only first 5 should be retained
    for (let i = 0; i < 10; i++) {
      shipper.push({job: 'j', id: `${i}`, level: 'INFO', msg: `msg-${i}`});
    }

    expect(shipper.bufferedCount()).toBe(5);

    shipper.stop();
  });

  it('should flush remaining entries when stop() is called', async () => {
    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 100,
      flushInterval: 60000,
      labels: {}
    });

    shipper.push({job: 'j', id: 'final', level: 'INFO', msg: 'bye'});

    await shipper.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.streams[0].values[0][1]).toContain('"msg":"bye"');
  });

  it('should drop 4xx batches without retrying', async () => {
    fetchMock.mockResolvedValue({ok: false, status: 400});
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 1,
      flushInterval: 60000,
      labels: {}
    });

    shipper.push({job: 'j', id: '1', level: 'INFO', msg: '4xx test'});

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Should NOT retry on 400
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Loki returned 400'));

    stderrWrite.mockRestore();
    await shipper.stop();
  });

  it('should drop batch after MAX_RETRY_ATTEMPTS (5) and increment dropped counter', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('always fail'));
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 1,
      flushInterval: 60000,
      labels: {}
    });

    shipper.push({job: 'j', id: '1', level: 'INFO', msg: 'always fails'});

    // Let all 5 retry attempts play out (1s, 2s, 4s, 8s, 16s)
    await vi.advanceTimersByTimeAsync(60000);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(shipper.droppedCount()).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('after 5 retries'));

    stderrWrite.mockRestore();
    await shipper.stop();
    vi.useRealTimers();
  });

  it('should re-prepend batch to buffer when stop() is called during retry', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('down'));

    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 1,
      flushInterval: 60000,
      labels: {}
    });

    shipper.push({job: 'j', id: '1', level: 'INFO', msg: 'stop during retry'});

    // Trigger first fetch attempt
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Now stop while the shipper is in its backoff sleep
    // The abort controller should wake up the sleep, the batch should be re-prepended,
    // then stop()'s final flush makes one more attempt.
    const stopPromise = shipper.stop();

    // Flush pending microtasks so the abort propagates and stop's final flush runs
    await vi.runAllTimersAsync();
    await stopPromise;

    vi.useRealTimers();
  });

  it('stop() should return within bounded time even if Loki is down', async () => {
    fetchMock.mockRejectedValue(new Error('down'));

    const shipper = new LokiShipper({
      url: 'http://loki:3100',
      batchSize: 1,
      flushInterval: 60000,
      labels: {}
    });

    shipper.push({job: 'j', id: '1', level: 'INFO', msg: 'must not block'});

    // Wait for first fetch
    await new Promise(resolve => setTimeout(resolve, 50));

    const start = Date.now();
    await shipper.stop();
    const elapsed = Date.now() - start;

    // With AbortController, stop should return quickly (< 2s)
    expect(elapsed).toBeLessThan(2000);
  });

  it('should throw if url is missing', () => {
    expect(() => new LokiShipper({})).toThrow(/url/);
  });
});
