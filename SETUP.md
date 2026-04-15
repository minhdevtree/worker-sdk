# @minhdevtree/worker-sdk — Integration Guide

Step-by-step guide to integrate the worker SDK into any Node.js app.

## Prerequisites

- Node.js >= 20
- A Redis instance you can reach (local or remote)

## Step 1: Install

```bash
yarn add @minhdevtree/worker-sdk

# Optional — only if your app uses Babel module aliases (e.g. @yourapp/...)
# and you want to import handlers directly from src/ instead of compiled lib/
yarn add --dev @babel/register
```

## Step 2: Create the worker config

Create `worker.config.yml` in your app's package root (next to `package.json`):

```yaml
redis:
  host: ${REDIS_HOST:-127.0.0.1}
  port: ${REDIS_PORT:-6379}
  password: ${REDIS_PASSWORD:-}
  tls: ${REDIS_TLS:-}

logging:
  dir: ./logs                        # local file buffer (short retention)
  retentionDays: 7
  loki:                              # optional — ship to Loki for long-term search
    url: ${LOKI_URL:-}
    batchSize: 100
    flushInterval: 5000
    labels:
      app: my-app
      env: production

dashboard:
  port: 3800
  auth:
    username: admin
    password: ${WORKER_DASHBOARD_PASSWORD}

concurrency:
  heavy: 2    # CPU/memory intensive jobs
  medium: 5   # Moderate jobs
  light: 10   # Quick tasks

jobs:
  myJob:
    tier: medium
    timeout: 540000       # 9 minutes in ms
    retry:
      maxAttempts: 3
      baseDelay: 5000     # exponential backoff starting at 5s

  dailyCleanup:
    tier: light
    timeout: 30000
    cron: "0 2 * * *"     # cron field marks this as a scheduled job
```

**Env interpolation:** `${VAR}` and `${VAR:-default}` syntax let you use the same file across local and production. Set `REDIS_TLS=true` to enable TLS for the Redis connection.

## Step 3: Create job handlers

Suggested directory structure:

```
src/jobs/
  functions/
    index.js          # registers all function handlers
    myJob.js          # handler file
  cron/
    index.js          # registers all cron handlers
    dailyCleanup.js   # handler file
```

### Handler format

Each handler exports an `execute` function:

```js
// src/jobs/functions/myJob.js

// You can import anything from your app — repositories, services, etc.
import {getShopById} from '@yourapp/repositories/shopRepository';

export async function execute(payload, context) {
  const {logger, signal, jobId, attempt} = context;

  // payload is the data passed when dispatching the job
  const {shopId, orderId} = payload;

  // logger writes to both terminal AND Bull Board dashboard
  logger.info('Starting job', {shopId, orderId});

  // All console.log/warn/error inside this function (and any code it calls)
  // are automatically captured and shown in Bull Board too
  console.log('This also appears in Bull Board');

  // Your business logic
  const shop = await getShopById(shopId);
  // ... do work ...

  // signal fires on timeout — use it for long-running operations
  if (signal.aborted) return;

  logger.info('Job completed');

  // Return value is stored and visible in Bull Board
  return {success: true, processed: 10};
}
```

### Registration files

```js
// src/jobs/functions/index.js
import {execute as myJob} from './myJob';
import {execute as anotherJob} from './anotherJob';

export function register(worker) {
  worker.register('myJob', myJob);
  worker.register('anotherJob', anotherJob);
}
```

```js
// src/jobs/cron/index.js
import {execute as dailyCleanup} from './dailyCleanup';

export function register(worker) {
  worker.register('dailyCleanup', dailyCleanup);
}
```

## Step 4: Create the worker entry point

Create `worker.mjs` in your app's package root:

```js
import {createRequire} from 'module';
import {createWorker} from '@minhdevtree/worker-sdk';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Optional: register Babel so we can import directly from src/ with module aliases
// (skip if your app doesn't use Babel)
const require = createRequire(import.meta.url);
require('@babel/register');

// Your app's database/SDK initialization goes here.
// Example: Firebase Admin
//   import firebase from 'firebase-admin';
//   firebase.initializeApp({...});
//
// The SDK does not assume any specific database. Initialize whatever
// your handlers need before importing them.

// Create worker
const worker = createWorker(path.resolve(__dirname, 'worker.config.yml'));

// Register handlers
const {register: registerFunctions} = require('./src/jobs/functions/index.js');
const {register: registerCron} = require('./src/jobs/cron/index.js');

registerFunctions(worker);
registerCron(worker);

await worker.start();
```

## Step 5: Create the client helper

The client lets your app backend dispatch jobs into the queue:

```js
// src/helpers/worker/workerClient.js
import path from 'path';

const configPath = path.resolve(__dirname, '..', '..', '..', 'worker.config.yml');

let clientPromise = null;

async function getWorkerClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const {createClient} = await import('@minhdevtree/worker-sdk');
      return createClient(configPath);
    })();
  }
  return clientPromise;
}

/**
 * Dispatch a job to the worker queue.
 *
 * @param {string} jobName - must match a job in worker.config.yml
 * @param {object} payload - job data
 * @returns {Promise<{id: string}>} — id has the format `${jobName}-${uuid}`
 */
export async function dispatchJob(jobName, payload) {
  const client = await getWorkerClient();
  return client.add(jobName, payload);
}
```

