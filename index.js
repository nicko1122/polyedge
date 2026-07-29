const { getDB, getTradesCount, insertTrades } = require('./db');
const { backfillHistory } = require('./backfill');
const { getTraderAnalytics } = require('./analytics');
const { getMarketTimeline } = require('./timeline');
const TraderMonitor = require('./monitor');

/**
 * Gets recent unique markets grouped by slug with volume, PnL, and ROI metrics.
 */
async function getRecentSlugs(address, limit = 50) {
  const db = await getDB();
  const rows = await db.all(`
    SELECT 
      slug,
      title,
      MAX(timestamp) as max_ts,
      SUM(CASE WHEN type = 'TRADE' AND side = 'BUY' THEN usdc_size ELSE 0 END) as vol,
      SUM(CASE WHEN type = 'TRADE' AND side = 'SELL' THEN usdc_size ELSE 0 END) as sell_vol,
      SUM(CASE WHEN type = 'REDEEM' THEN usdc_size ELSE 0 END) as redeem_vol,
      COUNT(*) as trade_count
    FROM trades
    WHERE proxy_wallet = ? AND slug IS NOT NULL AND slug != ''
    GROUP BY slug
    ORDER BY max_ts DESC
    LIMIT ?
  `, [address, limit]);

  return rows.map(r => {
    const vol = r.vol > 0 ? r.vol : (r.sell_vol + r.redeem_vol);
    const pnl = (r.sell_vol + r.redeem_vol) - r.vol;
    const roi = vol > 0 ? (pnl / vol) * 100 : 0;
    return {
      slug: r.slug,
      title: r.title || r.slug,
      timestamp: r.max_ts,
      dateStr: new Date(r.max_ts * 1000).toISOString(),
      vol: parseFloat(vol.toFixed(2)),
      pnl: parseFloat(pnl.toFixed(2)),
      roi: parseFloat(roi.toFixed(2)),
      tradeCount: r.trade_count
    };
  });
}

module.exports = {
  getDB,
  getTradesCount,
  insertTrades,
  backfillHistory,
  getTraderAnalytics,
  getRecentSlugs,
  getMarketTimeline,
  TraderMonitor
};
