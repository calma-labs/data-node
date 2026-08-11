import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BigQuery, Dataset } from '@google-cloud/bigquery';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import { fetchAllProtocolMetrics, fetchPlotData } from './src/fetchers/index.js';
import type { StandarizedMetric, PoolRow, SnapshotRow } from './src/types.js';


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

const BUCKET_SECONDS = 300;

function timeBucket(date: Date): string {
  const epoch = Math.floor(date.getTime() / 1000);
  const bucket = epoch - (epoch % BUCKET_SECONDS);
  return new Date(bucket * 1000).toISOString();
}

function stableSnapshotId(poolId: number, bucketTimestamp: string): string {
  return crypto.createHash('sha256')
    .update(`${poolId}::${bucketTimestamp}`)
    .digest('hex')
    .slice(0, 16);
}

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
  const key = `${metric.mintAddress}:${metric.lending}:${metric.market}:${metric.collateral || ''}:${metric.isAggregated ? '1' : '0'}`;
  return parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), 16);
}


function safeNum(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

async function batchCommitPools(bq: BigQuery, metrics: StandarizedMetric[]): Promise<void> {
  if (metrics.length === 0) return;

  const newMetrics = metrics.filter(m => !knownPools.has(stableGenericPoolId(m)));
  if (newMetrics.length === 0) return;

  for (let i = 0; i < newMetrics.length; i += 100) {
    const chunk = newMetrics.slice(i, i + 100);
    const params: Record<string, unknown> = {};
    const selects = chunk.map((m, idx) => {
      const id = stableGenericPoolId(m);
      params[`id_${idx}`] = id;
      params[`rp_${idx}`] = m.mintAddress;
      params[`sym_${idx}`] = m.symbol;
      params[`ma_${idx}`] = m.mintAddress;
      params[`len_${idx}`] = m.lending;
      params[`ch_${idx}`] = m.chain;
      params[`mkt_${idx}`] = m.market;
      params[`col_${idx}`] = m.collateral || null;
      params[`agg_${idx}`] = m.isAggregated || false;
      return `SELECT @id_${idx} AS id, @rp_${idx} AS reservePubkey, @sym_${idx} AS symbol, @ma_${idx} AS mintAddress, @len_${idx} AS lending, @ch_${idx} AS chain, @mkt_${idx} AS market, @col_${idx} AS collateral, @agg_${idx} AS isAggregated`;
    }).join(' UNION ALL ');

    const query = `
      MERGE \`${BQ_PROJECT}.${BQ_DATASET}.pool\` AS target
      USING (${selects}) AS source
      ON target.id = source.id
      WHEN NOT MATCHED THEN
        INSERT (id, reservePubkey, symbol, mintAddress, lending, chain, market, collateral, isAggregated)
        VALUES (source.id, source.reservePubkey, source.symbol, source.mintAddress, source.lending, source.chain, source.market, source.collateral, source.isAggregated)
    `;

    await bq.query({ query, params });
    
    for (const m of chunk) {
      knownPools.add(stableGenericPoolId(m));
    }
  }
}

async function batchCommitSnapshots(bq: BigQuery, metrics: StandarizedMetric[], bucketTimestamp: string): Promise<void> {
  if (metrics.length === 0) return;

  for (let i = 0; i < metrics.length; i += 100) {
    const chunk = metrics.slice(i, i + 100);
    const params: Record<string, unknown> = {};
    const selects = chunk.map((m, idx) => {
      const poolId = stableGenericPoolId(m);
      const snapshotId = stableSnapshotId(poolId, bucketTimestamp);
      const tvl = safeNum(m.tvl);
      const utilF = safeNum(m.utilization) / 100;
      const borrow = parseFloat((tvl * utilF).toFixed(9));
      const liquid = parseFloat((tvl - borrow).toFixed(9));

      params[`sid_${idx}`] = snapshotId;
      params[`pid_${idx}`] = poolId;
      params[`tvl_${idx}`] = tvl;
      params[`uti_${idx}`] = parseFloat(utilF.toFixed(9));
      params[`sapy_${idx}`] = safeNum(m.supplyAPY);
      params[`br_${idx}`] = safeNum(m.borrowRate);
      params[`bapy_${idx}`] = safeNum(m.borrowAPY);
      params[`tbu_${idx}`] = borrow;
      params[`liq_${idx}`] = liquid;
      params[`fa_${idx}`] = bucketTimestamp;

      return `SELECT @sid_${idx} AS snapshotId, @pid_${idx} AS poolId, @tvl_${idx} AS tvl, @uti_${idx} AS utilization, @sapy_${idx} AS supplyAPY, @br_${idx} AS borrowRate, @bapy_${idx} AS borrowAPY, @tbu_${idx} AS totalBorrowUsd, @liq_${idx} AS liquidityUsd, CAST(@fa_${idx} AS TIMESTAMP) AS fetchedAt`;
    }).join(' UNION ALL ');

    const query = `
      MERGE \`${BQ_PROJECT}.${BQ_DATASET}.snapshots\` AS target
      USING (${selects}) AS source
      ON target.snapshotId = source.snapshotId
      WHEN MATCHED THEN
        UPDATE SET
          tvl = source.tvl, utilization = source.utilization, supplyAPY = source.supplyAPY,
          borrowRate = source.borrowRate, borrowAPY = source.borrowAPY,
          totalBorrowUsd = source.totalBorrowUsd, liquidityUsd = source.liquidityUsd,
          fetchedAt = source.fetchedAt
      WHEN NOT MATCHED THEN
        INSERT (snapshotId, poolId, tvl, utilization, supplyAPY, borrowRate,
                borrowAPY, totalBorrowUsd, liquidityUsd, fetchedAt)
        VALUES (source.snapshotId, source.poolId, source.tvl, source.utilization, source.supplyAPY, source.borrowRate,
                source.borrowAPY, source.totalBorrowUsd, source.liquidityUsd, source.fetchedAt)
    `;

    await bq.query({ query, params });
  }
}

function isMetricSafe(m: StandarizedMetric): boolean {
  if (m.tvl < 0 || m.tvl > 1_000_000_000_000) return false;
  if (m.utilization < 0 || m.utilization > 100) return false;
  if (m.supplyAPY < 0 || m.supplyAPY > 1_000_000) return false;
  if (m.borrowRate < 0 || m.borrowRate > 1_000_000) return false;
  return true;
}

async function pollProtocols(bq: BigQuery | null, ds: Dataset | null, enableDebugDump: boolean = true): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const metrics = await fetchAllProtocolMetrics();
    console.log(`[protocols] fetched ${metrics.length} metrics`);
    
    const now = new Date();
    const bucket = timeBucket(now);
    
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
    broadcast(latestData);
    
    if (enableDebugDump) {
      const dumpPath = path.join(process.cwd(), 'debug_data.json');
      fs.writeFileSync(dumpPath, JSON.stringify({
        bucketTimestamp: bucket,
        totalMetrics: safeMetrics.length,
        data: safeMetrics
      }, null, 2));
      console.log(`[debug] Saved ${safeMetrics.length} metrics to ${dumpPath}`);
    }
    
    if (safeMetrics.length > 0 && bq) {
      await batchCommitPools(bq, safeMetrics);
      console.log(`[bq] batch merged pools`);
      
      await batchCommitSnapshots(bq, safeMetrics, bucket);
      console.log(`[bq] batch merged ${safeMetrics.length} snapshots for bucket ${bucket}`);
    } else if (safeMetrics.length > 0 && !bq) {
      console.log(`[warning] Database disabled. Skipped BigQuery insert for ${safeMetrics.length} snapshots.`);
    }
  } catch (err) {
    console.error('[protocols] poll error:', (err as Error).message);
  } finally {
    isPolling = false;
  }
}

