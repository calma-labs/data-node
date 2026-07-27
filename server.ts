import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BigQuery, Dataset } from '@google-cloud/bigquery';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import { fetchAllProtocolMetrics, fetchPlotData } from './src/fetchers/index.js';
import type { StandarizedMetric, PoolRow, SnapshotRow } from './src/types.js';


const PORT: number = Number(process.env.PORT) || 3000;
const POLL_MS = 5000;

const BQ_PROJECT: string = process.env.BIGQUERY_PROJECT_ID || 'calmal';
const BQ_DATASET: string = process.env.BIGQUERY_DATASET || 'lending_poc';
const BQ_SA: string = process.env.IMPERSONATE_SA || 'lending-poc@calmal.iam.gserviceaccount.com';

const htmlContent: Buffer = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

let latestData: { fetchedAt: string } | null = null;
const clients: Set<http.ServerResponse> = new Set();
const seenGenericPools: Set<string> = new Set();
let isPolling = false;

function formatSSE(data: unknown): string {
  return `event: update\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(data: unknown): void {
  const msg = formatSSE(data);
  for (const res of clients) {
    res.write(msg);
  }
}

function stableGenericPoolId(metric: StandarizedMetric): number {
  const key = `${metric.mintAddress}:${metric.lending}:${metric.market}`;
  return parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), 16);
}

async function commitGenericPool(ds: Dataset, metric: StandarizedMetric): Promise<void> {
  const key = `${metric.mintAddress}:${metric.lending}:${metric.market}`;
  if (seenGenericPools.has(key)) return;
  seenGenericPools.add(key);
  const id = stableGenericPoolId(metric);
  try {
    const row: PoolRow = {
      id,
      reservePubkey: metric.mintAddress,
      symbol: metric.symbol,
      mintAddress: metric.mintAddress,
      lending: metric.lending,
      chain: metric.chain,
      market: metric.market,
    };
    await ds.table('pool').insert([row]);
    console.log(`[bq] registered generic pool ${key} → id ${id}`);
  } catch (err) {
    seenGenericPools.delete(key);
    throw err;
  }
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

async function commitGenericSnapshot(ds: Dataset, metric: StandarizedMetric): Promise<void> {
  const tvl = safeNum(metric.tvl);
  const utilF = safeNum(metric.utilization) / 100;
  const borrow = parseFloat((tvl * utilF).toFixed(9));
  const liquid = parseFloat((tvl - borrow).toFixed(9));
  const row: SnapshotRow = {
    poolId: stableGenericPoolId(metric),
    tvl: String(tvl),
    utilization: String(utilF.toFixed(9)),
    supplyAPY: String(safeNum(metric.supplyAPY)),
    borrowRate: String(safeNum(metric.borrowRate)),
    borrowAPY: String(safeNum(metric.borrowAPY)),
    totalBorrowUsd: String(borrow),
    liquidityUsd: String(liquid),
    fetchedAt: new Date().toISOString(),
  };
  await ds.table('snapshots').insert([row]);
}

async function pollProtocols(ds: Dataset): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const metrics = await fetchAllProtocolMetrics();
    console.log(`[protocols] fetched ${metrics.length} metrics`);
    latestData = { fetchedAt: new Date().toISOString() };
    broadcast(latestData);
    for (const metric of metrics) {
      commitGenericPool(ds, metric).catch((err: Error) => console.error('[bq:generic:pool]', err.message));
      commitGenericSnapshot(ds, metric).catch((err: Error) => console.error('[bq:generic:snapshot]', err.message));
    }
  } catch (err) {
    console.error('[protocols] poll error:', (err as Error).message);
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

function handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
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

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
  } else if (req.method === 'GET' && pathname === '/events') {
    handleSSE(req, res);
  } else if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lastFetchedAt: latestData?.fetchedAt ?? null }));
  } else if (req.method === 'GET' && (pathname === '/chart' || pathname === '/api/chart')) {
    const protocol = urlObj.searchParams.get('protocol') || urlObj.searchParams.get('platform') || '';
    const symbol = urlObj.searchParams.get('symbol') || urlObj.searchParams.get('asset') || '';
    const collateral = urlObj.searchParams.get('collateral') || undefined;

    if (!protocol || !symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing protocol or symbol parameter' }));
      return;
    }

    fetchPlotData(protocol, symbol, collateral)
      .then((data) => {
        if (!data || (data.history.length === 0 && !data.poolId)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ history: [], poolId: null, source: null }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(data));
      })

      .catch((err: Error) => {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: err.message }));
      });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
}


async function main(): Promise<void> {
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

  const ds: Dataset = bigquery.dataset(BQ_DATASET);
  const server = http.createServer(requestHandler);

  server.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    pollProtocols(ds);
    setInterval(() => pollProtocols(ds), POLL_MS);
    if (process.send) process.send('ready');
  });

  function shutdown(): void {
    for (const res of clients) res.end();
    clients.clear();
    server.close(() => process.exit(0));
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: Error) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
