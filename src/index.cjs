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
  }
};
