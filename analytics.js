const { getDB } = require('./db');

/**
 * Calculates detailed statistics and analytics for the target trader.
 */
async function getTraderAnalytics(address = '0x2011550a8fd844aa22b78d0f039bb72befcb71fa') {
  const db = await getDB();

  // 1. Overall Summary
  const summaryRow = await db.get(`
    SELECT 
      COUNT(*) as total_records,
      SUM(CASE WHEN type = 'TRADE' THEN 1 ELSE 0 END) as total_trades,
      SUM(CASE WHEN type = 'REDEEM' THEN 1 ELSE 0 END) as total_redemptions,
      SUM(CASE WHEN type = 'TRADE' AND side = 'BUY' THEN usdc_size ELSE 0 END) as total_buy_usdc,
      SUM(CASE WHEN type = 'TRADE' AND side = 'SELL' THEN usdc_size ELSE 0 END) as total_sell_usdc,
      SUM(CASE WHEN type = 'REDEEM' THEN usdc_size ELSE 0 END) as total_redeem_usdc,
      SUM(CASE WHEN is_btc_5m = 1 THEN 1 ELSE 0 END) as btc_5m_records,
      SUM(CASE WHEN is_btc_5m = 1 AND type = 'TRADE' THEN usdc_size ELSE 0 END) as btc_5m_volume_usdc
    FROM trades
    WHERE proxy_wallet = ?
  `, address);

  // 2. BTC 5m Direction Breakdown (UP vs DOWN)
  const directionRows = await db.all(`
    SELECT 
      outcome,
      COUNT(*) as trade_count,
      SUM(usdc_size) as total_usdc,
      SUM(size) as total_shares,
      AVG(price) as avg_price,
      MIN(price) as min_price,
      MAX(price) as max_price
    FROM trades
    WHERE proxy_wallet = ? AND is_btc_5m = 1 AND type = 'TRADE' AND side = 'BUY'
    GROUP BY outcome
  `, address);

  const directionMap = {
    Up: { count: 0, usdc: 0, shares: 0, avgPrice: 0 },
    Down: { count: 0, usdc: 0, shares: 0, avgPrice: 0 }
  };
  for (const r of directionRows) {
    if (r.outcome && directionMap[r.outcome]) {
      directionMap[r.outcome] = {
        count: r.trade_count,
        usdc: r.total_usdc || 0,
        shares: r.total_shares || 0,
        avgPrice: r.avg_price || 0
      };
    }
  }

  // 3. Price Bracket Distribution
  const priceBrackets = await db.all(`
    SELECT 
      CASE 
        WHEN price < 0.30 THEN '< $0.30 (Cheap / Longshot)'
        WHEN price >= 0.30 AND price < 0.50 THEN '$0.30 - $0.49 (Underdog)'
        WHEN price >= 0.50 AND price < 0.70 THEN '$0.50 - $0.69 (Slight Fav)'
        ELSE '>= $0.70 (Strong Fav)'
      END as bracket,
      COUNT(*) as count,
      SUM(usdc_size) as total_usdc
    FROM trades
    WHERE proxy_wallet = ? AND type = 'TRADE' AND side = 'BUY'
    GROUP BY bracket
    ORDER BY count DESC
  `, address);

  // 4. Hourly / Time Activity Breakdown
  const hourlyActivity = await db.all(`
    SELECT 
      strftime('%H', datetime(timestamp, 'unixepoch')) as hour_utc,
      COUNT(*) as count,
      SUM(usdc_size) as total_usdc
    FROM trades
    WHERE proxy_wallet = ? AND type = 'TRADE'
    GROUP BY hour_utc
    ORDER BY hour_utc ASC
  `, address);

  // 5. Estimated PnL Calculation per Condition (Market)
  // For each condition_id: sum of (Buy usdc spent), (Sell usdc received), (Redeem usdc claimed)
  const conditionPnLRows = await db.all(`
    SELECT 
      condition_id,
      title,
      slug,
      is_btc_5m,
      SUM(CASE WHEN type = 'TRADE' AND side = 'BUY' THEN usdc_size ELSE 0 END) as buy_usdc,
      SUM(CASE WHEN type = 'TRADE' AND side = 'SELL' THEN usdc_size ELSE 0 END) as sell_usdc,
      SUM(CASE WHEN type = 'REDEEM' THEN usdc_size ELSE 0 END) as redeem_usdc,
      SUM(CASE WHEN type = 'REDEEM' THEN 1 ELSE 0 END) as redeem_count
    FROM trades
    WHERE proxy_wallet = ? AND condition_id IS NOT NULL
    GROUP BY condition_id
  `, address);

  let totalWinMarkets = 0;
  let totalSettledMarkets = 0;
  let estimatedNetPnL = 0;

  for (const c of conditionPnLRows) {
    const netMarketPnL = (c.sell_usdc + c.redeem_usdc) - c.buy_usdc;
    estimatedNetPnL += netMarketPnL;

    if (c.redeem_count > 0 || c.redeem_usdc > 0) {
      totalSettledMarkets++;
      if (netMarketPnL > 0) {
        totalWinMarkets++;
      }
    }
  }

  const winRate = totalSettledMarkets > 0 ? (totalWinMarkets / totalSettledMarkets) * 100 : 0;

  // 6. Recent 20 Trades
  const recentTrades = await db.all(`
    SELECT 
      id, timestamp, condition_id, type, side, size, usdc_size, price,
      outcome, title, slug, transaction_hash, is_btc_5m
    FROM trades
    WHERE proxy_wallet = ?
    ORDER BY timestamp DESC
    LIMIT 20
  `, address);

  return {
    wallet: address,
    summary: {
      totalRecords: summaryRow.total_records || 0,
      totalTrades: summaryRow.total_trades || 0,
      totalRedemptions: summaryRow.total_redemptions || 0,
      totalBuyUsdc: summaryRow.total_buy_usdc || 0,
      totalSellUsdc: summaryRow.total_sell_usdc || 0,
      totalRedeemUsdc: summaryRow.total_redeem_usdc || 0,
      btc5mRecords: summaryRow.btc_5m_records || 0,
      btc5mVolumeUsdc: summaryRow.btc_5m_volume_usdc || 0,
      estimatedNetPnL,
      totalSettledMarkets,
      totalWinMarkets,
      winRate
    },
    direction: directionMap,
    priceBrackets,
    hourlyActivity,
    recentTrades
  };
}

module.exports = {
  getTraderAnalytics
};
