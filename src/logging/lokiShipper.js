/**
 * Buffers log entries and ships them to a Loki server via HTTP push API.
 *
 * Batches by size (batchSize) or time (flushInterval), whichever hits first.
 * Groups entries by stream labels (level + job) to minimize payload size.
 * Retries with exponential backoff, capped at maxRetryAttempts.
 * Drops entries silently if buffer exceeds maxBufferSize — never crashes the worker.
 */
const MAX_RETRY_ATTEMPTS = 5;

export class LokiShipper {
  /**
   * @param {object} options
   * @param {string} options.url - Loki base URL (e.g., http://loki:3100)
   * @param {number} [options.batchSize=100]
   * @param {number} [options.flushInterval=5000]
   * @param {object} [options.labels={}] - static labels added to every stream
   * @param {number} [options.maxBufferSize=10000]
   */
  constructor({url, batchSize = 100, flushInterval = 5000, labels = {}, maxBufferSize = 10000}) {
    if (!url) throw new Error('LokiShipper requires a url');

    this._url = url.replace(/\/$/, '') + '/loki/api/v1/push';
    this._batchSize = batchSize;
    this._maxBufferSize = maxBufferSize;
    this._staticLabels = labels;
    this._buffer = [];
    this._flushing = false;
    this._stopped = false;
    this._droppedCount = 0;
    this._retryDelayMs = 1000;
    this._maxRetryDelayMs = 30000;
    this._stopController = new AbortController();

    this._timer = setInterval(() => this._flush().catch(() => {}), flushInterval);
    this._timer.unref?.();
  }

  /**
   * Add a log entry to the buffer.
   * @param {object} entry - {job, id, level, msg, data}
   */
  push(entry) {
    if (this._stopped) return;

    if (this._buffer.length >= this._maxBufferSize) {
      this._droppedCount++;
      return;
    }

    this._buffer.push({
      ts: Date.now(),
      entry
    });

    if (this._buffer.length >= this._batchSize) {
      this._flush().catch(() => {});
    }
  }

  bufferedCount() {
    return this._buffer.length;
  }

  droppedCount() {
    return this._droppedCount;
  }

  /**
   * Flush current buffer to Loki. Caps retries to avoid blocking other flushes.
   */
  async _flush() {
    if (this._flushing || this._buffer.length === 0) return;
    this._flushing = true;

    const batch = this._buffer.splice(0, this._buffer.length);
    const payload = this._buildPayload(batch);

    let delayMs = this._retryDelayMs;
    let sent = false;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      if (this._stopped) break;
      try {
        const res = await fetch(this._url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          sent = true;
          break;
        }
        // 4xx won't succeed on retry — drop with warning
        if (res.status >= 400 && res.status < 500) {
          process.stderr.write(
            `[worker-sdk] LokiShipper: dropping batch of ${batch.length} — Loki returned ${res.status}\n`
          );
          sent = true; // don't re-queue, don't retry
          break;
        }
        // 5xx — retry
        throw new Error(`Loki returned HTTP ${res.status}`);
      } catch (err) {
        if (this._stopped) break;
        if (attempt === MAX_RETRY_ATTEMPTS - 1) break;
        await this._sleep(delayMs);
        delayMs = Math.min(delayMs * 2, this._maxRetryDelayMs);
      }
    }

    if (!sent) {
      // Either stopped mid-retry or retries exhausted — re-prepend batch
      // so final flush (stop) or next interval tick can attempt again.
      if (this._stopped) {
        // Re-prepend so stop()'s final flush has one more shot
        this._buffer.unshift(...batch);
      } else {
        // Retries exhausted — log a warning and drop
        process.stderr.write(
          `[worker-sdk] LokiShipper: dropping batch of ${batch.length} after ${MAX_RETRY_ATTEMPTS} retries\n`
        );
        this._droppedCount += batch.length;
      }
    }

    this._flushing = false;
  }

  /**
   * Abortable sleep — wakes immediately if stop() is called.
   */
  _sleep(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      this._stopController.signal.addEventListener('abort', onAbort, {once: true});
    });
  }

  /**
   * Build Loki push payload from buffered entries.
   * Groups entries by stream labels (level + job) to compress payload.
   */
  _buildPayload(batch) {
    const streams = new Map();

    for (const {ts, entry} of batch) {
      const streamLabels = {
        ...this._staticLabels,
        level: entry.level,
        job: entry.job
      };
      const key = JSON.stringify(streamLabels);

      if (!streams.has(key)) {
        streams.set(key, {stream: streamLabels, values: []});
      }

      const line = JSON.stringify({
        id: entry.id,
        msg: entry.msg,
        ...(entry.data ? {data: entry.data} : {})
      });
      const tsNs = `${ts}000000`; // ms → ns
      streams.get(key).values.push([tsNs, line]);
    }

    return {streams: Array.from(streams.values())};
  }

  /**
   * Stop the shipper — flush remaining buffer, cancel timer, abort pending sleeps.
   */
  async stop() {
    this._stopped = true;
    this._stopController.abort();
    if (this._timer) clearInterval(this._timer);
    // Final flush — one last try with remaining entries
    if (this._buffer.length > 0) {
      this._stopped = false; // allow final flush to attempt
      try {
        await this._flush();
      } finally {
        this._stopped = true;
      }
    }
  }
}
