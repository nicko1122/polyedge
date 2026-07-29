const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'polyedge.db');

let dbInstance = null;

async function getDB() {
  if (dbInstance) return dbInstance;
  
  dbInstance = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proxy_wallet TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      condition_id TEXT,
      type TEXT NOT NULL,
      side TEXT,
      size REAL,
      usdc_size REAL,
      price REAL,
      asset TEXT,
      outcome TEXT,
      outcome_index INTEGER,
      title TEXT,
      slug TEXT,
      event_slug TEXT,
      transaction_hash TEXT,
      is_btc_5m INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(transaction_hash, condition_id, timestamp, side, size) ON CONFLICT IGNORE
    );

    CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(proxy_wallet);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_is_btc ON trades(is_btc_5m);
    CREATE INDEX IF NOT EXISTS idx_trades_slug ON trades(slug);

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return dbInstance;
}

function isBtc5m(slug, title) {
  const s = (slug || '').toLowerCase();
  const t = (title || '').toLowerCase();
  return (s.includes('btc-updown-5m') || (t.includes('bitcoin') && t.includes('5m'))) ? 1 : 0;
}

async function insertTrades(tradesList) {
  const db = await getDB();
  const stmt = await db.prepare(`
    INSERT OR IGNORE INTO trades (
      proxy_wallet, timestamp, condition_id, type, side, size, usdc_size,
      price, asset, outcome, outcome_index, title, slug, event_slug,
      transaction_hash, is_btc_5m
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedCount = 0;
  await db.exec('BEGIN TRANSACTION');
  try {
    for (const t of tradesList) {
      const btc = isBtc5m(t.slug, t.title);
      const res = await stmt.run(
        t.proxyWallet || t.user || '0x2011550a8fd844aa22b78d0f039bb72befcb71fa',
        t.timestamp,
        t.conditionId || null,
        t.type || 'TRADE',
        t.side || null,
        t.size || 0,
        t.usdcSize || (t.size && t.price ? t.size * t.price : 0),
        t.price || 0,
        t.asset || null,
        t.outcome || null,
        t.outcomeIndex !== undefined ? t.outcomeIndex : null,
        t.title || null,
        t.slug || null,
        t.eventSlug || null,
        t.transactionHash || null,
        btc
      );
      if (res.changes > 0) {
        insertedCount++;
      }
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  } finally {
    await stmt.finalize();
  }

  return insertedCount;
}

async function getTradesCount() {
  const db = await getDB();
  const res = await db.get('SELECT COUNT(*) as count, SUM(is_btc_5m) as btc_count FROM trades');
  return res;
}

async function setSyncState(key, value) {
  const db = await getDB();
  await db.run(
    'INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP',
    key, String(value)
  );
}

async function getSyncState(key) {
  const db = await getDB();
  const res = await db.get('SELECT value FROM sync_state WHERE key = ?', key);
  return res ? res.value : null;
}

module.exports = {
  getDB,
  insertTrades,
  getTradesCount,
  setSyncState,
  getSyncState,
  isBtc5m
};
