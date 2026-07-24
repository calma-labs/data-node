'use strict';

const KAMINO_API  = 'https://api.kamino.finance';
const MARKETS_URL = `${KAMINO_API}/v2/kamino-market`;

async function fetchMarketConfigs() {
  const res = await fetch(MARKETS_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchMarketReserves(lendingMarket) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `${KAMINO_API}/kamino-market/${lendingMarket}/reserves/metrics`,
      { signal: controller.signal },
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKaminoMetrics() {
  const configs = await fetchMarketConfigs();

  const results = await Promise.allSettled(
    configs.map(async (config) => {
      const reserves = await fetchMarketReserves(config.lendingMarket);
      const marketName = config.name || 'isolated';

      return reserves
        .filter((r) => parseFloat(r.totalSupplyUsd) > 100_000)
        .map((r) => {
          const totalSupplyUsd = parseFloat(r.totalSupplyUsd);
          const totalBorrowUsd = parseFloat(r.totalBorrowUsd);
          const utilization    = totalSupplyUsd > 0
            ? parseFloat((Math.min(totalBorrowUsd / totalSupplyUsd, 1) * 100).toFixed(2))
            : 0;

          return {
            symbol:      r.liquidityToken,
            mintAddress: r.liquidityTokenMint,
            tvl:         totalSupplyUsd,
            supplyAPY:   parseFloat((parseFloat(r.supplyApy) * 100).toFixed(2)),
            borrowRate:  parseFloat((parseFloat(r.borrowApy) * 100).toFixed(2)),
            borrowAPY:   parseFloat((parseFloat(r.borrowApy) * 100).toFixed(2)),
            utilization,
            lending:     'kamino',
            market:      marketName,
            chain:       'Solana',
          };
        });
    }),
  );

  const metrics = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      metrics.push(...result.value);
    }
  }
  return metrics;
}

module.exports = { fetchKaminoMetrics };
