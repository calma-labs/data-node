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
    } catch {
    }
  }

  return result;
}

