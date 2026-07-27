import type {
  StandarizedMetric,
  KaminoReserveMetric,
  KaminoMarketConfig,
  TokenDataResult,
  TokenHistoryPoint,
  TokenSnapshot,
} from '../types.js';
import { symbolMatches } from './defillama.js';

const KAMINO_API = 'https://api.kamino.finance';
const MARKETS_URL = `${KAMINO_API}/v2/kamino-market`;

interface KaminoHistoryMetrics {
  supplyInterestAPY: number;
  borrowInterestAPY: number;
  depositTvl: string;
  borrowTvl: string;
}
interface KaminoHistoryEntry {
  timestamp: string;
  metrics: KaminoHistoryMetrics;
}
interface KaminoHistoryResponse {
  reserve: string;
  history: KaminoHistoryEntry[];
}

async function fetchMarketConfigs(): Promise<KaminoMarketConfig[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(MARKETS_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<KaminoMarketConfig[]>;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMarketReserves(lendingMarket: string): Promise<KaminoReserveMetric[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `${KAMINO_API}/kamino-market/${lendingMarket}/reserves/metrics`,
      { signal: controller.signal },
    );
    if (!res.ok) return [];
    return await res.json() as KaminoReserveMetric[];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchKaminoMetrics(): Promise<StandarizedMetric[]> {
  const configs = await fetchMarketConfigs();

  const results = await Promise.allSettled(
    configs.map(async (config): Promise<StandarizedMetric[]> => {
      const reserves = await fetchMarketReserves(config.lendingMarket);
      const marketName = config.name || 'isolated';

      return reserves
        .filter((r) => parseFloat(r.totalSupplyUsd) > 100_000)
        .map((r): StandarizedMetric => {
          const totalSupplyUsd = parseFloat(r.totalSupplyUsd);
          const totalBorrowUsd = parseFloat(r.totalBorrowUsd);
          const utilization = totalSupplyUsd > 0
            ? parseFloat((Math.min(totalBorrowUsd / totalSupplyUsd, 1) * 100).toFixed(2))
            : 0;

          return {
            symbol: r.liquidityToken,
            mintAddress: r.liquidityTokenMint,
            tvl: totalSupplyUsd,
            supplyAPY: parseFloat((parseFloat(r.supplyApy) * 100).toFixed(2)),
            borrowRate: parseFloat((parseFloat(r.borrowApy) * 100).toFixed(2)),
            borrowAPY: parseFloat(((Math.exp(parseFloat(r.borrowApy)) - 1) * 100).toFixed(2)),
            utilization,
            lending: 'kamino',
            market: marketName,
            chain: 'Solana',
          };
        });
    }),
  );

  const metrics: StandarizedMetric[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      metrics.push(...result.value);
    }
  }
  return metrics;
}

export async function fetchKaminoPlot(
  symbol: string,
  _collateral?: string,
): Promise<TokenDataResult | null> {
  const configs = await fetchMarketConfigs();

  const candidates: {
    market: string;
    reserve: KaminoReserveMetric;
  }[] = [];

  await Promise.all(
    configs.map(async (config) => {
      const reserves = await fetchMarketReserves(config.lendingMarket);
      for (const r of reserves) {
        if (symbolMatches(r.liquidityToken, symbol)) {
          candidates.push({ market: config.lendingMarket, reserve: r });
        }
      }
    }),
  );

  candidates.sort(
    (a, b) =>
      parseFloat(b.reserve.totalSupplyUsd) - parseFloat(a.reserve.totalSupplyUsd),
  );

  const best = candidates[0];
  if (!best) return null;

  const now = Math.floor(Date.now() / 1000);
  const start = now - 400 * 24 * 60 * 60;

  let history: TokenHistoryPoint[] = [];
  try {
    const res = await fetch(
      `${KAMINO_API}/kamino-market/${best.market}/reserves/${best.reserve.reserve}/metrics/history?env=mainnet-beta&frequency=day&start=${start}&end=${now}`,
    );
    if (res.ok) {
      const historyJson = (await res.json()) as KaminoHistoryResponse;
      const entries = historyJson.history ?? [];
      history = entries
        .filter((e) => e.timestamp && e.metrics?.supplyInterestAPY !== undefined)
        .map((e) => {
          const depositTvl = parseFloat(e.metrics.depositTvl || '0');
          const borrowTvl = parseFloat(e.metrics.borrowTvl || '0');
          const utilization = depositTvl > 0 ? (borrowTvl / depositTvl) * 100 : 0;
          return {
            date: e.timestamp,
            apy: parseFloat((e.metrics.supplyInterestAPY * 100).toFixed(2)),
            utilization: parseFloat(utilization.toFixed(2)),
          };
        });
    }
  } catch {
  }

  const totalSupply = parseFloat(best.reserve.totalSupply || '0');
  const totalBorrow = parseFloat(best.reserve.totalBorrow || '0');
  const utilization = totalSupply > 0 ? (totalBorrow / totalSupply) * 100 : 0;

  const snapshot: TokenSnapshot = {
    tvl: Math.round(parseFloat(best.reserve.totalSupplyUsd || '0')),
    supplyAPY: parseFloat((parseFloat(best.reserve.supplyApy) * 100).toFixed(2)),
    borrowRate: parseFloat((parseFloat(best.reserve.borrowApy) * 100).toFixed(2)),
    utilization: parseFloat(utilization.toFixed(2)),
  };

  return {
    history,
    poolId: best.reserve.reserve,
    source: 'kamino',
    matchedSymbol: best.reserve.liquidityToken,
    snapshot,
  };
}