import type { TokenDataResult } from './src/types.js';

async function queryBigQueryLatest(bq: BigQuery, protocol: string, symbol: string): Promise<TokenDataResult | null> {
  const query = `
    SELECT 
      UNIX_SECONDS(s.fetchedAt) AS date,
      SUM(s.tvl) AS tvlUsd,
      AVG(s.supplyAPY) AS supplyAPY,
      AVG(s.utilization) AS utilization
    FROM \`${BQ_PROJECT}.${BQ_DATASET}.pool\` p
    JOIN \`${BQ_PROJECT}.${BQ_DATASET}.snapshots\` s ON p.id = s.poolId
    WHERE LOWER(p.lending) = LOWER(@protocol) 
      AND LOWER(p.symbol) = LOWER(@symbol)
      AND p.isAggregated = TRUE
    GROUP BY s.fetchedAt
    ORDER BY s.fetchedAt ASC
    LIMIT 1000
  `;
  
  const [rows] = await bq.query({
    query,
    params: { protocol, symbol }
  });
  
  if (!rows || rows.length === 0) return null;
  
  const history = rows.map(r => ({
    date: new Date(Number(r.date) * 1000).toISOString(),
    apy: Number(r.supplyAPY),
    utilization: r.utilization !== null ? Number(r.utilization) * 100 : null
  }));
  
  return {
    source: "BigQuery",
    poolId: null,
    matchedSymbol: symbol,
    history
  };
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
    res.end(JSON.stringify({ status: 'ok', lastFetchedAt: latestData?.[0]?.fetchedAt ?? null }));
  } else if (req.method === 'GET' && (pathname === '/chart' || pathname === '/api/chart')) {
    const protocol = urlObj.searchParams.get('protocol') || urlObj.searchParams.get('platform') || '';
    const symbol = urlObj.searchParams.get('symbol') || urlObj.searchParams.get('asset') || '';
    const collateral = urlObj.searchParams.get('collateral') || undefined;

    if (!protocol || !symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing protocol or symbol parameter' }));
      return;
    }

    const fetchPromise = globalBQ 
      ? queryBigQueryLatest(globalBQ, protocol, symbol).then(data => data || fetchPlotData(protocol, symbol, collateral))
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
  let ds: Dataset | null = null;

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
    ds = bigquery.dataset(BQ_DATASET);
    globalBQ = bigquery;
  } catch (err) {
    console.warn(`[warning] Could not load Google credentials. Running in local dry-run mode. Error: ${(err as Error).message}`);
  }

  const server = http.createServer(requestHandler);

  server.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    // Change to 'true' to enable local JSON debug dumping without BQ credentials
    pollProtocols(bigquery, ds, true);
    setInterval(() => pollProtocols(bigquery, ds, true), POLL_MS);
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
