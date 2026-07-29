require('dotenv').config();

module.exports = {
  DEFAULT_TARGET_ADDRESS: '0x2011550a8fd844aa22b78d0f039bb72befcb71fa',

  // Polymarket Data API
  DATA_API_URL: process.env.DATA_API_URL || 'https://data-api.polymarket.com',

  // Polygon PoS RPC List (Automatic Failover)
  POLYGON_RPC_NODES: [
    process.env.POLYGON_RPC_URL,
    'https://1rpc.io/matic',
    'https://polygon.drpc.org',
    'https://rpc.ankr.com/polygon'
  ].filter(Boolean),

  // Polling interval in ms
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '2000', 10)
};
