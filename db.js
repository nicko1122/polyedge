const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'polyedge.db');

let dbInstance = null;
let dbLock = Promise.resolve();

function withDBLock(fn) {
  const next = dbLock.then(() => fn(), () => fn());
  dbLock = next.catch(() => {});
  return next;
}

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

    -- ⚠⚠ 真正生效的去重是下面的 ux_trades_dedup,不是上面表定義的 UNIQUE。
    --
    -- 這個索引被修過三次,每次都是同一個病的不同面貌:
    --   2026-08-16  REDEEM 的 side=NULL          → 清 7,774 筆
    --   2026-08-19  MAKER_REBATE 的 condition_id=NULL → 又清 10 筆
    --               (首修只 COALESCE 了 side/outcome,漏掉 condition_id)
    --   2026-08-20  REDEEM 的 outcome 填法不一致  → 又清 220 筆
    --               同一筆鏈上贖回被抓兩次,tx / timestamp / condition_id / size
    --               全同,**只差 outcome:一次 NULL、一次 'Up'**。而 outcome 在
    --               鍵裡 → COALESCE(NULL,'')='' ≠ 'Up' → 兩列都放行。
    --
    -- 兩條教訓,順序不能顛倒:
    --   ① SQLite 的 UNIQUE 不把兩個 NULL 視為相等 → 每個可為 NULL 的欄都要 COALESCE
    --   ② **COALESCE 還不夠** —— 欄位若不屬於該筆紀錄的「經濟身分」,
    --      放進鍵裡就會在填法不一致時放行重複。REDEEM 由
    --      (wallet, tx, condition_id, timestamp, size) 唯一決定;
    --      outcome/side 是 TRADE 的身分(UP≠DOWN),不是 REDEEM 的。
    --      所以用 CASE 讓鍵隨 type 變 —— 對 TRADE 完全等價(實測違規組 0),
    --      對 REDEEM 才把那兩欄排除。
    --
    -- ⚠ 查重複時用的鍵必須跟索引一致:用較鬆的鍵查會把同一 tx 的 UP/DOWN
    --   兩腿誤判成重複(2026-08-19 因此虛報 223 組)。
    -- ⚠ 索引一度只存在於營運中的資料庫、不在這個檔裡 —— 重建就完全沒有去重,
    --   而症狀要幾天後做分析才浮現。
    CREATE UNIQUE INDEX IF NOT EXISTS ux_trades_dedup ON trades(
      proxy_wallet,
      COALESCE(transaction_hash, ''),
      COALESCE(condition_id, ''),
      timestamp,
      type,
      CASE WHEN type = 'REDEEM' THEN '' ELSE COALESCE(side, '') END,
      CASE WHEN type = 'REDEEM' THEN '' ELSE COALESCE(outcome, '') END,
      size
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
  if (!Array.isArray(tradesList) || tradesList.length === 0) return 0;

  return withDBLock(async () => {
    const db = await getDB();
    const stmt = await db.prepare(`
      -- ⚠ 表上的 UNIQUE(transaction_hash, condition_id, timestamp, side, size)
      -- 對 REDEEM 無效:SQLite 的 UNIQUE 不把兩個 NULL 視為相等,而 REDEEM 的
      -- side 是 NULL → 每跑一次 backfill 就多插一份(2026-08-16 清出 7,774 筆
      -- 重複)。真正生效的是 ux_trades_dedup 索引(COALESCE 正規化 NULL)。
      INSERT OR IGNORE INTO trades (
        proxy_wallet, timestamp, condition_id, type, side, size, usdc_size,
        price, asset, outcome, outcome_index, title, slug, event_slug,
        transaction_hash, is_btc_5m
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let insertedCount = 0;
    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const t of tradesList) {
        const btc = isBtc5m(t.slug, t.title);
        const res = await stmt.run(
          // ⚠ 這裡曾經寫死 fallback 到對手地址 '0x2011550a…'。
          // 資料庫現在同時存多個錢包(2026-08-20 起也存我們自己的 funder),
          // 一旦 API 少給 proxyWallet,那些列會全部被掛到對手名下 ——
          // 而且不會報錯,只會讓兩個人的帳混在一起。缺就丟,不要猜。
          (() => {
            const w = t.proxyWallet || t.user;
            if (!w) throw new Error('activity 列缺 proxyWallet/user —— 不猜錢包');
            return String(w).toLowerCase();
          })(),
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
      try { await db.exec('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      await stmt.finalize();
    }

    return insertedCount;
  });
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
