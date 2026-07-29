import { DefiLlama } from '@defillama/api';
import type { TokenHistoryPoint, TokenDataResult } from '../types.js';

const MIN_TVL = 1_000;

const llamaClient = new DefiLlama();

const PROTOCOL_SLUGS: Record<string, string[]> = {
  save: ['save', 'solend'],
  kamino: ['kamino-lend'],
  jupiter: ['jupiter-lend'],
  marginfi: ['marginfi'],
};

export function symbolMatches(poolSymbol: string, target: string): boolean {
  const normalizedPool = poolSymbol
    .replace(/\s*\(.*?\)/g, '')
    .replace(/-[A-Z0-9]+$/, '')
    .trim()
    .toUpperCase();
  const normalizedTarget = target.toUpperCase();
  return normalizedPool === normalizedTarget || normalizedPool === `W${normalizedTarget}`;
}

export function downsampleToDaily<T>(
  points: T[],
  getTimestamp: (p: T) => number,
  mapPoint: (p: T, dateKey: string) => TokenHistoryPoint,
): TokenHistoryPoint[] {
  const dailyMap = new Map<string, T>();

  for (const p of points) {
    const dateKey = new Date(getTimestamp(p) * 1000).toISOString().split('T')[0];
    dailyMap.set(dateKey, p);
  }

  return Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, p]) => mapPoint(p, dateKey));
}

export async function fetchProtocolTotalActiveLoansFromDefiLlama(platform: string): Promise<number | null> {
  try {
    let slug = platform.toLowerCase();
    if (slug === 'jupiter') slug = 'jup-lend';
    if (slug === 'marginfi') slug = 'marginfi';

    const data = await llamaClient.tvl.getProtocol(slug) as {
      currentChainTvls?: {
        borrowed?: unknown;
      };
    };

    if (
      data &&
      data.currentChainTvls &&
      typeof data.currentChainTvls.borrowed === 'number'
    ) {
      return data.currentChainTvls.borrowed;
    }
    return null;
  } catch {
    return null;
  }
}

interface DefiLlamaPool {
  pool: string;
  project: string;
  chain: string;
  symbol?: string;
  tvlUsd?: number;
  apyBase?: number;
  apyReward?: number;
  apyBaseBorrow?: number;
  utilization?: number;
}

interface DefiLlamaChartEntry {
  timestamp: string;
  apyBase?: number;
  apyReward?: number;
  utilization?: number;
}

export async function fetchDefiLlamaPlot(
  platform: string,
  asset: string,
  _collateral?: string,
): Promise<TokenDataResult | null> {
  try {
    const targetSlugs = PROTOCOL_SLUGS[platform] ?? [platform];

    const poolsRes = await fetch('https://yields.llama.fi/pools');
    if (!poolsRes.ok) return null;

    const poolsJson = (await poolsRes.json()) as { data?: DefiLlamaPool[] };
    const pools = poolsJson.data ?? [];

    const tokenPools = targetSlugs
      .flatMap((slug) =>
        pools.filter((p) => {
          if (p.project !== slug || p.chain !== 'Solana') return false;
          const poolSymbol = (p.symbol || '').toUpperCase();
          return symbolMatches(poolSymbol, asset) && (p.tvlUsd ?? 0) > MIN_TVL;
        }),
      )
      .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));

    const tokenPool = tokenPools[0] ?? null;
    if (!tokenPool) return null;

    const chartRes = await fetch(`https://yields.llama.fi/chart/${tokenPool.pool}`);
    if (!chartRes.ok) return null;

    const chartJson = (await chartRes.json()) as { data?: DefiLlamaChartEntry[] };
    if (!chartJson.data?.length) return null;

    const history = chartJson.data
      .filter((entry) => entry.timestamp && entry.apyBase !== undefined)
      .map((entry) => ({
        date: entry.timestamp,
        apy: parseFloat(((entry.apyBase ?? 0) + (entry.apyReward ?? 0)).toFixed(2)),
        utilization:
          entry.utilization !== undefined
            ? parseFloat(entry.utilization.toFixed(2))
            : null,
      }));

    return {
      history,
      poolId: tokenPool.pool,
      source: tokenPool.project,
      matchedSymbol: tokenPool.symbol ?? asset,
      snapshot: {
        tvl: Math.round(tokenPool.tvlUsd ?? 0),
        supplyAPY: parseFloat(((tokenPool.apyBase ?? 0) + (tokenPool.apyReward ?? 0)).toFixed(2)),
        borrowRate: parseFloat((tokenPool.apyBaseBorrow ?? 0).toFixed(2)),
        utilization: parseFloat((tokenPool.utilization ?? 0).toFixed(2)),
      },
    };
  } catch {
    return null;
  }
}
