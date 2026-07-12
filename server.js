'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const POLL_MS = 5000;
const RESERVES_URL =
  'https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/metrics';

const htmlContent = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

let latestData = null;
const clients = new Set();

function formatSSE(data) {
  return `event: update\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(data) {
  const msg = formatSSE(data);
  for (const res of clients) {
    res.write(msg);
  }
}

async function fetchUSDC() {
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
    const utilizationRate = totalSupplyUsd > 0
      ? Math.min(totalBorrowUsd / totalSupplyUsd, 1)
      : 0;

    latestData = {
      reservePubkey: usdc.reserve,
      supplyApy: parseFloat(usdc.supplyApy),
      borrowApy: parseFloat(usdc.borrowApy),
      totalSupplyUsd,
      totalBorrowUsd,
      utilizationRate,
      liquidityUsd: totalSupplyUsd - totalBorrowUsd,
      fetchedAt: new Date().toISOString(),
    };

    broadcast(latestData);
  } finally {
    clearTimeout(timer);
  }
}

function startPolling() {
  fetchUSDC().catch(err => console.error('[init]', err.message));
  setInterval(() => {
    fetchUSDC().catch(err => console.error('[poll]', err.message));
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

const server = http.createServer(requestHandler);

server.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
  startPolling();
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
