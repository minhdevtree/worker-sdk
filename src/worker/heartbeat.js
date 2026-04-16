import os from 'os';
import {HEARTBEAT_KEY_PREFIX} from './heartbeatKey.js';

/**
 * Heartbeat — writes a TTL'd key to Redis on a fixed interval.
 *
 * Key format: worker:heartbeat:<workerId>
 * Value: JSON-encoded WorkerInfo ({workerId, hostname, pid, tiers, startedAt, lastBeat})
 * TTL: ttlMs (auto-expires if worker dies between beats)
 *
 * Failure mode: if _beat() throws (Redis blip), log a warning and continue.
 * The next interval tick retries; no state is lost. If Redis is unreachable
 * past ttlMs, the key expires — observers correctly conclude the worker is dead.
 */
export class Heartbeat {
  /**
   * @param {object} options
   * @param {object} options.redis - ioredis client with set/del
   * @param {string} options.workerId - unique worker identity
   * @param {object} options.tiers - {heavy, medium, light} concurrency
   * @param {number} options.intervalMs - beat cadence
   * @param {number} options.ttlMs - Redis key TTL
   */
  constructor({redis, workerId, tiers, intervalMs, ttlMs}) {
    this._redis = redis;
    this._workerId = workerId;
    this._tiers = tiers;
    this._intervalMs = intervalMs;
    this._ttlMs = ttlMs;
    this._key = `${HEARTBEAT_KEY_PREFIX}${workerId}`;
    this._hostname = os.hostname();
    this._pid = process.pid;
    this._startedAt = Date.now();
    this._timer = null;
    this._started = false;
    this._stopped = false;
  }

  async start() {
    if (this._stopped) {
      throw new Error('Heartbeat: cannot restart after stop() — create a new instance');
    }
    if (this._started) {
      process.stderr.write(
        '[worker-sdk] Heartbeat: start() called twice — ignoring second call\n'
      );
      return;
    }
    this._started = true;
    await this._beat().catch(err => {
      process.stderr.write(
        `[worker-sdk] Heartbeat: initial beat failed (${err.message}); will retry on interval\n`
      );
    });
    this._timer = setInterval(() => {
      this._beat().catch(err => {
        process.stderr.write(
          `[worker-sdk] Heartbeat: beat failed (${err.message}); retrying next interval\n`
        );
      });
    }, this._intervalMs);
    this._timer.unref?.();
  }

  async _beat() {
    const payload = JSON.stringify({
      workerId: this._workerId,
      hostname: this._hostname,
      pid: this._pid,
      tiers: this._tiers,
      startedAt: this._startedAt,
      lastBeat: Date.now()
    });
    this._inFlightBeat = this._redis.set(this._key, payload, 'PX', this._ttlMs);
    try {
      await this._inFlightBeat;
    } finally {
      this._inFlightBeat = null;
    }
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Wait for any in-flight beat to settle before deleting the key
    if (this._inFlightBeat) {
      try {
        await this._inFlightBeat;
      } catch {
        // beat errored; carry on
      }
    }
    if (!this._started) return; // never wrote a key; nothing to delete
    if (this._redis && typeof this._redis.del === 'function') {
      try {
        await this._redis.del(this._key);
      } catch {
        // ignore — stopping is best-effort; key will expire via TTL anyway
      }
    }
  }
}
