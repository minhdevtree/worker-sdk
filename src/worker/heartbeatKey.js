/**
 * Prefix for worker heartbeat keys in Redis.
 * Used by both the Heartbeat module (writer) and listWorkers (reader).
 * Keys take the form `${HEARTBEAT_KEY_PREFIX}<workerId>`.
 */
export const HEARTBEAT_KEY_PREFIX = 'worker:heartbeat:';
