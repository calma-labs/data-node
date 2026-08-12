export type StandarizedMetric = {
  symbol: string;
  mintAddress: string;
  tvl: number;
  utilization: number;
  supplyAPY: number;
  borrowRate: number;
  borrowAPY: number;
  lending: string;
  chain: string;
  market: string;
  collateral?: string;
  isAggregated?: boolean;
  lltv?: number;
  liqThreshold?: number;
  protocolTotalActiveLoans?: number | null;
};

export type ComparedMetric = {
  mintAddress: string;
  tvl: number | string;
  utilization: number | string;
  supplyAPY: number | string;
  borrowRate: number | string;
};

export type GraphQLError = {
  message: string;
};

export type GraphQLResponse<T> = {
  data?: T;
  errors?: GraphQLError[];
};

export interface KaminoReserveMetric {
  reserve: string;
  liquidityToken: string;
  liquidityTokenMint: string;
  supplyApy: string;
  borrowApy: string;
  totalSupply: string;
  totalBorrow: string;
  totalSupplyUsd: string;
  totalBorrowUsd: string;
}

export interface KaminoMarketConfig {
  lendingMarket: string;
  name?: string;
}

export interface MorphoMarket {
  marketId: string;
  loanAsset: { symbol: string; address: string; decimals: number };
  collateralAsset: { symbol: string } | null;
  lltv: string | null;
  chain: { id: number };
  state: {
    supplyAssetsUsd: number;
    utilization: number;
    supplyApy: number;
    borrowApy: number;
  };
}


export interface BorrowVault {
  id: number;
  address: string;
  supplyToken: {
    address: string;
    symbol: string;
    uiSymbol: string;
    decimals: number;
    price: string;
  };
  borrowToken: {
    address: string;
    symbol: string;
    uiSymbol: string;
    decimals: number;
    price: string;
  };
  totalSupply: string;
  totalBorrow: string;
  collateralFactor: number;
  liquidationThreshold: number;
  supplyRate: number;
  borrowRate: number;
  totalPositions: number;
}

export interface SaveReserveConfig {
  asset?: string;
  address: string;
  liquidityToken?: {
    symbol?: string;
    mint?: string;
    decimals?: number;
  };
}

export interface SaveMarketConfig {
  name: string;
  isPrimary?: boolean;
  hidden?: boolean;
  reserves?: SaveReserveConfig[];
}

export interface SaveReserveResult {
  rates?: {
    supplyInterest?: string;
    borrowInterest?: string;
  };
  reserve?: {
    pubkey?: string;
    liquidity?: {
      mintDecimals?: number;
      borrowedAmountWads?: string;
      availableAmount?: string;
      marketPrice?: string;
      mintPubkey?: string;
    };
  };
}

export interface PoolRow {
  id: number;
  reservePubkey: string;
  symbol: string;
  mintAddress: string;
  lending: string;
  chain: string;
  market: string;
  collateral: string | null;
  isAggregated: boolean;
}

export interface SnapshotRow {
  poolId: number;
  tvl: string;
  utilization: string;
  supplyAPY: string;
  borrowRate: string;
  borrowAPY: string;
  totalBorrowUsd: string;
  liquidityUsd: string;
  fetchedAt: string;
}

export interface BQSchemaField {
  name: string;
  type: string;
  mode: string;
}

export interface TokenHistoryPoint {
  date: string;
  apy: number;
  utilization: number | null;
}

export interface TokenSnapshot {
  tvl: number;
  supplyAPY: number;
  borrowRate: number;
  utilization: number;
  protocolTotalActiveLoans?: number | null;
  predictions?: {
    predictedClass?: string;
    predictedProbability?: number;
    binnedConfidence?: number;
  };
  mu?: number;
  sigma?: number;
  apyMean30d?: number;
  ilRisk?: string;
  exposure?: string;
  lltv?: number | null;
}

export interface TokenDataResult {
  history: TokenHistoryPoint[];
  poolId: string | null;
  source: string | null;
  matchedSymbol: string;
  snapshot?: TokenSnapshot | null;
}

