import {HEARTBEAT_KEY_PREFIX} from '../worker/heartbeatKey.js';

/**
 * List all currently-alive workers by scanning heartbeat keys in Redis.
 * Keys with missing or malformed values are skipped silently.
 *
 * @param {object} redis - ioredis client (needs scan, mget)
 * @returns {Promise<Array<{workerId, hostname, pid, tiers, startedAt, lastBeat}>>}
 */
export async function listWorkers(redis) {
  const keys = await scanAll(redis, `${HEARTBEAT_KEY_PREFIX}*`);
  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  const workers = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && typeof parsed.workerId === 'string') {
        workers.push(parsed);
      }
      // else: malformed shape — skip silently like malformed JSON
    } catch {
      // malformed entry — skip
    }
  }
  return workers;
}

/**
 * Iterate SCAN cursor until complete, collecting all matched keys.
 * Uses SCAN (not KEYS) so this is safe to call on large Redis instances.
 */
async function scanAll(redis, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    for (const k of batch) keys.push(k);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}
