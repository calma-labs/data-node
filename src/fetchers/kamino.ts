import type { StandarizedMetric, KaminoReserveMetric, KaminoMarketConfig } from '../types.js';

const KAMINO_API = 'https://api.kamino.finance';
const MARKETS_URL = `${KAMINO_API}/v2/kamino-market`;

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
