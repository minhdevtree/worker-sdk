import {readFileSync} from 'fs';
import yaml from 'js-yaml';

const DEFAULT_CONCURRENCY = {heavy: 2, medium: 5, light: 10};

/**
 * Load and parse YAML config with environment variable interpolation.
 * @param {string} configPath - Path to the YAML config file
 * @returns {object} Parsed config
 */
export function loadConfig(configPath) {
  const raw = readFileSync(configPath, 'utf-8');
  const interpolated = interpolateEnv(raw);
  const config = yaml.load(interpolated);

  config.concurrency = {...DEFAULT_CONCURRENCY, ...config.concurrency};
  config.dashboard = config.dashboard || {};
  config.jobs = config.jobs || {};

  normalizeRedisOptions(config.redis);

  return config;
}

/**
 * Normalize Redis connection options after env interpolation.
 * - Coerce port from string to number (env vars are always strings)
 * - Convert tls: "true" to {} (enables TLS); empty/false removes the key
 */
function normalizeRedisOptions(redis) {
  if (!redis) return;

  if (typeof redis.port === 'string') {
    redis.port = parseInt(redis.port, 10);
  }

  if (redis.tls === undefined || redis.tls === '' || redis.tls === 'false' || redis.tls === false) {
    delete redis.tls;
  } else if (redis.tls === 'true' || redis.tls === true) {
    redis.tls = {};
  }
  // If redis.tls is already an object, leave it alone (advanced TLS config)
}

/**
 * Replace ${VAR_NAME} with process.env.VAR_NAME.
 * Supports default values: ${VAR_NAME:-default_value}
 */
function interpolateEnv(str) {
  return str.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (match, varName, defaultValue) => {
    const value = process.env[varName];
    if (value !== undefined) return value;
    if (defaultValue !== undefined) return defaultValue;
    return match;
  });
}
