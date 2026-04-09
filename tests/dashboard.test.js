import {describe, it, expect, vi} from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name) => ({name, close: vi.fn()}))
}));

vi.mock('@bull-board/api', () => ({
  createBullBoard: vi.fn()
}));

vi.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: vi.fn().mockImplementation((queue) => ({queue}))
}));

vi.mock('@bull-board/express', () => {
  function ExpressAdapter() {
    this.setBasePath = vi.fn();
    this.getRouter = vi.fn().mockReturnValue((req, res, next) => next());
  }
  return {ExpressAdapter};
});

import {createDashboardApp} from '../src/dashboard/server.js';

describe('Dashboard', () => {
  it('should create an express app', () => {
    const app = createDashboardApp({
      queues: [],
      auth: {username: 'admin', password: 'secret'}
    });

    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });

  it('should have a health endpoint', () => {
    const app = createDashboardApp({
      queues: [],
      auth: {username: 'admin', password: 'secret'}
    });

    const router = app._router ?? app.router;
    const layers = router.stack.filter(
      l => l.route && l.route.path === '/health'
    );
    expect(layers.length).toBeGreaterThan(0);
  });
});
