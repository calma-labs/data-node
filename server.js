'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BigQuery } = require('@google-cloud/bigquery');
const { GoogleAuth, Impersonated } = require('google-auth-library');
const { fetchAllProtocolMetrics } = require('./fetchers');


const PORT = process.env.PORT || 3000;
const POLL_MS = 5000;

const BQ_PROJECT = process.env.BIGQUERY_PROJECT_ID || 'calmal';
const BQ_DATASET = process.env.BIGQUERY_DATASET    || 'lending_poc';
const BQ_SA      = process.env.IMPERSONATE_SA      || 'lending-poc@calmal.iam.gserviceaccount.com';

const htmlContent = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

let latestData = null;
const clients = new Set();
const seenGenericPools = new Set();
let isPolling = false;

function formatSSE(data) {
  return `event: update\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(data) {
  const msg = formatSSE(data);
  for (const res of clients) {
    res.write(msg);
  }
}

function stableGenericPoolId(metric) {
  const key = `${metric.mintAddress}:${metric.lending}:${metric.market}`;
  return parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), 16);
}

async function commitGenericPool(ds, metric) {
  const key = `${metric.mintAddress}:${metric.lending}:${metric.market}`;
  if (seenGenericPools.has(key)) return;
  seenGenericPools.add(key);
  const id = stableGenericPoolId(metric);
  try {
    await ds.table('pool').insert([{
      id,
      reservePubkey: metric.mintAddress,
      symbol:        metric.symbol,
      mintAddress:   metric.mintAddress,
      lending:       metric.lending,
      chain:         metric.chain,
      market:        metric.market,
    }]);
    console.log(`[bq] registered generic pool ${key} → id ${id}`);
  } catch (err) {
    seenGenericPools.delete(key);
    throw err;
  }
}

function safeNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

async function commitGenericSnapshot(ds, metric) {
  const tvl   = safeNum(metric.tvl);
  const utilF = safeNum(metric.utilization) / 100;
  const borrow  = parseFloat((tvl * utilF).toFixed(9));
  const liquid  = parseFloat((tvl - borrow).toFixed(9));
  await ds.table('snapshots').insert([{
    poolId:          stableGenericPoolId(metric),
    tvl:             String(tvl),
    utilization:     String(utilF.toFixed(9)),
    supplyAPY:       String(safeNum(metric.supplyAPY)),
    borrowRate:      String(safeNum(metric.borrowRate)),
    borrowAPY:       String(safeNum(metric.borrowAPY)),
    totalBorrowUsd:  String(borrow),
    liquidityUsd:    String(liquid),
    fetchedAt:       new Date().toISOString(),
  }]);
}

async function pollProtocols(ds) {
  if (isPolling) return;
  isPolling = true;
  try {
    const metrics = await fetchAllProtocolMetrics();
    console.log(`[protocols] fetched ${metrics.length} metrics`);
    for (const metric of metrics) {
      commitGenericPool(ds, metric).catch(err => console.error('[bq:generic:pool]', err.message));
      commitGenericSnapshot(ds, metric).catch(err => console.error('[bq:generic:snapshot]', err.message));
    }
  } catch (err) {
    console.error('[protocols] poll error:', err.message);
  } finally {
    isPolling = false;
  }
}

// Heartbeat keeps SSE connections alive through proxies
setInterval(() => {
  for (const res of clients) {
    res.write(':heartbeat\n\n');
  }
}, 30_000);

function handleSSE(req, res) {
  if (clients.size >= 100) {
    res.writeHead(503, { 'Retry-After': '10' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  if (latestData !== null) {
    res.write(formatSSE(latestData));
  }

  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function requestHandler(req, res) {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  } else if (req.method === 'GET' && req.url === '/events') {
    handleSSE(req, res);
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lastFetchedAt: latestData?.fetchedAt ?? null }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function main() {
  const base = new GoogleAuth();
  const sourceClient = await base.getClient();

  const impersonated = new Impersonated({
    sourceClient,
    targetPrincipal: BQ_SA,
    lifetime: 3600,
    targetScopes: ['https://www.googleapis.com/auth/bigquery'],
  });

  const bigquery = new BigQuery({ projectId: BQ_PROJECT, authClient: impersonated });
  console.log(`[bq] impersonating ${BQ_SA}`);

  const ds = bigquery.dataset(BQ_DATASET);
  const server = http.createServer(requestHandler);

  server.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    pollProtocols(ds);
    setInterval(() => pollProtocols(ds), POLL_MS);
    if (process.send) process.send('ready');
  });

  function shutdown() {
    for (const res of clients) res.end();
    clients.clear();
    server.close(() => process.exit(0));
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

main().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
