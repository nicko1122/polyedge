const { getDB } = require('./db');

/**
 * Generates a formatted human-readable timeline for a target wallet address and market slug.
 */
async function getMarketTimeline(address, slug) {
  const db = await getDB();
  const targetWallet = (address || '0x2011550a8fd844aa22b78d0f039bb72befcb71fa').toLowerCase();

  const trades = await db.all(`
    SELECT * FROM trades
    WHERE proxy_wallet = ? AND (slug = ? OR condition_id = ?)
    ORDER BY timestamp ASC
  `, [targetWallet, slug, slug]);

  if (!trades || trades.length === 0) {
    return {
      slug,
      title: slug,
      text: `未找到該 Slug (${slug}) 的交易紀錄`,
      trades: []
    };
  }

  const title = trades[0].title || slug;
  let textOutput = `${title}\n\n`;

  const timelineEvents = trades.map(t => {
    const d = new Date(t.timestamp * 1000);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hours = d.getHours();
    const ampm = hours >= 12 ? '下午' : '上午';
    const h12 = String(hours % 12 || 12).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    const secs = String(d.getSeconds()).padStart(2, '0');

    const timeStr = `${month}月${day}日 ${ampm}${h12}:${mins}:${secs}`;
    let eventText = '';

    if (t.type === 'REDEEM') {
      const outcomeStr = t.outcome ? ` ${t.outcome}` : '';
      eventText = `${timeStr}\n到期贖回\n領回 $${(t.usdc_size || 0).toFixed(2)} (${(t.size || 0).toFixed(2)} 份${outcomeStr})`;
    } else {
      const action = t.side === 'BUY' ? '買入' : (t.side === 'SELL' ? '賣出' : '掛單');
      const sizeStr = t.size ? t.size.toFixed(t.size % 1 === 0 ? 2 : 3) : '0';
      const priceStr = t.price ? `$${t.price.toFixed(2)}` : '$0.00';
      const costStr = t.usdc_size ? `$${t.usdc_size.toFixed(3)}` : '$0.00';
      const outcomeStr = t.outcome || '';

      eventText = `${timeStr}\n掛單\n${action} ${sizeStr} 份 ${outcomeStr}，價格 ${priceStr}，花費 ${costStr}`;
    }

    textOutput += `${eventText}\n\n`;

    return {
      timeStr,
      type: t.type,
      side: t.side,
      outcome: t.outcome,
      size: t.size,
      price: t.price,
      usdcSize: t.usdc_size,
      eventText
    };
  });

  return {
    slug,
    title,
    text: textOutput.trim(),
    trades: timelineEvents
  };
}

module.exports = {
  getMarketTimeline
};
