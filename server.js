'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BigQuery } = require('@google-cloud/bigquery');
const { GoogleAuth, Impersonated } = require('google-auth-library');

function stablePoolId(reservePubkey) {
  return parseInt(crypto.createHash('sha256').update(reservePubkey).digest('hex').slice(0, 8), 16);
}

const PORT = process.env.PORT || 3000;
const POLL_MS = 5000;
const MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const RESERVES_URL =
  `https://api.kamino.finance/kamino-market/${MARKET}/reserves/metrics`;

const BQ_PROJECT = process.env.BIGQUERY_PROJECT_ID || 'calmal';
const BQ_DATASET = process.env.BIGQUERY_DATASET    || 'lending_poc';
const BQ_SA      = process.env.IMPERSONATE_SA      || 'lending-poc@calmal.iam.gserviceaccount.com';

const htmlContent = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

let latestData = null;
const clients = new Set();
const seenPools = new Set();

function formatSSE(data) {
  return `event: update\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(data) {
  const msg = formatSSE(data);
  for (const res of clients) {
    res.write(msg);
  }
}

async function commitPool(ds, usdc) {
  const reservePubkey = usdc.reserve;
  if (seenPools.has(reservePubkey)) return;

  const id = stablePoolId(reservePubkey);

  await ds.table('pool').insert([{
    id,
    reservePubkey,
    symbol:      usdc.liquidityToken,
    mintAddress: usdc.liquidityTokenMint,
    lending:     'Kamino',
    chain:       'Solana',
    market:      MARKET,
  }]);

  seenPools.add(reservePubkey);
  console.log(`[bq] registered pool ${reservePubkey} → id ${id}`);
}

async function commitSnapshot(ds, usdc) {
  // Use raw API strings for NUMERIC fields to preserve full precision.
  // Derived fields (utilization, liquidityUsd) are computed in float
  // only for the ratio/difference — precision loss there is immaterial.
  const supplyF = parseFloat(usdc.totalSupplyUsd);
  const borrowF = parseFloat(usdc.totalBorrowUsd);

  await ds.table('snapshots').insert([{
    poolId:         stablePoolId(usdc.reserve),
    tvl:            usdc.totalSupplyUsd,
    utilization:    supplyF > 0 ? Math.min(borrowF / supplyF, 1).toFixed(9) : '0',
    supplyAPY:      usdc.supplyApy,
    borrowRate:     usdc.borrowApy,
    borrowAPY:      usdc.borrowApy,
    totalBorrowUsd: usdc.totalBorrowUsd,
    liquidityUsd:   (supplyF - borrowF).toFixed(9),
    fetchedAt:      new Date().toISOString(),
  }]);
}

async function fetchUSDC(ds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(RESERVES_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reserves = await response.json();

    const usdcReserves = reserves.filter(r => r.liquidityToken === 'USDC');
    if (usdcReserves.length === 0) throw new Error('No USDC reserve found');

    // Pick the reserve with the largest total supply (the main one)
    const usdc = usdcReserves.reduce((best, r) =>
      parseFloat(r.totalSupplyUsd) > parseFloat(best.totalSupplyUsd) ? r : best
    );

    const totalSupplyUsd = parseFloat(usdc.totalSupplyUsd);
    const totalBorrowUsd = parseFloat(usdc.totalBorrowUsd);

    latestData = {
      reservePubkey:  usdc.reserve,
      supplyApy:      parseFloat(usdc.supplyApy),
      borrowApy:      parseFloat(usdc.borrowApy),
      totalSupplyUsd,
      totalBorrowUsd,
      utilizationRate: totalSupplyUsd > 0 ? Math.min(totalBorrowUsd / totalSupplyUsd, 1) : 0,
      liquidityUsd:    totalSupplyUsd - totalBorrowUsd,
      fetchedAt:       new Date().toISOString(),
    };

    broadcast(latestData);

    commitPool(ds, usdc).catch(err => console.error('[bq:pool]', err.message));
    commitSnapshot(ds, usdc).catch(err => console.error('[bq:snapshots]', err.message));
  } finally {
    clearTimeout(timer);
  }
}

function startPolling(ds) {
  fetchUSDC(ds).catch(err => console.error('[init]', err.message));
  setInterval(() => {
    fetchUSDC(ds).catch(err => console.error('[poll]', err.message));
  }, POLL_MS);
}

// Heartbeat keeps SSE connections alive through proxies
setInterval(() => {
  for (const res of clients) {
    res.write(':heartbeat\n\n');
  }
}, 30_000);

function handleSSE(req, res) {
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
    startPolling(ds);
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
