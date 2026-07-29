const axios = require('axios');
const EventEmitter = require('events');
const { insertTrades, isBtc5m } = require('./db');

const DEFAULT_TARGET = '0x2011550a8fd844aa22b78d0f039bb72befcb71fa';

class TraderMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.targetAddress = options.targetAddress || DEFAULT_TARGET;
    this.pollIntervalMs = options.pollIntervalMs || 2000;
    this.isPolling = false;
    this.timer = null;
    this.seenHashes = new Set();
    this.lastCheckedTs = Math.floor(Date.now() / 1000) - 300; // default lookback 5 mins
  }

  async start() {
    if (this.isPolling) return;
    this.isPolling = true;
    console.log(`[Monitor] Real-time monitoring STARTED for target trader: ${this.targetAddress}`);
    console.log(`[Monitor] Polling interval: ${this.pollIntervalMs}ms`);

    await this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  stop() {
    if (!this.isPolling) return;
    this.isPolling = false;
    if (this.timer) clearInterval(this.timer);
    console.log(`[Monitor] Real-time monitoring STOPPED.`);
  }

  async pollOnce() {
    try {
      const url = `https://data-api.polymarket.com/activity?user=${this.targetAddress}&limit=30`;
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000
      });

      const activities = response.data;
      if (!Array.isArray(activities) || activities.length === 0) return;

      const newItems = [];

      for (const act of activities) {
        const itemKey = `${act.transactionHash}_${act.conditionId}_${act.timestamp}_${act.side}_${act.size}`;
        if (!this.seenHashes.has(itemKey)) {
          this.seenHashes.add(itemKey);

          // Keep set bounded
          if (this.seenHashes.size > 5000) {
            const firstKey = this.seenHashes.values().next().value;
            this.seenHashes.delete(firstKey);
          }

          newItems.push(act);
        }
      }

      if (newItems.length > 0) {
        // Insert new items to DB
        const insertedCount = await insertTrades(newItems);

        if (insertedCount > 0) {
          // Sort chronologically for event emission
          newItems.sort((a, b) => a.timestamp - b.timestamp);

          for (const item of newItems) {
            const btc = isBtc5m(item.slug, item.title);
            const enrichedItem = { ...item, isBtc5m: btc };

            // Emit live event
            this.emit('trade', enrichedItem);

            // Log to console cleanly
            this.logTradeToConsole(enrichedItem);
          }
        }
      }

      this.emit('heartbeat', { timestamp: Math.floor(Date.now() / 1000), seenCount: this.seenHashes.size });

    } catch (err) {
      if (err.code !== 'ECONNRESET' && err.code !== 'ETIMEDOUT') {
        console.error(`[Monitor] Poll error: ${err.message}`);
      }
      this.emit('error', err);
    }
  }

  logTradeToConsole(t) {
    const timeStr = new Date(t.timestamp * 1000).toLocaleTimeString('zh-TW', { hour12: false });
    const marketType = t.isBtc5m ? '⚡ [BTC 5M]' : '🌐 [OTHER]';
    const txShort = t.transactionHash ? `${t.transactionHash.slice(0, 8)}...` : 'N/A';

    if (t.type === 'REDEEM') {
      console.log(`\x1b[36m[${timeStr}] ${marketType} 💰 REDEEM | Amount: $${(t.usdcSize || 0).toFixed(2)} | Market: ${t.title || t.slug} | Tx: ${txShort}\x1b[0m`);
    } else {
      const isUp = (t.outcome || '').toLowerCase() === 'up';
      const sideColor = isUp ? '\x1b[32m' : '\x1b[31m'; // Green for Up, Red for Down
      const icon = isUp ? '🟢 BUY UP' : '🔴 BUY DOWN';
      const priceStr = t.price ? `$${t.price.toFixed(3)}` : 'N/A';
      const usdcStr = t.usdcSize ? `$${t.usdcSize.toFixed(2)}` : `$${((t.size || 0) * (t.price || 0)).toFixed(2)}`;
      const sharesStr = t.size ? `${t.size.toFixed(2)} shares` : '';

      console.log(`${sideColor}[${timeStr}] ${marketType} ${icon} | Price: ${priceStr} | Size: ${usdcStr} (${sharesStr}) | Market: ${t.title || t.slug} | Tx: ${txShort}\x1b[0m`);
    }
  }
}

module.exports = TraderMonitor;