The dynamic `import()` is needed if your app is compiled to CJS by Babel. If your app is native ESM, you can use a regular `import` statement.

## Step 6: Add an npm script

```json
{
  "scripts": {
    "worker": "node worker.mjs"
  }
}
```

For env vars (like `WORKER_DASHBOARD_PASSWORD`, Redis credentials, app secrets), either:
- Add them to your shell profile or `.env` file
- Pass them inline: `WORKER_DASHBOARD_PASSWORD=secret npm run worker`

## Step 7: Dispatch jobs from your app

Replace direct queue producers (e.g. Firebase `publishTopic()`) with `dispatchJob()`:

```js
import {dispatchJob} from '@yourapp/helpers/worker/workerClient';

await dispatchJob('myJob', {shopId, data});
```

## Running Bull Board as a standalone service

Instead of letting `createWorker` start the dashboard, run it as a separate process:

```js
// dashboard.mjs
import {createDashboard} from '@minhdevtree/worker-sdk';

const dashboard = createDashboard('./worker.config.yml');
await dashboard.start();
```

Add to your `package.json`:

```json
{
  "scripts": {
    "dashboard": "node dashboard.mjs"
  }
}
```

Or run as a dedicated Docker container alongside your workers.

Benefits:
- Dashboard survives worker restarts
- One dashboard serves many workers (all workers share the same Redis)
- Clearer separation of concerns

## Running

### 1. Make sure Redis is reachable

The SDK doesn't manage Redis — you need a Redis instance running and reachable at the host/port you configured. Local install, Docker, managed cloud Redis, anything works.

### 2. Start the worker

```bash
npm run worker
```

You should see:

```
[worker-sdk] Worker started
[worker-sdk] Jobs: myJob, anotherJob, dailyCleanup
[worker-sdk] Tiers: {"heavy":2,"medium":5,"light":10}
[worker-sdk] Dashboard running on port 3800
```

### 3. Open Bull Board dashboard

Go to `http://localhost:3800` and log in with the credentials from your config.

You can see:
- All queues (heavy/medium/light) with job counts
- Job list filtered by status
- Job detail — payload, result, logs, errors
- Retry/delete failed jobs
- Cron schedules

### 4. Start your app (in a separate terminal)

The app and worker share the Redis connection. The app dispatches jobs, the worker processes them.

## Long-term log search with Loki + Grafana

The SDK has built-in support for shipping logs to Grafana Loki. This solves the problem that Redis only keeps the last ~1000 jobs — Loki stores logs for months with a proper search UI via Grafana.

### 1. Run Loki + Grafana

