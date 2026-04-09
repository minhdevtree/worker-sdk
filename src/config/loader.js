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

  return config;
}

/**
 * Replace ${VAR_NAME} with process.env.VAR_NAME
 */
function interpolateEnv(str) {
  return str.replace(/\$\{(\w+)\}/g, (match, varName) => {
    return process.env[varName] || match;
  });
}
