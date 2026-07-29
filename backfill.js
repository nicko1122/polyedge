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

  let totalFetched = 0;
  let totalInserted = 0;
  let currentEndTs = Math.floor(Date.now() / 1000);
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

      // If the oldest timestamp in batch is equal to or greater than currentEndTs, we subtract 1 to advance
      if (oldestTs >= currentEndTs) {
        currentEndTs = currentEndTs - 1;
      } else {
        currentEndTs = oldestTs - 1; // Slide window backward
      }

      // Record sync state
      await setSyncState('backfill_oldest_timestamp', oldestTs);

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