Example `docker-compose.yml` snippet — add these services to your existing compose file alongside your worker and Redis. `GRAFANA_ADMIN_PASSWORD` goes in your `.env`. For the Loki server config, see the [Loki configuration docs](https://grafana.com/docs/loki/latest/configure/).

```yaml
services:
  loki:
    image: grafana/loki:3.0.0
    ports: ["3100:3100"]
    volumes:
      - ./loki/config.yml:/etc/loki/config.yml
      - loki-data:/var/loki
    command: -config.file=/etc/loki/config.yml

  grafana:
    image: grafana/grafana:latest
    ports: ["3000:3000"]
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}
    volumes:
      - grafana-data:/var/lib/grafana
    depends_on: [loki]

volumes:
  loki-data:
  grafana-data:
```

### 2. Enable shipping in your worker config

```yaml
logging:
  dir: ./logs
  retentionDays: 7
  loki:
    url: http://loki:3100
    batchSize: 100
    flushInterval: 5000
    labels:
      app: my-app
      env: production
```

### 3. Search logs in Grafana

Add Loki as a data source in Grafana (`http://loki:3100`), then open the left sidebar → Explore → select the Loki datasource. Use LogQL queries like:

- All logs for a shop: `{app="my-app"} | json | data_shopId="xyz"`
- Only errors today: `{app="my-app", level="ERROR"}`
- A specific job run: `{app="my-app"} | json | id="myJob-abc123"`

## Scaling with multiple workers

Run N workers against one Redis/Loki/Grafana/Bull Board. The SDK handles worker identity, liveness, and cron coordination automatically when you configure the right env vars.

### Single-machine scale with Docker Compose

```yaml
# docker-compose.yml
services:
  seo-worker-leader:
    build: .
    environment:
      WORKER_ID: leader
      CRON_LEADER: "true"
      # ... rest of env
    # singleton — no scale directive

  seo-worker:
    build: .
    environment:
      CRON_LEADER: "false"
      # WORKER_ID unset → auto-generated ${hostname}-${pid}
      # ... rest of env
    # scalable
```

Start the stack:

```bash
docker compose up -d --scale seo-worker=3 --build
# → 1 leader + 3 followers = 4 workers total
```

### Multi-machine scale

Same image, different env vars per host:

| Host | `WORKER_ID` | `CRON_LEADER` | `concurrency` override |
|---|---|---|---|
| services-1 | `services-1` | `true` | default |
| vps-hanoi | `vps-hanoi` | `false` | `WORKER_CONCURRENCY_HEAVY=4` |
| cloud-us | `cloud-us` | `false` | `WORKER_CONCURRENCY_LIGHT=0` |

All connect to the same `REDIS_HOST` and `LOKI_URL`.

### Inspecting the pool

```bash
# Live heartbeats in Redis
redis-cli -p 6380 -a $REDIS_PASSWORD KEYS "worker:heartbeat:*"

# Programmatic
node -e "
import('@minhdevtree/worker-sdk').then(async ({listWorkers}) => {
  const Redis = (await import('ioredis')).default;
  const redis = new Redis({host: '127.0.0.1', port: 6380, password: process.env.REDIS_PASSWORD});
  const workers = await listWorkers(redis);
  console.log(JSON.stringify(workers, null, 2));
  await redis.quit();
});
"
```

### Graceful shutdown across the pool

`docker compose down` (or a SIGTERM on a single container) triggers shutdown in this order within each worker:

1. **heartbeat** — key deleted immediately; observers see the worker leave the pool within ≤ `ttlMs`
2. **tierManager** — BullMQ workers drain in-flight jobs
3. **cronManager** — (only on leader) closes queue connections
4. **dashboardQueues** — closes the read-only Queue references that powered the embedded Bull Board (legacy)
5. **lokiShipper** — final flush of buffered log lines

Set `stop_grace_period: 35s` in compose for a worker handling long jobs.

## Migrating from Firebase Pub/Sub

### Before (Firebase)

```js
// Registration (pubsubFunctions.js)
export const handleMyJob = functions
  .runWith({memory: '2GB', timeoutSeconds: 540})
  .pubsub.topic('myJob')
  .onPublish(subscribeMyJob);

// Handler
export default async function subscribeMyJob(message) {
  const payload = JSON.parse(Buffer.from(message.data, 'base64').toString());
  const {shopId} = payload;
  console.log('Processing', shopId);
  // ... business logic
}
```

### After (Worker SDK)

```yaml
# worker.config.yml
jobs:
  myJob:
    tier: medium
    timeout: 540000
```

```js
// src/jobs/functions/myJob.js
export async function execute(payload, context) {
  const {shopId} = payload;          // already parsed, plain object
  context.logger.info('Processing', {shopId});
  // ... same business logic

  // If the handler chains other jobs, replace publishTopic with dispatchJob:
  // Before: await publishTopic('nextJob', {shopId, data});
  // After:  await dispatchJob('nextJob', {shopId, data});
}
```

### What changes

| Before (Firebase) | After (Worker SDK) |
|---|---|
| `functions.runWith({memory, timeout})` | `worker.config.yml` (tier, timeout, retry) |
| `.pubsub.topic('name').onPublish(fn)` | `worker.register('name', execute)` |
| `JSON.parse(Buffer.from(message.data))` | `payload` (already parsed) |
| `console.log()` | Works as-is — auto-captured to Bull Board |
| `publishTopic('next', data)` | `dispatchJob('next', data)` |
| Numeric job IDs (1, 2, 3) | `jobName-uuid` format |
| Runs on Google Cloud | Runs wherever you run the worker process |

### What stays the same

- All business logic
- All imports (repositories, services, APIs)
- All database access (Firestore, PostgreSQL, MongoDB, etc.)
- `console.log/warn/error` (auto-captured)
- Handler files can stay in their existing location

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `WORKER_DASHBOARD_PASSWORD` | Yes | Bull Board dashboard password |
| `REDIS_HOST` | No | Override YAML default |
| `REDIS_PORT` | No | Override YAML default |
| `REDIS_PASSWORD` | No | Override YAML default |
| `REDIS_TLS` | No | Set to `true` to enable TLS for Redis |
| `LOKI_URL` | No | Loki push endpoint. Empty = file-only logging |
| `WORKER_ID` | No | Unique worker identity. Auto-generated `${hostname}-${pid}` if unset |
| `CRON_LEADER` | No | Set to `true` on exactly one worker in the pool; defaults to `false` |
| `HEARTBEAT_ENABLED` | No | Set to `false` to disable heartbeats. Wire via YAML: `worker.heartbeat.enabled: ${HEARTBEAT_ENABLED:-true}` |

Any field in `worker.config.yml` can be made env-driven via `${VAR_NAME}` or `${VAR_NAME:-default}` syntax.

## Directory structure (complete)

```
your-app/
├── worker.mjs                    # Worker entry point
├── worker.config.yml             # Job definitions + Redis config
├── src/
│   ├── jobs/
│   │   ├── functions/
│   │   │   ├── index.js          # Registers all function handlers
│   │   │   ├── myJob.js
│   │   │   └── anotherJob.js
│   │   └── cron/
│   │       ├── index.js          # Registers all cron handlers
│   │       └── dailyCleanup.js
│   └── helpers/
│       └── worker/
│           └── workerClient.js   # dispatchJob() for backend use
```
