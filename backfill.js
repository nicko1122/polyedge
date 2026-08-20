const axios = require('axios');
const { insertTrades, setSyncState, getSyncState } = require('./db');

const DEFAULT_TARGET_ADDRESS = '0x2011550a8fd844aa22b78d0f039bb72befcb71fa';

/**
 * Backfills past activity for target address using timestamp pagination & offset pagination.
 */
async function backfillHistory(options = {}) {
  const address = options.targetAddress || DEFAULT_TARGET_ADDRESS;
  const onProgress = options.onProgress || (() => {});
  const maxPages = options.maxPages || 50; // default cap per run
  const limit = 100;

  console.log(`[Backfill] Starting historical sync for wallet: ${address}`);

  // ⚠⚠ 2026-08-20:這裡原本恆為 Date.now() —— **從來沒有讀過 sync state**。
  //   setSyncState 每頁都寫 `backfill_oldest_timestamp`,但沒有人讀它,
  //   所以每次執行都從「現在」重抓 maxPages 頁。
  //   我們自己的地址 5,000 筆剛好覆蓋 7 週,看不出來;對手一天一萬筆,
  //   5,000 筆只有 6 小時 → 連跑八批也走不回去(實測抓 39,600 筆只新增 128)。
  // ⚠ 而且那個鍵是**全域**的,沒有按地址分 —— 回填 A 會覆蓋 B 的續傳位置。
  //   兩個問題都修:鍵帶地址,而且真的拿它當起點。
  const resumeKey = `backfill_oldest_${address.toLowerCase()}`;
  let totalFetched = 0;
  let totalInserted = 0;
  let currentEndTs = Math.floor(Date.now() / 1000);
  if (options.restart !== true) {
    const saved = await getSyncState(resumeKey);
    const savedTs = saved ? parseInt(saved, 10) : NaN;
    if (Number.isFinite(savedTs) && savedTs > 0) {
      currentEndTs = savedTs - 1;
      console.log(`[Backfill] Resuming from ${new Date(currentEndTs * 1000).toISOString()}`);
    }
  }
  let hasMore = true;
  let pageCount = 0;

  onProgress({ status: 'started', totalFetched, totalInserted, pageCount });

  while (hasMore && pageCount < maxPages) {
    pageCount++;
    try {
      // Query Polymarket Data API with end timestamp filter
      const url = `https://data-api.polymarket.com/activity?user=${address}&limit=${limit}&end=${currentEndTs}`;
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      });

      const data = response.data;
      if (!Array.isArray(data) || data.length === 0) {
        console.log('[Backfill] Reached end of historical data.');
        hasMore = false;
        break;
      }

      totalFetched += data.length;
      const inserted = await insertTrades(data);
      totalInserted += inserted;

      const oldestInBatch = data[data.length - 1];
      const oldestTs = oldestInBatch.timestamp;

      console.log(`[Backfill] Page ${pageCount}: Fetched ${data.length} items (New inserted: ${inserted}). Oldest ts in batch: ${new Date(oldestTs * 1000).toISOString()}`);

      onProgress({
        status: 'running',
        page: pageCount,
        fetchedBatch: data.length,
        insertedBatch: inserted,
        totalFetched,
        totalInserted,
        oldestTs,
        oldestDate: new Date(oldestTs * 1000).toISOString()
      });

      // ⚠⚠ 2026-08-20:這裡原本是 `currentEndTs = oldestTs - 1`,會**永久丟掉
      //   邊界那一秒的其他成交**。每頁 100 筆,結束在某一秒中間;那一秒剩下的
      //   筆數直接被 -1 跳過。實測對手 54% 的成交落在「同一秒多筆」(單秒最多
      //   15 筆),我們只有 15% —— 所以他的窗有 6% 贖回金額 > 買進持股(超額
      //   中位正好 15.00 股、53% 是整數),而我們 0/515 完全看不出來。
      //
      //   修法:邊界那一秒**保留**(end=oldestTs,不減 1),重複的由
      //   ux_trades_dedup 擋掉。代價是每頁重抓幾筆,換不丟資料。
      //   ⚠ 但這樣若整頁 100 筆都同一秒就會卡住不前進 —— 所以只有在
      //   「整頁同秒」時才被迫 -1,並明確記錄那次資料損失。
      const newestInBatch = data[0];
      if (newestInBatch && newestInBatch.timestamp === oldestTs) {
        console.warn(`[Backfill] ⚠ 整頁 ${data.length} 筆同屬 ${oldestTs} —— `
          + `被迫跳過該秒剩餘筆數(單頁上限不足以涵蓋這一秒)`);
        currentEndTs = oldestTs - 1;
      } else {
        currentEndTs = oldestTs;
      }

      await setSyncState(resumeKey, oldestTs);

      // Brief pause to respect API rate limits
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.error(`[Backfill] Error on page ${pageCount}: ${err.message}`);
      // Retry once or break if non-recoverable
      if (err.response && err.response.status === 400) {
        console.log('[Backfill] Reached API limit boundary.');
        hasMore = false;
      } else {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  onProgress({
    status: 'completed',
    totalFetched,
    totalInserted,
    pageCount
  });

  console.log(`[Backfill] Completed! Total fetched: ${totalFetched}, Total newly inserted: ${totalInserted}`);
  return { totalFetched, totalInserted, pageCount };
}

module.exports = {
  backfillHistory,
  DEFAULT_TARGET_ADDRESS
};
