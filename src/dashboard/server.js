import express from 'express';
import {createBullBoard} from '@bull-board/api';
import {BullMQAdapter} from '@bull-board/api/bullMQAdapter';
import {ExpressAdapter} from '@bull-board/express';

/**
 * Create Express app with Bull Board and health endpoint.
 * @param {object} options
 * @param {import('bullmq').Queue[]} options.queues - BullMQ queues to display
 * @param {object} options.auth - {username, password} for basic auth
 * @returns {import('express').Express}
 */
export function createDashboardApp({queues, auth}) {
  const app = express();

  // Health endpoint (no auth)
  const startTime = Date.now();
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString()
    });
  });

  // Basic auth for all other routes
  if (auth?.username && auth?.password) {
    app.use((req, res, next) => {
      if (req.path === '/health') return next();

      const header = req.headers.authorization;
      if (!header || !header.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Worker Dashboard"');
        return res.status(401).send('Authentication required');
      }

      const credentials = Buffer.from(header.slice(6), 'base64').toString();
      const [username, password] = credentials.split(':');

      if (username === auth.username && password === auth.password) {
        return next();
      }

      res.set('WWW-Authenticate', 'Basic realm="Worker Dashboard"');
      return res.status(401).send('Invalid credentials');
    });
  }

  // Bull Board
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/');

  createBullBoard({
    queues: queues.map(q => new BullMQAdapter(q)),
    serverAdapter
  });

  app.use('/', serverAdapter.getRouter());

  return app;
}
