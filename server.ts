import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import { fetchAllProtocolMetrics, fetchPlotData } from './src/fetchers/index.js';
import type { StandarizedMetric, TokenDataResult } from './src/types.js';


const PORT: number = Number(process.env.PORT) || 3000;
const POLL_MS = 300_000;

const BQ_PROJECT: string = process.env.BIGQUERY_PROJECT_ID || 'calmal';
const BQ_DATASET: string = process.env.BIGQUERY_DATASET || 'lending_poc';
const BQ_SA: string = process.env.IMPERSONATE_SA || 'lending-poc@calmal.iam.gserviceaccount.com';

const htmlContent: Buffer = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

type TableData = {
  protocol: string;
  symbol: string;
  market: string;
  collateral: string | null;
  supplyApy: number;
  borrowApy: number;
  utilizationRate: number;
  totalSupplyUsd: number;
  totalBorrowUsd: number;
  liquidityUsd: number;
  fetchedAt: string;
  isAggregated: boolean;
};
const latestMetricsCache = new Map<string, TableData>();
let latestData: TableData[] | null = null;
const clients: Set<http.ServerResponse> = new Set();
let isPolling = false;
const knownPools = new Set<number>();
let globalBQ: BigQuery | null = null;
let lastFetchedAt: string | null = null;

async function initKnownPools(bq: BigQuery): Promise<void> {
  try {
    const [rows] = await bq.query({
      query: `SELECT id FROM \`${BQ_PROJECT}.${BQ_DATASET}.pool\``
    }) as unknown as [Array<{ id: number }>];
    for (const row of rows) {
      if (row.id != null) {
        knownPools.add(Number(row.id));
      }
    }
    console.log(`[bq] loaded ${knownPools.size} known pools from database`);
  } catch (err) {
    console.warn(`[bq] could not load known pools: ${(err as Error).message}`);
  }
}

