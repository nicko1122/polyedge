const TraderMonitor = require('./monitor');
const { backfillHistory, DEFAULT_TARGET_ADDRESS } = require('./backfill');
const { getTraderAnalytics } = require('./analytics');
const { getTradesCount } = require('./db');

const args = process.argv.slice(2);
const command = args[0] || 'monitor';

async function main() {
  const address = DEFAULT_TARGET_ADDRESS;

  if (command === 'monitor') {
    console.log(`\n⚡ ========================================================`);
    console.log(`⚡ PolyEdge Real-Time On-Chain Monitor & Logger`);
    console.log(`🎯 Target Trader Address: ${address}`);
    console.log(`🎯 Target Market: btc-updown-5m`);
    console.log(`⚡ Press Ctrl+C to stop`);
    console.log(`========================================================\n`);

    const monitor = new TraderMonitor({ targetAddress: address, pollIntervalMs: 2000 });
    await monitor.start();

    process.on('SIGINT', () => {
      console.log('\n[CLI] Stopping monitor...');
      monitor.stop();
      process.exit(0);
    });

  } else if (command === 'backfill') {
    let pages = 50;
    const pageArg = args.find(a => a.startsWith('--pages='));
    if (pageArg) {
      pages = parseInt(pageArg.split('=')[1], 10) || 50;
    }

    console.log(`\n🔄 Starting historical backfill for trader ${address} (${pages} pages)...`);
    const result = await backfillHistory({ targetAddress: address, maxPages: pages });
    console.log(`\n✅ Backfill complete! Total fetched: ${result.totalFetched}, Total new inserted: ${result.totalInserted}`);

    const counts = await getTradesCount();
    console.log(`📊 Database current total: ${counts.count} trades (BTC 5m: ${counts.btc_count})`);
    process.exit(0);

  } else if (command === 'stats') {
    console.log(`\n📊 Generating performance analytics report for ${address}...\n`);
    const stats = await getTraderAnalytics(address);

    const s = stats.summary;
    console.log(`========================================================`);
    console.log(` 👤 Trader Profile: okeledokelee (Trusting-Clapboard)`);
    console.log(` 📍 Wallet: ${address}`);
    console.log(`========================================================`);
    console.log(` 📈 Total Records Analyzed:  ${s.totalRecords}`);
    console.log(` 🛒 Total Buy Volume:        $${s.totalBuyUsdc.toFixed(2)} USDC`);
    console.log(` 💰 Total Redeem Volume:     $${s.totalRedeemUsdc.toFixed(2)} USDC`);
    console.log(` ⚡ BTC 5m Volume Share:     $${s.btc5mVolumeUsdc.toFixed(2)} USDC (${((s.btc5mVolumeUsdc / (s.totalBuyUsdc || 1)) * 100).toFixed(1)}%)`);
    console.log(` 💵 Estimated Net PnL:       ${s.estimatedNetPnL >= 0 ? '+' : ''}$${s.estimatedNetPnL.toFixed(2)} USDC`);
    console.log(` 🏆 Settled Market Win Rate: ${s.winRate.toFixed(1)}% (${s.totalWinMarkets}/${s.totalSettledMarkets})`);
    console.log(`========================================================`);
    console.log(` 🟢 UP Trades:   ${stats.direction.Up.count} trades | $${stats.direction.Up.usdc.toFixed(2)} USDC | Avg Price: $${stats.direction.Up.avgPrice.toFixed(3)}`);
    console.log(` 🔴 DOWN Trades: ${stats.direction.Down.count} trades | $${stats.direction.Down.usdc.toFixed(2)} USDC | Avg Price: $${stats.direction.Down.avgPrice.toFixed(3)}`);
    console.log(`========================================================\n`);

    process.exit(0);

  } else if (command === 'slugs') {
    console.log(`\n🏷️  Fetching recent 50 markets (by slug) for ${address}...\n`);
    const { getDB } = require('./db');
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
      LIMIT 50
    `, address);

    console.log(`-------------------------------------------------------------------------------------------------------------`);
    console.log(`SLUG                             | PNL ($)     | ROI (%)   | VOL ($)     | TITLE`);
    console.log(`-------------------------------------------------------------------------------------------------------------`);
    rows.forEach(r => {
      const vol = r.vol > 0 ? r.vol : (r.sell_vol + r.redeem_vol);
      const pnl = (r.sell_vol + r.redeem_vol) - r.vol;
      const roi = vol > 0 ? (pnl / vol) * 100 : 0;
      const slugPadded = r.slug.padEnd(32);
      const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
      const pnlPadded = pnlStr.padStart(11);
      const roiStr = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
      const roiPadded = roiStr.padStart(9);
      const volPadded = vol.toFixed(2).padStart(11);

      console.log(`${slugPadded} | ${pnlPadded} | ${roiPadded} | ${volPadded} | ${r.title || ''}`);
    });
    console.log(`-------------------------------------------------------------------------------------------------------------\n`);
    process.exit(0);

  } else if (command === 'timeline') {
    const slugArg = args.find(a => a.startsWith('--slug=')) ? args.find(a => a.startsWith('--slug=')).split('=')[1] : args[1];
    const targetAddr = args.find(a => a.startsWith('--address=')) ? args.find(a => a.startsWith('--address=')).split('=')[1] : (args[2] || address);

    if (!slugArg) {
      console.log('Usage: node cli.js timeline <slug> [address]');
      console.log('Example: node cli.js timeline btc-updown-5m-1785282000');
      process.exit(1);
    }

    const { getMarketTimeline } = require('./timeline');
    const result = await getMarketTimeline(targetAddr, slugArg);

    console.log(`\n========================================================`);
    console.log(result.text);
    console.log(`========================================================\n`);
    process.exit(0);

  } else {
    console.log(`Usage: node cli.js [monitor | backfill [--pages=N] | stats | slugs | timeline <slug>]`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('CLI Error:', err);
  process.exit(1);
});
