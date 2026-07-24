'use strict';

const JUP_API = 'https://lite-api.jup.ag/lend/v1';

async function fetchBorrowVaults() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${JUP_API}/borrow/vaults`, { signal: controller.signal });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJupiterMetrics() {
  const vaults = await fetchBorrowVaults();

  return vaults
    .filter((v) => {
      const supplyPrice = parseFloat(v.supplyToken.price) || 0;
      const supplyUsd = (Number(v.totalSupply) / Math.pow(10, v.supplyToken.decimals)) * supplyPrice;
      return supplyUsd > 100000;
    })
    .map((v) => {
      const borrowPrice = parseFloat(v.borrowToken.price) || 0;
      const supplyPrice = parseFloat(v.supplyToken.price) || 0;
      const tvlUsd  = (Number(v.totalSupply) / Math.pow(10, v.supplyToken.decimals)) * supplyPrice;
      const borrowUsd = (Number(v.totalBorrow) / Math.pow(10, v.borrowToken.decimals)) * borrowPrice;
      const utilization = tvlUsd > 0 ? Number(((borrowUsd / tvlUsd) * 100).toFixed(2)) : 0;

      const supplyAPY     = Number((v.supplyRate / 100).toFixed(2));
      const borrowAPY     = Number((v.borrowRate / 100).toFixed(2));
      const lltv          = Number(((v.collateralFactor / 1000) * 100).toFixed(2));
      const liqThreshold  = Number(((v.liquidationThreshold / 1000) * 100).toFixed(2));

      return {
        symbol:       v.borrowToken.uiSymbol.toUpperCase(),
        mintAddress:  v.borrowToken.address,
        tvl:          Number(tvlUsd.toFixed(2)),
        supplyAPY,
        utilization,
        borrowRate:   borrowAPY,
        borrowAPY,
        lending:      'jupiter',
        market:       'jupiter',
        chain:        'Solana',
        collateral:   v.supplyToken.uiSymbol.toUpperCase(),
        lltv,
        liqThreshold,
      };
    });
}

module.exports = { fetchJupiterMetrics };
