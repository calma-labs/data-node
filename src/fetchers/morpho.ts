import type { StandarizedMetric, MorphoMarket, GraphQLResponse } from '../types.js';

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
    .filter((m) => m.state.supplyAssetsUsd > 100000)
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
