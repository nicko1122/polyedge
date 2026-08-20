const axios = require('axios');
const EventEmitter = require('events');
const { insertTrades, isBtc5m, setSyncState, getSyncState } = require('./db');

const DEFAULT_TARGET = '0x2011550a8fd844aa22b78d0f039bb72befcb71fa';

class TraderMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.targetAddress = options.targetAddress || DEFAULT_TARGET;
    this.pollIntervalMs = options.pollIntervalMs || 2000;
    this.isPolling = false;
    this.timer = null;
    this.seenHashes = new Set();
    // ⚠⚠ 2026-08-20:這裡原本是 `this.lastCheckedTs = now - 300`,而且**整支檔案
    //   只出現這一次** —— 設了從來沒被讀過。跟 backfill 的 currentEndTs 同一個病,
    //   同一個 repo 裡第二次。
    //
    //   後果:monitor 每輪只抓最新 limit 筆,沒有任何機制確認「有沒有漏」。
    //     * 爆量時 2 秒內超過 limit 筆 → 超出的永遠不會再被抓到
    //     * 停機再開 → 中間那段永久缺失,而且不留紀錄
    //   實測對手 08-19 量翻倍那兩天,窗級異常率跳到 8.9%/9.3%(其餘日 0-4.6%)。
    //
    //   改法:持久化「已確認到哪一秒」,每輪檢查最舊那筆有沒有接上;
    //   接不上就立刻用 backfill 的有界模式把缺口補完,補完才推進指標。
    this.confirmedKey = `monitor_confirmed_${this.targetAddress.toLowerCase()}`;
    this.confirmedTs = null;      // 由 start() 從 sync_state 載入
    this.gapRepairs = 0;
    this.gapItems = 0;
  }

  async start() {
    if (this.isPolling) return;
    this.isPolling = true;
    const saved = await getSyncState(this.confirmedKey);
    const savedTs = saved ? parseInt(saved, 10) : NaN;
    this.confirmedTs = Number.isFinite(savedTs) && savedTs > 0 ? savedTs : null;
    console.log(`[Monitor] Real-time monitoring STARTED for target trader: ${this.targetAddress}`);
    console.log(`[Monitor] Polling interval: ${this.pollIntervalMs}ms`);
    console.log(this.confirmedTs
      ? `[Monitor] 已確認到 ${new Date(this.confirmedTs * 1000).toISOString()}；`
        + `這之後的缺口會自動回補`
      : `[Monitor] 無已確認位置（首次啟動）—— 本輪之後才開始守缺口`);

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
      // limit 提高到 100(API 上限):2 秒內的爆量不該塞不下。
      // ⚠ 但這只是降低機率,真正的保險是下面的缺口偵測 —— limit 再大都可能不夠。
      const url = `https://data-api.polymarket.com/activity?user=${this.targetAddress}&limit=100`;
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000
      });

      const activities = response.data;
      if (!Array.isArray(activities) || activities.length === 0) return;

      // ── 缺口偵測:本輪最舊那筆有沒有接上「已確認位置」 ──────────────
      // activity feed 是新→舊排序,所以 activities 最後一筆最舊。
      const oldestTs = activities[activities.length - 1]?.timestamp;
      if (this.confirmedTs && Number.isFinite(oldestTs) && oldestTs > this.confirmedTs + 1) {
        // 中間有一段沒抓到 —— 立刻補,補完才推進指標
        const { backfillHistory } = require('./backfill');
        try {
          const r = await backfillHistory({
            targetAddress: this.targetAddress,
            endTs: oldestTs,
            stopAtTs: this.confirmedTs,
            maxPages: 200,
          });
          this.gapRepairs += 1;
          this.gapItems += r.totalInserted;
          console.warn(`[Monitor] ⚠ 偵測到缺口 `
            + `${new Date(this.confirmedTs * 1000).toISOString()} → `
            + `${new Date(oldestTs * 1000).toISOString()}，`
            + `已回補 ${r.totalInserted} 筆（累計修補 ${this.gapRepairs} 次 / ${this.gapItems} 筆）`);
        } catch (e) {
          // 補不起來就**不要推進指標** —— 缺口留著,下一輪再試。
          console.error(`[Monitor] ⚠⚠ 缺口回補失敗：${e.message}；不推進已確認位置`);
          this.emit('gap_unrepaired', { from: this.confirmedTs, to: oldestTs, error: e.message });
          return;
        }
      }

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

      // 只有在「沒有未修補的缺口」時才推進已確認位置
      const newestTs = activities[0]?.timestamp;
      if (Number.isFinite(newestTs) && (!this.confirmedTs || newestTs > this.confirmedTs)) {
        this.confirmedTs = newestTs;
        await setSyncState(this.confirmedKey, newestTs);
      }

      this.emit('heartbeat', {
        timestamp: Math.floor(Date.now() / 1000),
        seenCount: this.seenHashes.size,
        confirmedTs: this.confirmedTs,
        gapRepairs: this.gapRepairs,
        gapItems: this.gapItems,
      });

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
