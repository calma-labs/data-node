import type { StandarizedMetric, BorrowVault } from '../types.js';
import { PublicKey } from '@solana/web3.js';

const JUP_API = 'https://lite-api.jup.ag/lend/v1';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const LIQUIDITY_PROGRAM = new PublicKey('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC');

interface ApiToken {
  id: number;
  address: string;
  symbol: string;
  decimals: number;
  assetAddress: string;
  asset: { symbol: string; price: string };
  totalAssets: string;
  supplyRate: string;
  rewardsRate: string;
  totalRate: string;
}

function tokenReservePDA(mint: PublicKey): PublicKey {
  const enc = new TextEncoder();
  const [pda] = PublicKey.findProgramAddressSync(
    [enc.encode('reserve'), mint.toBytes()],
    LIQUIDITY_PROGRAM,
  );
  return pda;
}

async function fetchTokenReserve(
  mint: PublicKey,
): Promise<{ borrowRate: number; utilization: number } | null> {
  try {
    const pda = tokenReservePDA(mint);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [pda.toString(), { encoding: 'base64' }],
    });

    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) return null;

    const json = await res.json() as { result?: { value?: { data?: [string] } } };
    const b64 = json?.result?.value?.data?.[0];
    if (!b64) return null;

    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (bytes.length < 78) return null;

    const view = new DataView(bytes.buffer);
    const borrowRate = view.getUint16(72, true) / 100;
    const utilization = view.getUint16(76, true) / 100;

    return { borrowRate, utilization };
  } catch {
    return null;
  }
}

async function fetchEarnTokens(): Promise<StandarizedMetric[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${JUP_API}/earn/tokens`, { signal: controller.signal });
    if (!res.ok) return [];
    const apiTokens = await res.json() as ApiToken[];

    const metrics = await Promise.all(
      apiTokens.map(async (t): Promise<StandarizedMetric | null> => {
        const price = parseFloat(t.asset.price) || 0;
        const totalAssets = Number(t.totalAssets) / Math.pow(10, t.decimals);
        const tvlUsd = totalAssets * price;
        if (tvlUsd <= 100_000) return null;

        const mint = new PublicKey(t.assetAddress);
        const reserve = await fetchTokenReserve(mint);

        const apr = Number(t.totalRate) / 10000;
        const apy = Math.pow(1 + apr / 365, 365) - 1;
        const borrowRate = reserve?.borrowRate ?? 0;

        return {
          symbol: t.asset.symbol.toUpperCase(),
          mintAddress: t.assetAddress,
          tvl: Number(tvlUsd),
          supplyAPY: Number((apy * 100).toFixed(2)),
          utilization: Number((reserve?.utilization ?? 0).toFixed(2)),
          borrowRate: Number(borrowRate.toFixed(2)),
          borrowAPY: Number(((Math.exp(borrowRate / 100) - 1) * 100).toFixed(2)),
          lending: 'jupiter',
          market: 'jupiter',
          chain: 'Solana',
        };
      }),
    );

    return metrics.filter((m): m is StandarizedMetric => m !== null);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBorrowVaults(): Promise<BorrowVault[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${JUP_API}/borrow/vaults`, { signal: controller.signal });
    if (!res.ok) return [];
    return await res.json() as BorrowVault[];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJupiterMetrics(): Promise<StandarizedMetric[]> {
  const vaults = await fetchBorrowVaults();

  if (vaults.length > 0) {
    return vaults
      .filter((v) => {
        const supplyPrice = parseFloat(v.supplyToken.price) || 0;
        const supplyUsd = (Number(v.totalSupply) / Math.pow(10, v.supplyToken.decimals)) * supplyPrice;
        return supplyUsd > 100000;
      })
      .map((v): StandarizedMetric => {
        const borrowPrice = parseFloat(v.borrowToken.price) || 0;
        const supplyPrice = parseFloat(v.supplyToken.price) || 0;
        const tvlUsd = (Number(v.totalSupply) / Math.pow(10, v.supplyToken.decimals)) * supplyPrice;
        const borrowUsd = (Number(v.totalBorrow) / Math.pow(10, v.borrowToken.decimals)) * borrowPrice;
        const utilization = tvlUsd > 0 ? Number(((borrowUsd / tvlUsd) * 100).toFixed(2)) : 0;

        const supplyAPY = Number((v.supplyRate / 100).toFixed(2));
        const borrowAPY = Number((v.borrowRate / 100).toFixed(2));
        const lltv = Number(((v.collateralFactor / 1000) * 100).toFixed(2));
        const liqThreshold = Number(((v.liquidationThreshold / 1000) * 100).toFixed(2));

        return {
          symbol: v.borrowToken.uiSymbol.toUpperCase(),
          mintAddress: v.borrowToken.address,
          tvl: Number(tvlUsd.toFixed(2)),
          supplyAPY,
          utilization,
          borrowRate: borrowAPY,
          borrowAPY,
          lending: 'jupiter',
          market: 'jupiter',
          chain: 'Solana',
          collateral: v.supplyToken.uiSymbol.toUpperCase(),
          lltv,
          liqThreshold,
        };
      });
  }

  return fetchEarnTokens();
}
