import type { StandarizedMetric, TokenDataResult } from '../types.js';
import { fetchKaminoMetrics, fetchKaminoPlot } from './kamino.js';
import { fetchJupiterMetrics, fetchJupiterPlot } from './jupiter.js';
import { fetchMorphoMetrics, fetchMorphoPlot } from './morpho.js';
import { fetchSaveMetrics, fetchSavePlot } from './save.js';
import {
  fetchDefiLlamaPlot,
  fetchProtocolTotalActiveLoansFromDefiLlama,
} from './defillama.js';

export {
  fetchKaminoMetrics,
  fetchJupiterMetrics,
  fetchMorphoMetrics,
  fetchSaveMetrics,
  fetchKaminoPlot,
  fetchJupiterPlot,
  fetchMorphoPlot,
  fetchSavePlot,
  fetchDefiLlamaPlot,
};

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/^W(?=[A-Z])/, '');
}

function aggregateMetrics(metrics: StandarizedMetric[]): StandarizedMetric[] {
  const groups = new Map<string, StandarizedMetric[]>();
  for (const m of metrics) {
    if (m.isAggregated) continue;
    const sym = normalizeSymbol(m.symbol);
    const key = `${m.lending}:${sym}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(m);
  }
  
  const aggregated: StandarizedMetric[] = [];
  for (const list of groups.values()) {
    const totalTvl = list.reduce((sum, m) => sum + (m.tvl || 0), 0);
    if (totalTvl <= 0) continue;
    
    const avgSupplyApy = list.reduce((sum, m) => sum + (m.supplyAPY || 0) * (m.tvl || 0), 0) / totalTvl;
    const avgBorrowApy = list.reduce((sum, m) => sum + (m.borrowAPY || 0) * (m.tvl || 0), 0) / totalTvl;
    const avgBorrowRate = list.reduce((sum, m) => sum + (m.borrowRate || 0) * (m.tvl || 0), 0) / totalTvl;
    const avgUtil = list.reduce((sum, m) => sum + (m.utilization || 0) * (m.tvl || 0), 0) / totalTvl;
    
    const best = list.reduce((prev, curr) => (curr.tvl || 0) > (prev.tvl || 0) ? curr : prev);
    
    aggregated.push({
      symbol: normalizeSymbol(best.symbol),
      mintAddress: best.mintAddress,
      tvl: totalTvl,
      utilization: avgUtil,
      supplyAPY: avgSupplyApy,
      borrowAPY: avgBorrowApy,
      borrowRate: avgBorrowRate,
      lending: best.lending,
      chain: best.chain,
      market: 'Aggregated',
      collateral: undefined,
      isAggregated: true
    });
  }
  return aggregated;
}

export async function fetchAllProtocolMetrics(): Promise<StandarizedMetric[]> {
  const fetchers: [string, Promise<StandarizedMetric[]>][] = [
    ['kamino',  fetchKaminoMetrics()],
    ['jupiter', fetchJupiterMetrics()],
    ['morpho',  fetchMorphoMetrics()],
    ['save',    fetchSaveMetrics()],
  ];

  const results = await Promise.allSettled(fetchers.map(([, p]) => p));
  const metrics: StandarizedMetric[] = [];

  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') {
      metrics.push(...r.value);
    } else {
      console.error(`[fetchers] ${fetchers[i][0]} failed:`, r.reason?.message);
    }
  }

  const aggregated = aggregateMetrics(metrics);
  metrics.push(...aggregated);

  return metrics;
}

export async function fetchPlotData(
  protocol: string,
  symbol: string,
  collateral?: string,
): Promise<TokenDataResult | null> {
  const normProtocol = protocol.toLowerCase();
  let result: TokenDataResult | null = null;

  try {
    switch (normProtocol) {
      case 'kamino':
        result = await fetchKaminoPlot(symbol, collateral);
        break;
      case 'save':
      case 'solend':
        result = await fetchSavePlot(symbol, collateral);
        break;
      case 'jupiter':
      case 'jup-lend':
      case 'jupiter-lend':
        result = await fetchJupiterPlot(symbol, collateral);
        break;
      case 'morpho':
        result = await fetchMorphoPlot(symbol, collateral);
        break;
    }
  } catch (err) {
    console.error(`[fetchers] error fetching plot for ${normProtocol}/${symbol}:`, err);
  }

  if (!result || !result.history || result.history.length === 0) {
    try {
      const fallback = await fetchDefiLlamaPlot(normProtocol, symbol, collateral);
      if (fallback) {
        if (result && result.snapshot) {
          result.history = fallback.history;
          result.poolId = result.poolId || fallback.poolId;
        } else {
          result = fallback;
        }
      }
    } catch (fallbackErr) {
      console.error(`[fetchers] fallback error for ${normProtocol}/${symbol}:`, fallbackErr);
    }
  }

  if (result && result.snapshot) {
    try {
      const totalActiveLoans = await fetchProtocolTotalActiveLoansFromDefiLlama(
        normProtocol,
      );
      result.snapshot.protocolTotalActiveLoans = totalActiveLoans;
    } catch (e) {
      console.debug(`[fetchers] missing active loans for ${normProtocol}:`, (e as Error).message);
    }
  }

  return result;
}

