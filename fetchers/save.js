'use strict';

const SAVE_API    = 'https://api.solend.fi';
const MIN_TVL_USD = 100_000;

async function fetchAllMarketConfigs() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${SAVE_API}/v1/markets/configs?scope=all`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Save configs API error: ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReserves(addresses) {
  if (addresses.length === 0) return [];
  const ids = addresses.join(',');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${SAVE_API}/v1/reserves?ids=${ids}`, { signal: controller.signal });
    if (!res.ok) return [];
    const json = await res.json();
    return json?.results ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function computeMetric(entry, symbolFromConfig, marketName) {
  const rates = entry.rates ?? {};
  const liq   = entry.reserve?.liquidity ?? {};

  const WADS      = 1e18;
  const DECIMALS  = Math.pow(10, liq.mintDecimals ?? 6);
  const borrowed  = parseFloat(liq.borrowedAmountWads ?? '0') / WADS / DECIMALS;
  const available = parseFloat(liq.availableAmount ?? '0') / DECIMALS;
  const total     = borrowed + available;
  const marketPrice = parseFloat(liq.marketPrice ?? '0');
  let tvlRaw = total > 0 && marketPrice > 0 ? Math.round(total * marketPrice) : 0;
  const tvl  = tvlRaw / WADS;

  if (tvl < MIN_TVL_USD) return null;

  const supplyAPY   = Number(parseFloat(rates.supplyInterest ?? '0').toFixed(2));
  const borrowRate  = Number(parseFloat(rates.borrowInterest ?? '0').toFixed(2));
  const utilization = total > 0 ? parseFloat(((borrowed / total) * 100).toFixed(2)) : 0;
  const mintAddress = liq.mintPubkey ?? '';

  return {
    symbol:      symbolFromConfig.toUpperCase(),
    mintAddress,
    tvl,
    utilization,
    supplyAPY,
    borrowAPY:   borrowRate,
    borrowRate,
    lending:     'save',
    market:      marketName,
    chain:       'Solana',
  };
}

async function fetchSaveMetrics() {
  const allMarkets = await fetchAllMarketConfigs();

  const visibleMarkets = allMarkets.filter(
    (m) => !m.hidden && m.reserves && m.reserves.length > 0,
  );

  const results = [];

  await Promise.all(
    visibleMarkets.map(async (market) => {
      const reserves  = market.reserves ?? [];
      const addresses = reserves.map((r) => r.address);

      const reserveResults = await fetchReserves(addresses);

      reserveResults.forEach((entry) => {
        const reservePubkey = entry.reserve?.pubkey;
        const configReserve = reserves.find((r) => r.address === reservePubkey);

        const symbol =
          configReserve?.asset ??
          configReserve?.liquidityToken?.symbol ??
          'UNKNOWN';

        if (symbol === 'UNKNOWN') return;

        const rawName     = market.isPrimary ? 'Main' : market.name;
        const marketLabel = `${rawName} Pool`;

        const metric = computeMetric(entry, symbol, marketLabel);
        if (metric) results.push(metric);
      });
    }),
  );

  return results;
}

module.exports = { fetchSaveMetrics };
