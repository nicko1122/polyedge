const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const { getDB, getTradesCount } = require('./db');
const { backfillHistory, DEFAULT_TARGET_ADDRESS } = require('./backfill');
const { getTraderAnalytics } = require('./analytics');
const TraderMonitor = require('./monitor');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentTargetAddress = DEFAULT_TARGET_ADDRESS;
let monitor = new TraderMonitor({ targetAddress: currentTargetAddress, pollIntervalMs: 2000 });
let isBackfilling = false;
let backfillState = { status: 'idle', progress: 0 };

// Broadcast helper for WebSocket clients
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, data: payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Attach monitor event handlers
monitor.on('trade', (t) => {
  broadcast('new_trade', t);
});

monitor.on('heartbeat', (h) => {
  broadcast('heartbeat', h);
});

// Start monitor automatically on server launch
monitor.start();

// --- REST API Endpoints ---

// 1. Status & Info
app.get('/api/status', async (req, res) => {
  try {
    const counts = await getTradesCount();
    res.json({
      targetAddress: currentTargetAddress,
      isMonitoring: monitor.isPolling,
      isBackfilling,
      backfillState,
      totalTrades: counts.count || 0,
      btc5mTrades: counts.btc_count || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Analytics Summary
app.get('/api/analytics', async (req, res) => {
  try {
    const address = req.query.address || currentTargetAddress;
    const analytics = await getTraderAnalytics(address);
    res.json(analytics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Paginated Trades List with Filters
app.get('/api/trades', async (req, res) => {
  try {
    const db = await getDB();
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '50', 10);
    const btcOnly = req.query.btcOnly === 'true';
    const side = req.query.side || null;
    const outcome = req.query.outcome || null;
    const search = req.query.search || null;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE proxy_wallet = ?';
    let params = [currentTargetAddress];

    if (btcOnly) {
      whereClause += ' AND is_btc_5m = 1';
    }
    if (side) {
      whereClause += ' AND side = ?';
      params.push(side);
    }
    if (outcome) {
      whereClause += ' AND outcome = ?';
      params.push(outcome);
    }
    if (search) {
      whereClause += ' AND (title LIKE ? OR slug LIKE ? OR transaction_hash LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (req.query.date) {
      const d = req.query.date.trim();
      const startTs = Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);
      const endTs = Math.floor(new Date(`${d}T23:59:59Z`).getTime() / 1000);
      if (!isNaN(startTs) && !isNaN(endTs)) {
        whereClause += ' AND timestamp >= ? AND timestamp <= ?';
        params.push(startTs, endTs);
      }
    } else {
      if (req.query.startTs) {
        whereClause += ' AND timestamp >= ?';
        params.push(parseInt(req.query.startTs, 10));
      }
      if (req.query.endTs) {
        whereClause += ' AND timestamp <= ?';
        params.push(parseInt(req.query.endTs, 10));
      }
    }

    const countRow = await db.get(`SELECT COUNT(*) as total FROM trades ${whereClause}`, params);
    const trades = await db.all(`
      SELECT * FROM trades 
      ${whereClause} 
      ORDER BY timestamp DESC 
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      page,
      limit,
      total: countRow.total,
      totalPages: Math.ceil(countRow.total / limit),
      trades
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Trigger Historical Backfill
app.post('/api/backfill', async (req, res) => {
  if (isBackfilling) {
    return res.status(400).json({ error: 'Backfill is already in progress.' });
  }

  const maxPages = parseInt(req.body.maxPages || '50', 10);

  isBackfilling = true;
  backfillState = { status: 'running', progress: 0, totalFetched: 0, totalInserted: 0 };
  broadcast('backfill_status', backfillState);

  res.json({ message: 'Backfill started.', maxPages });

  // Run in background
  (async () => {
    try {
      await backfillHistory({
        targetAddress: currentTargetAddress,
        maxPages,
        onProgress: (p) => {
          backfillState = p;
          broadcast('backfill_status', p);
        }
      });
    } catch (err) {
      backfillState = { status: 'error', error: err.message };
      broadcast('backfill_status', backfillState);
    } finally {
      isBackfilling = false;
      broadcast('backfill_status', { ...backfillState, status: 'completed' });
    }
  })();
});

// 5. Change Target Wallet Address
app.post('/api/config', async (req, res) => {
  const { targetAddress } = req.body;
  if (!targetAddress || !targetAddress.startsWith('0x')) {
    return res.status(400).json({ error: 'Invalid Ethereum/Polygon address' });
  }

  currentTargetAddress = targetAddress.toLowerCase();
  monitor.stop();
  monitor = new TraderMonitor({ targetAddress: currentTargetAddress, pollIntervalMs: 2000 });
  monitor.on('trade', (t) => broadcast('new_trade', t));
  monitor.on('heartbeat', (h) => broadcast('heartbeat', h));
  monitor.start();

  res.json({ message: 'Target wallet updated', targetAddress: currentTargetAddress });
});

// 6. Recent 50 Slugs with PnL, ROI, and Volume
app.get('/api/slugs', async (req, res) => {
  try {
    const db = await getDB();
    const address = req.query.address || currentTargetAddress;
    const limit = parseInt(req.query.limit || '50', 10);

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

    const slugsList = rows.map(r => {
      const vol = r.vol > 0 ? r.vol : (r.sell_vol + r.redeem_vol);
      const pnl = (r.sell_vol + r.redeem_vol) - r.vol;
      const roi = vol > 0 ? (pnl / vol) * 100 : 0;
      return {
        slug: r.slug,
        title: r.title || r.slug,
        timestamp: r.max_ts,
        dateStr: new Date(r.max_ts * 1000).toLocaleString('zh-TW'),
        vol: parseFloat(vol.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        roi: parseFloat(roi.toFixed(2)),
        tradeCount: r.trade_count
      };
    });

    res.json(slugsList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Get Market Timeline by Slug
app.get('/api/timeline', async (req, res) => {
  try {
    const { getMarketTimeline } = require('./timeline');
    const slug = req.query.slug;
    const address = req.query.address || currentTargetAddress;

    if (!slug) {
      return res.status(400).json({ error: 'Missing required query parameter: slug' });
    }

    const timelineData = await getMarketTimeline(address, slug);
    res.json(timelineData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket Connection setup
wss.on('connection', async (ws) => {
  console.log('[WS] Client connected');
  
  // Send initial state snapshot
  try {
    const counts = await getTradesCount();
    const analytics = await getTraderAnalytics(currentTargetAddress);
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        targetAddress: currentTargetAddress,
        isMonitoring: monitor.isPolling,
        totalTrades: counts.count || 0,
        btc5mTrades: counts.btc_count || 0,
        analytics
      }
    }));
  } catch (err) {
    console.error('[WS] Error sending init:', err.message);
  }

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`🚀 POLYEDGE - Polymarket Trader Monitor & Analytics`);
  console.log(`🎯 Target Trader Address: ${currentTargetAddress}`);
  console.log(`🌐 Listening on: http://${HOST}:${PORT}`);
  console.log(`=======================================================`);
});
