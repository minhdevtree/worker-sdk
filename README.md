# @minhdevtree/worker-sdk

Self-hosted background job runner powered by BullMQ + Redis. Replace Firebase Cloud Functions with a simple, local job queue.

## Install

```bash
npm install @minhdevtree/worker-sdk
```

Requires Redis running locally or remotely.

## Quick Start

### 1. Create config

`worker.config.yml`:

```yaml
redis:
  host: 127.0.0.1
  port: 6379

dashboard:
  port: 3800
  auth:
    username: admin
    password: ${DASHBOARD_PASSWORD}

concurrency:
  heavy: 2
  medium: 5
  light: 10

jobs:
  processOrder:
    tier: heavy
    timeout: 60000
    retry:
      maxAttempts: 3
      baseDelay: 2000
  sendNotification:
    tier: light
    timeout: 10000
  dailyReport:
    tier: medium
    timeout: 300000
    cron: "0 0 * * *"
```

### 2. Define handlers

```js
// jobs/processOrder.js
export async function execute(payload, context) {
  const {logger, signal, jobId, attempt} = context;
  logger.info('Processing order', {orderId: payload.orderId});
  const result = await processOrder(payload.orderId);
  return result;
}
```

### 3. Start worker

```js
// worker.js
import {createWorker} from '@minhdevtree/worker-sdk';
import {execute as processOrder} from './jobs/processOrder.js';
import {execute as sendNotification} from './jobs/sendNotification.js';
import {execute as dailyReport} from './jobs/dailyReport.js';

const worker = createWorker('./worker.config.yml');

worker.register('processOrder', processOrder);
worker.register('sendNotification', sendNotification);
worker.register('dailyReport', dailyReport);

await worker.start();
```

### 4. Push jobs from your app

```js
import {createClient} from '@minhdevtree/worker-sdk';

const client = createClient('./worker.config.yml');

await client.add('processOrder', {orderId: 42});
await client.add('sendNotification', {to: 'user@example.com'});
```

## Tiers

Jobs are grouped by resource weight:

| Tier | Default Concurrency | Use case |
|------|-------------------|----------|
| heavy | 2 | CPU/memory intensive work |
| medium | 5 | Moderate processing |
| light | 10 | Quick tasks |

## Dashboard

Bull Board UI available at `http://localhost:3800` (configurable). View queues, job status, retry failed jobs, inspect payloads.

## Handler Context

```js
export async function execute(payload, context) {
  context.jobId    // unique job ID
  context.attempt  // current attempt (1-based)
  context.logger   // {info, warn, error} — logs visible in Bull Board
  context.signal   // AbortSignal — fires on timeout
}
```
