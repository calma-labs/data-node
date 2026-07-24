'use strict';

const { fetchKaminoMetrics }  = require('./kamino');
const { fetchJupiterMetrics } = require('./jupiter');
const { fetchMorphoMetrics }  = require('./morpho');
const { fetchSaveMetrics }    = require('./save');

async function fetchAllProtocolMetrics() {
  const results = await Promise.allSettled([
    fetchKaminoMetrics(),
    fetchJupiterMetrics(),
    fetchMorphoMetrics(),
    fetchSaveMetrics(),
  ]);

  const names   = ['kamino', 'jupiter', 'morpho', 'save'];
  const metrics = [];

  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') {
      metrics.push(...r.value);
    } else {
      console.error(`[fetchers] ${names[i]} failed:`, r.reason?.message);
    }
  }

  return metrics;
}

module.exports = { fetchAllProtocolMetrics };
