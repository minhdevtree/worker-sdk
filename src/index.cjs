// CJS wrapper for environments that can't use ESM (e.g. Babel-compiled code)
module.exports = {
  async createWorker(configPath) {
    const mod = await import('./worker/worker.js');
    return mod.createWorker(configPath);
  },
  async createClient(configPath) {
    const mod = await import('./client/client.js');
    return mod.createClient(configPath);
  },
  async createDashboard(configPath) {
    const mod = await import('./dashboard/standalone.js');
    return mod.createDashboard(configPath);
  },
  async listWorkers(redis) {
    const mod = await import('./admin/listWorkers.js');
    return mod.listWorkers(redis);
  },
  async pingRedis(redis, options) {
    const mod = await import('./admin/pingRedis.js');
    return mod.pingRedis(redis, options);
  },
  async getQueueDepths(connection, tiers) {
    const mod = await import('./admin/getQueueDepths.js');
    return mod.getQueueDepths(connection, tiers);
  },
  async checkDashboard(baseUrl, options) {
    const mod = await import('./admin/checkDashboard.js');
    return mod.checkDashboard(baseUrl, options);
  },
  async getClusterHealth(params) {
    const mod = await import('./admin/getClusterHealth.js');
    return mod.getClusterHealth(params);
  }
};
