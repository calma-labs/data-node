import type { StandarizedMetric } from '../types.js';
import { fetchKaminoMetrics } from './kamino.js';
import { fetchJupiterMetrics } from './jupiter.js';
import { fetchMorphoMetrics } from './morpho.js';
import { fetchSaveMetrics } from './save.js';

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
