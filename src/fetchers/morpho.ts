import type {
  StandarizedMetric,
  MorphoMarket,
  GraphQLResponse,
  TokenDataResult,
  TokenHistoryPoint,
  TokenSnapshot,
} from '../types.js';
import { symbolMatches } from './defillama.js';

const MORPHO_API = 'https://api.morpho.org/graphql';


const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  8453: 'Base',
};

const MORPHO_QUERY = `
  query {
    markets(
      first: 200
      orderBy: SupplyAssetsUsd
      orderDirection: Desc
      where: { chainId_in: [1, 8453], listed: true }
    ) {
      items {
        marketId
        loanAsset { address symbol decimals }
        collateralAsset { symbol }

        lltv
        chain { id }
        state {
          supplyAssetsUsd
          utilization
          supplyApy
          borrowApy
        }
      }
    }
  }
`;

type MorphoMarketsData = {
  markets?: {
    items: MorphoMarket[];
  };
};

async function fetchMorphoMarkets(): Promise<MorphoMarket[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: MORPHO_QUERY }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Morpho API error: ${res.status}`);

    const json = await res.json() as GraphQLResponse<MorphoMarketsData>;

    if (json.errors) throw new Error(json.errors[0]?.message ?? 'Morpho API returned errors');

    return json?.data?.markets?.items ?? [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMorphoMetrics(): Promise<StandarizedMetric[]> {
  const markets = await fetchMorphoMarkets();

  return markets
    .filter((m) => m.state.supplyAssetsUsd > 10000)
    .map((m): StandarizedMetric => {
      const lltvRaw = m.lltv ? Number(m.lltv) / 1e18 : null;
      return {
        symbol: m.loanAsset.symbol.toUpperCase(),
        mintAddress: m.loanAsset.address,
        tvl: Number(m.state.supplyAssetsUsd.toFixed(2)),
        supplyAPY: Number((m.state.supplyApy * 100).toFixed(2)),
        utilization: Number((m.state.utilization * 100).toFixed(2)),
        borrowRate: Number((m.state.borrowApy * 100).toFixed(2)),
        borrowAPY: Number((m.state.borrowApy * 100).toFixed(2)),
        lending: 'morpho',
        market: 'morpho',
        chain: CHAIN_NAMES[m.chain.id] ?? `Chain ${m.chain.id}`,
        collateral: m.collateralAsset?.symbol ?? undefined,
        lltv: lltvRaw !== null ? Number((lltvRaw * 100).toFixed(2)) : undefined,
      };
    });
}

const MORPHO_HISTORY_QUERY = `
  query MarketApys($marketId: String!, $chainId: Int!, $options: TimeseriesOptions) {
    marketById(marketId: $marketId, chainId: $chainId) {
      state {
        supplyAssetsUsd
        borrowAssetsUsd
        utilization
        supplyApy
        borrowApy
      }
      historicalState {
        supplyApy(options: $options) { x y }
      }
    }
  }
`;

export async function fetchMorphoPlot(
  symbol: string,
  collateral?: string,
): Promise<TokenDataResult | null> {
  const markets = await fetchMorphoMarkets();

  const matching = markets.filter((m) => {
    if (!symbolMatches(m.loanAsset.symbol, symbol)) return false;
    if (collateral) {
      if (!m.collateralAsset) return false;
      if (!symbolMatches(m.collateralAsset.symbol, collateral)) return false;
    }
    return true;
  });

  if (matching.length === 0) return null;

  matching.sort((a, b) => b.state.supplyAssetsUsd - a.state.supplyAssetsUsd);
  const best = matching[0];

  const now = Math.floor(Date.now() / 1000);
  const stableNow = now - (now % 600);
  const startTimestamp = stableNow - 400 * 24 * 60 * 60;

  let history: TokenHistoryPoint[] = [];
  let latestState = best.state;

  try {
    const res = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: MORPHO_HISTORY_QUERY,
        variables: {
          marketId: best.marketId,
          chainId: best.chain.id,
          options: {
            startTimestamp,
            endTimestamp: stableNow,
            interval: 'DAY',
          },
        },
      }),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        data?: {
          marketById?: {
            state?: typeof best.state;
            historicalState?: {
              supplyApy?: { x: number; y: number }[];
            };
          };
        };
      };
      const marketData = json.data?.marketById;
      if (marketData?.state) {
        latestState = marketData.state;
      }
      const points = marketData?.historicalState?.supplyApy ?? [];
      history = points
        .filter((p) => p && p.x && p.y !== undefined)
        .map((p) => ({
          date: new Date(p.x * 1000).toISOString(),
          apy: parseFloat((p.y * 100).toFixed(2)),
          utilization: null,
        }));
    }
  } catch {
  }

  const snapshot: TokenSnapshot = {
    tvl: Math.round(latestState.supplyAssetsUsd),
    supplyAPY: parseFloat((latestState.supplyApy * 100).toFixed(2)),
    borrowRate: parseFloat((latestState.borrowApy * 100).toFixed(2)),
    utilization: parseFloat((latestState.utilization * 100).toFixed(2)),
    lltv: best.lltv ? Number(((Number(best.lltv) / 1e18) * 100).toFixed(2)) : null,
  };

  return {
    history,
    poolId: best.marketId,
    source: 'morpho',
    matchedSymbol: best.loanAsset.symbol,
    snapshot,
  };
}


