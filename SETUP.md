# @minhdevtree/worker-sdk — Setup Guide

Step-by-step guide to integrate the worker SDK into any app.

## Prerequisites

- Node.js >= 20
- Redis running (local or remote)
- App uses Babel with module aliases (e.g., `@functions/`)

## Step 1: Install the SDK

```bash
# In your app's package directory
yarn add @minhdevtree/worker-sdk

# If your app uses Babel aliases and you want to import handlers from src/
yarn add --dev @babel/register
```

## Step 2: Create worker config

Create `worker.config.yml` in your app's package root (next to `package.json`):

```yaml
redis:
  host: 127.0.0.1
  port: 6379

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
  # Each job needs a name, tier, and timeout
  myJob:
    tier: medium
    timeout: 540000       # 9 minutes in ms
    retry:
      maxAttempts: 3
      baseDelay: 5000     # exponential backoff starting at 5s

  # Cron jobs have a cron field
  dailyCleanup:
    tier: light
    timeout: 30000
    cron: "0 2 * * *"     # every day at 2 AM
```

## Step 3: Create job handlers

Create a directory structure for your handlers:

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

## Step 4: Create worker entry point

Create `worker.mjs` in your app's package root:

```js
import {createRequire} from 'module';
import {createWorker} from '@minhdevtree/worker-sdk';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Register Babel so we can import directly from src/ with aliases
// (skip this if your app doesn't use Babel)
const require = createRequire(import.meta.url);
require('@babel/register');

// ─── Database init (pick what your app uses) ───
//
// Firebase/Firestore:
//   import firebase from 'firebase-admin';
//   const projectId = process.env.GCLOUD_PROJECT || 'your-project-id';
//   if (firebase.apps.length === 0) {
//     firebase.initializeApp({projectId, credential: firebase.credential.applicationDefault()});
//   }
//
// PostgreSQL (if your app doesn't auto-connect on import):
//   import {Pool} from 'pg';
//   global.pgPool = new Pool({connectionString: process.env.DATABASE_URL});
//
// MongoDB (if your app doesn't auto-connect on import):
//   import mongoose from 'mongoose';
//   await mongoose.connect(process.env.MONGODB_URI);
//
// If your repositories handle their own connections, skip this entirely.

// Create worker
const worker = createWorker(path.resolve(__dirname, 'worker.config.yml'));

// Register handlers
const {register: registerFunctions} = require('./src/jobs/functions/index.js');
const {register: registerCron} = require('./src/jobs/cron/index.js');

registerFunctions(worker);
registerCron(worker);

await worker.start();
```

## Step 5: Create client helper

Create a client module that your app backend uses to dispatch jobs:

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
 */
export async function dispatchJob(jobName, payload) {
  const client = await getWorkerClient();
  return client.add(jobName, payload);
}
```

## Step 6: Add npm script

Add to your `package.json` scripts:

```json
{
  "scripts": {
    "worker": "GCLOUD_PROJECT=your-project-id GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/firebase/your-credentials.json WORKER_DASHBOARD_PASSWORD=yourpassword node worker.mjs"
  }
}
```

## Step 7: Dispatch jobs from your app

Replace `publishTopic()` calls with `dispatchJob()`:

```js
// Before (Firebase Pub/Sub)
import publishTopic from '@yourapp/helpers/pubsub/publishTopic';
await publishTopic('myJob', {shopId, data});

// After (Worker SDK)
import {dispatchJob} from '@yourapp/helpers/worker/workerClient';
await dispatchJob('myJob', {shopId, data});
```

## Running

### Start Redis

```bash
redis-server
```

### Start the worker

```bash
cd your-app/packages/functions
npm run worker
```

You should see:

```
[worker] Firebase initialized with project: your-project-id
[worker-sdk] Worker started
[worker-sdk] Jobs: myJob, anotherJob, dailyCleanup
[worker-sdk] Tiers: {"heavy":2,"medium":5,"light":10}
[worker-sdk] Dashboard running on port 3800
```

### Open Bull Board dashboard

Go to `http://localhost:3800` and log in with the credentials from your config.

You can see:
- All queues (heavy/medium/light) with job counts
- Job list with status filtering
- Job detail — payload, result, logs, errors
- Retry/delete failed jobs
- Cron schedules

### Start your app (separate terminal)

```bash
yarn dev
```

Both the worker and app connect to the same Redis. The app pushes jobs, the worker processes them.

## Migrating Firebase Pub/Sub handlers

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
  const {shopId} = payload;          // already parsed
  context.logger.info('Processing', {shopId});
  // ... same business logic

  // If handler calls publishTopic() internally to chain jobs,
  // replace with dispatchJob():
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
| `console.log()` | Works as-is (auto-captured to Bull Board) |
| `publishTopic('next', data)` | `dispatchJob('next', data)` |
| Runs on Google Cloud | Runs on your machine |

### What stays the same

- All business logic
- All imports (repositories, services, APIs)
- All database access (Firestore, PostgreSQL, MongoDB, etc.)
- `console.log/warn/error` (auto-captured)
- File can stay in the same location

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `WORKER_DASHBOARD_PASSWORD` | Yes | Bull Board dashboard password |
| `GCLOUD_PROJECT` | Firebase only | Firebase project ID (needed by Firestore) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Firebase only | Path to Firebase credentials JSON |
| `DATABASE_URL` | PostgreSQL only | PostgreSQL connection string |
| `MONGODB_URI` | MongoDB only | MongoDB connection string |

## Directory structure (complete)

```
your-app/packages/functions/
├── worker.mjs                    # Worker entry point
├── worker.config.yml             # Job definitions + Redis config
├── src/
│   ├── jobs/
│   │   ├── functions/
│   │   │   ├── index.js          # Register all function handlers
│   │   │   ├── myJob.js
│   │   │   └── anotherJob.js
│   │   └── cron/
│   │       ├── index.js          # Register all cron handlers
│   │       └── dailyCleanup.js
│   └── helpers/
│       └── worker/
│           └── workerClient.js   # dispatchJob() for backend use
```
