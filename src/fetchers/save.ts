import type {
  StandarizedMetric,
  SaveMarketConfig,
  SaveReserveConfig,
  SaveReserveResult,
  TokenDataResult,
  TokenHistoryPoint,
  TokenSnapshot,
} from '../types.js';
import { symbolMatches, downsampleToDaily } from './defillama.js';

const SAVE_API = 'https://api.solend.fi';
const MIN_TVL_USD = 100_000;

interface SaveHistoryPoint {
  supplyAPY: number;
  borrowAPY: number;
  supplyAPR: number;
  borrowAPR: number;
  timestamp: number;
  reserveID: string;
}


async function fetchAllMarketConfigs(): Promise<SaveMarketConfig[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${SAVE_API}/v1/markets/configs?scope=all`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Save configs API error: ${res.status}`);
    return res.json() as Promise<SaveMarketConfig[]>;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReserves(addresses: string[]): Promise<SaveReserveResult[]> {
  if (addresses.length === 0) return [];
  const ids = addresses.join(',');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${SAVE_API}/v1/reserves?ids=${ids}`, { signal: controller.signal });
    if (!res.ok) return [];
    const json: { results?: SaveReserveResult[] } = await res.json() as { results?: SaveReserveResult[] };
    return json?.results ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function computeMetric(
  entry: SaveReserveResult,
  symbolFromConfig: string,
  marketName: string,
): StandarizedMetric | null {
  const rates = entry.rates ?? {};
  const liq = entry.reserve?.liquidity ?? {};

  const WADS = 1e18;
  const DECIMALS = Math.pow(10, liq.mintDecimals ?? 6);
  const borrowed = parseFloat(liq.borrowedAmountWads ?? '0') / WADS / DECIMALS;
  const available = parseFloat(liq.availableAmount ?? '0') / DECIMALS;
  const total = borrowed + available;
  const marketPrice = parseFloat(liq.marketPrice ?? '0');
  const tvlRaw = total > 0 && marketPrice > 0 ? Math.round(total * marketPrice) : 0;
  const tvl = tvlRaw / WADS;

  if (tvl < MIN_TVL_USD) return null;

  const supplyAPY = Number(parseFloat(rates.supplyInterest ?? '0').toFixed(2));
  const borrowRate = Number(parseFloat(rates.borrowInterest ?? '0').toFixed(2));
  const utilization = total > 0 ? parseFloat(((borrowed / total) * 100).toFixed(2)) : 0;
  const mintAddress = liq.mintPubkey ?? '';

  return {
    symbol: symbolFromConfig.toUpperCase(),
    mintAddress,
    tvl,
    utilization,
    supplyAPY,
    borrowAPY: borrowRate,
    borrowRate,
    lending: 'save',
    market: marketName,
    chain: 'Solana',
  };
}

export async function fetchSaveMetrics(): Promise<StandarizedMetric[]> {
  const allMarkets = await fetchAllMarketConfigs();

  const visibleMarkets = allMarkets.filter(
    (m) => !m.hidden && m.reserves && m.reserves.length > 0,
  );

  const results: StandarizedMetric[] = [];

  await Promise.all(
    visibleMarkets.map(async (market) => {
      const reserves: SaveReserveConfig[] = market.reserves ?? [];
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

        const rawName = market.isPrimary ? 'Main' : market.name;
        const marketLabel = `${rawName} Pool`;

        const metric = computeMetric(entry, symbol, marketLabel);
        if (metric) results.push(metric);
      });
    }),
  );

  return results;
}

export async function fetchSavePlot(
  symbol: string,
  _collateral?: string,
): Promise<TokenDataResult | null> {
  const allMarkets = await fetchAllMarketConfigs();
  const visibleMarkets = allMarkets.filter(
    (m) => !m.hidden && m.reserves && m.reserves.length > 0,
  );

  const candidateAddresses: string[] = [];
  const addrToSymbol: Record<string, string> = {};

  for (const m of visibleMarkets) {
    const reserves = m.reserves ?? [];
    for (const r of reserves) {
      const sym = r.asset ?? r.liquidityToken?.symbol ?? 'UNKNOWN';
      if (sym !== 'UNKNOWN' && symbolMatches(sym, symbol)) {
        candidateAddresses.push(r.address);
        addrToSymbol[r.address] = sym;
      }
    }
  }

  if (candidateAddresses.length === 0) return null;

  const results = await fetchReserves(candidateAddresses);
  if (results.length === 0) return null;

  results.sort((a, b) => {
    const aTotal =
      parseFloat(a.reserve?.liquidity?.availableAmount ?? '0') +
      parseFloat(a.reserve?.liquidity?.borrowedAmountWads ?? '0') / 1e18;
    const bTotal =
      parseFloat(b.reserve?.liquidity?.availableAmount ?? '0') +
      parseFloat(b.reserve?.liquidity?.borrowedAmountWads ?? '0') / 1e18;
    return bTotal - aTotal;
  });

  const bestEntry = results[0];
  const bestAddress = bestEntry.reserve?.pubkey ?? candidateAddresses[0];
  const matchedSymbol = addrToSymbol[bestAddress] ?? symbol;

  const now = Math.floor(Date.now() / 1000);
  const start = now - 400 * 24 * 60 * 60;

  let history: TokenHistoryPoint[] = [];
  try {
    const res = await fetch(
      `${SAVE_API}/v1/reserves/historical-interest-rates?ids=${bestAddress}&start=${start}&end=${now}`,
    );
    if (res.ok) {
      const historyJson = (await res.json()) as Record<string, SaveHistoryPoint[]>;
      const points = historyJson[bestAddress] ?? [];
      history = downsampleToDaily(
        points,
        (p) => p.timestamp,
        (p, dateKey) => ({
          date: new Date(dateKey).toISOString(),
          apy: parseFloat((p.supplyAPY * 100).toFixed(2)),
          utilization: null,
        }),
      );
    }
  } catch {
  }

  const rates = bestEntry.rates ?? {};
  const liq = bestEntry.reserve?.liquidity ?? {};
  const WADS = 1e18;
  const DECIMALS = Math.pow(10, liq.mintDecimals ?? 6);
  const borrowed = parseFloat(liq.borrowedAmountWads ?? '0') / WADS / DECIMALS;
  const available = parseFloat(liq.availableAmount ?? '0') / DECIMALS;
  const total = borrowed + available;
  const utilization = total > 0 ? (borrowed / total) * 100 : 0;
  const marketPrice = parseFloat(liq.marketPrice ?? '0');
  const tvl =
    total > 0 && marketPrice > 0 ? Math.round(total * marketPrice) / WADS : 0;

  const snapshot: TokenSnapshot = {
    tvl: Math.round(tvl),
    supplyAPY: Number(parseFloat(rates.supplyInterest ?? '0').toFixed(2)),
    borrowRate: Number(parseFloat(rates.borrowInterest ?? '0').toFixed(2)),
    utilization: Number(utilization.toFixed(2)),
  };

  return {
    history,
    poolId: bestAddress,
    source: 'save',
    matchedSymbol,
    snapshot,
  };
}