function formatSSE(data: unknown): string {
  return `event: update\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(data: unknown): void {
  const msg = formatSSE(data);
  for (const res of clients) {
    if (res.writableLength > 1024 * 1024) {
      console.warn('[sse] client buffer full, dropping connection');
      res.destroy();
      clients.delete(res);
      continue;
    }
    res.write(msg);
  }
}

function stableGenericPoolId(metric: StandarizedMetric): number {
  const key = `${metric.mintAddress}:${metric.lending}:${metric.market}:${metric.collateral || ''}:${metric.isAggregated ? '1' : '0'}`;
  return parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 13), 16);
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

async function batchCommitPools(bq: BigQuery, metrics: StandarizedMetric[]): Promise<void> {
  if (metrics.length === 0) return;

  const newMetrics = metrics.filter(m => !knownPools.has(stableGenericPoolId(m)));
  if (newMetrics.length === 0) return;

  const rows = newMetrics.map(m => ({
    id: stableGenericPoolId(m),
    reservePubkey: m.mintAddress,
    symbol: m.symbol,
    mintAddress: m.mintAddress,
    lending: m.lending,
    chain: m.chain,
    market: m.market,
    collateral: m.collateral || null,
    isAggregated: m.isAggregated || false
  }));

  try {
    await bq.dataset(BQ_DATASET).table('pool').insert(rows);
    for (const m of newMetrics) {
      knownPools.add(stableGenericPoolId(m));
    }
  } catch (err) {
    console.error(`[bq] failed to insert pools:`, err);
  }
}

async function batchCommitSnapshots(bq: BigQuery, metrics: StandarizedMetric[], fetchedAt: string): Promise<void> {
  if (metrics.length === 0) return;

  const rows = metrics.map(m => {
    const poolId = stableGenericPoolId(m);
    const tvl = safeNum(m.tvl);
    const utilF = safeNum(m.utilization) / 100;
    const borrow = parseFloat((tvl * utilF).toFixed(9));
    const liquid = parseFloat((tvl - borrow).toFixed(9));

    return {
      poolId,
      tvl,
      utilization: parseFloat(utilF.toFixed(9)),
      supplyAPY: safeNum(m.supplyAPY),
      borrowRate: safeNum(m.borrowRate),
      borrowAPY: safeNum(m.borrowAPY),
      totalBorrowUsd: borrow,
      liquidityUsd: liquid,
      fetchedAt: bq.timestamp(new Date(fetchedAt))
    };
  });

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    try {
      await bq.dataset(BQ_DATASET).table('snapshots').insert(chunk);
    } catch (err) {
      if (err && (err as any).name === 'PartialFailureError') {
        console.error(`[bq] Partial insert failures:`, JSON.stringify((err as any).errors, null, 2));
      } else {
        console.error(`[bq] failed to insert snapshots:`, err);
      }
    }
  }
}

function isMetricSafe(m: StandarizedMetric): boolean {
  if (m.tvl < 0 || m.tvl > 1_000_000_000_000) return false;
  if (m.utilization < 0 || m.utilization > 100) return false;
  if (m.supplyAPY < 0 || m.supplyAPY > 1_000_000) return false;
  if (m.borrowRate < 0 || m.borrowRate > 1_000_000) return false;
  return true;
}

async function pollProtocols(bq: BigQuery | null, enableDebugDump: boolean = true): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const metrics = await fetchAllProtocolMetrics();
    console.log(`[protocols] fetched ${metrics.length} metrics`);
    
    const now = new Date();
    
    const safeMetrics = metrics.filter(isMetricSafe);
    const isoNow = now.toISOString();

    for (const m of safeMetrics) {
      const tvl = safeNum(m.tvl);
      const utilF = safeNum(m.utilization) / 100;
      const borrow = parseFloat((tvl * utilF).toFixed(9));
      const liquid = parseFloat((tvl - borrow).toFixed(9));
      
      const key = `${m.mintAddress}:${m.lending}:${m.market}:${m.collateral || ''}:${m.isAggregated ? '1' : '0'}`;
      
      latestMetricsCache.set(key, {
        protocol: m.lending,
        symbol: m.symbol,
        market: m.market,
        collateral: m.collateral || null,
        supplyApy: safeNum(m.supplyAPY),
        borrowApy: safeNum(m.borrowAPY),
        utilizationRate: utilF,
        totalSupplyUsd: tvl,
        totalBorrowUsd: borrow,
        liquidityUsd: liquid,
        fetchedAt: isoNow,
        isAggregated: m.isAggregated || false
      });
    }

    latestData = Array.from(latestMetricsCache.values());
    lastFetchedAt = isoNow;
    broadcast(latestData);
    
    if (enableDebugDump) {
      const dumpPath = path.join(process.cwd(), 'debug_data.json');
      fs.writeFileSync(dumpPath, JSON.stringify({
        fetchedAt: isoNow,
        totalMetrics: safeMetrics.length,
        data: safeMetrics
      }, null, 2));
      console.log(`[debug] Saved ${safeMetrics.length} metrics to ${dumpPath}`);
    }
    
    if (safeMetrics.length > 0 && bq) {
      await batchCommitPools(bq, safeMetrics);
      console.log(`[bq] batch merged pools`);
      
      await batchCommitSnapshots(bq, safeMetrics, isoNow);
      console.log(`[bq] inserted ${safeMetrics.length} snapshots at ${isoNow}`);
    } else if (safeMetrics.length > 0 && !bq) {
      console.log(`[warning] Database disabled. Skipped BigQuery insert for ${safeMetrics.length} snapshots.`);
    }
  } catch (err) {
    console.error('[protocols] poll error:', (err as Error).message);
  } finally {
    isPolling = false;
  }
}


async function queryBigQueryLatest(bq: BigQuery, protocol: string, symbol: string, isAggregated: boolean): Promise<TokenDataResult | null> {
  const query = `
    WITH DeduplicatedSnapshots AS (
      SELECT s.*, p.lending, p.symbol, p.isAggregated
      FROM \`${BQ_PROJECT}.${BQ_DATASET}.pool\` p
      JOIN \`${BQ_PROJECT}.${BQ_DATASET}.snapshots\` s ON p.id = s.poolId
      WHERE LOWER(p.lending) = LOWER(@protocol) 
        AND LOWER(p.symbol) = LOWER(@symbol)
        AND p.isAggregated = @isAggregated
      QUALIFY ROW_NUMBER() OVER (PARTITION BY s.poolId, s.fetchedAt ORDER BY s.fetchedAt DESC) = 1
    )
    SELECT 
      UNIX_SECONDS(fetchedAt) AS date,
      SUM(tvl) AS tvlUsd,
      AVG(supplyAPY) AS supplyAPY,
      AVG(utilization) AS utilization,
      AVG(borrowRate) AS borrowRate,
      AVG(borrowAPY) AS borrowAPY
    FROM DeduplicatedSnapshots
    GROUP BY fetchedAt
    ORDER BY fetchedAt ASC
    LIMIT 1000
  `;
  
  const [rows] = await bq.query({
    query,
    params: { protocol, symbol, isAggregated }
  }) as unknown as [Array<{ date: number; tvlUsd: number; supplyAPY: number; utilization: number | null; borrowRate: number | null; borrowAPY: number | null; }>];
  
  if (!rows || rows.length === 0) return null;
  
  const history = rows.map(r => ({
    date: new Date(Number(r.date) * 1000).toISOString(),
    apy: Number(r.supplyAPY),
    utilization: r.utilization !== null ? Number(r.utilization) * 100 : null
  }));
  
  const latest = rows[rows.length - 1];
  const snapshot = {
    tvl: Number(latest.tvlUsd || 0),
    supplyAPY: Number(latest.supplyAPY || 0),
    borrowRate: Number(latest.borrowRate || 0),
    borrowAPY: Number(latest.borrowAPY || 0),
    utilization: latest.utilization !== null ? Number(latest.utilization) * 100 : 0
  };
  
  return {
    source: "BigQuery",
    poolId: null,
    matchedSymbol: symbol,
    history,
    snapshot
  };
}

setInterval(() => {
  for (const res of clients) {
    if (res.writableLength > 1024 * 1024) {
      res.destroy();
      clients.delete(res);
      continue;
    }
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
  res.on('error', () => clients.delete(res));
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
    res.end(JSON.stringify({ status: 'ok', lastFetchedAt }));
  } else if (req.method === 'GET' && (pathname === '/chart' || pathname === '/api/chart')) {
    const protocol = urlObj.searchParams.get('protocol') || urlObj.searchParams.get('platform') || '';
    const symbol = urlObj.searchParams.get('symbol') || urlObj.searchParams.get('asset') || '';
    const collateral = urlObj.searchParams.get('collateral') || undefined;
    const isAggregatedStr = urlObj.searchParams.get('isAggregated');
    const isAggregated = isAggregatedStr !== 'false' && isAggregatedStr !== '0';

    if (!protocol || !symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing protocol or symbol parameter' }));
      return;
    }

    const fetchPromise = globalBQ 
      ? queryBigQueryLatest(globalBQ, protocol, symbol, isAggregated).then(data => data || fetchPlotData(protocol, symbol, collateral))
      : fetchPlotData(protocol, symbol, collateral);

    fetchPromise
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
  let bigquery: BigQuery | null = null;

  try {
    const base = new GoogleAuth();
    const sourceClient = await base.getClient();

    const impersonated = new Impersonated({
      sourceClient,
      targetPrincipal: BQ_SA,
      lifetime: 3600,
      targetScopes: ['https://www.googleapis.com/auth/bigquery'],
    });

    bigquery = new BigQuery({ projectId: BQ_PROJECT, authClient: impersonated });
    console.log(`[bq] impersonating ${BQ_SA}`);
    globalBQ = bigquery;
    await initKnownPools(bigquery);
  } catch (err) {
    console.warn(`[warning] Could not load Google credentials. Running in local dry-run mode. Error: ${(err as Error).message}`);
  }

  const server = http.createServer(requestHandler);

  server.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    pollProtocols(bigquery, true);
    setInterval(() => pollProtocols(bigquery, true), POLL_MS);
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
