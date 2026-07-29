// PolyEdge Dashboard Client Application

let ws = null;
let currentTargetAddress = '0x2011550a8fd844aa22b78d0f039bb72befcb71fa';
let liveTradesCount = 0;

// Chart Instances
let chartDirection = null;
let chartPrices = null;
let chartHourly = null;

// Explorer State
let explorerPage = 1;

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initWebSocket();
  fetchStatusAndAnalytics();
  initExplorer();
  initBackfill();

  // Target Address Switcher
  const btnSwitch = document.getElementById('btnSwitchAddr');
  const inputAddr = document.getElementById('targetAddrInput');

  async function switchTargetAddress() {
    const newAddr = (inputAddr.value || '').trim();
    if (!newAddr.startsWith('0x') || newAddr.length !== 42) {
      alert('請輸入有效的 42 位 Ethereum/Polygon 錢包地址 (以 0x 開頭)');
      return;
    }

    btnSwitch.disabled = true;
    btnSwitch.innerText = '切換中...';

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetAddress: newAddr })
      });
      const data = await res.json();

      if (res.ok) {
        currentTargetAddress = data.targetAddress;
        alert(`已成功將監視目標切換至:\n${currentTargetAddress}`);

        // Reset live feed UI
        document.getElementById('btnClearFeed').click();

        // Refresh all views
        fetchStatusAndAnalytics();
        loadExplorerTrades();
        loadSlugsTable();

        // Trigger automatic initial backfill for newly switched address
        fetch('/api/backfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxPages: 20 })
        });

      } else {
        alert('切換失敗: ' + data.error);
      }
    } catch (err) {
      alert('切換發生錯誤: ' + err.message);
    } finally {
      btnSwitch.disabled = false;
      btnSwitch.innerText = '切換監視';
    }
  }

  if (btnSwitch) btnSwitch.addEventListener('click', switchTargetAddress);
  if (inputAddr) {
    inputAddr.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') switchTargetAddress();
    });
  }

  // Copy Address Button
  document.getElementById('btnCopyAddr').addEventListener('click', () => {
    const addr = inputAddr ? inputAddr.value : currentTargetAddress;
    navigator.clipboard.writeText(addr);
    alert('已複製目標地址: ' + addr);
  });

  // Clear Stream Feed Button
  document.getElementById('btnClearFeed').addEventListener('click', () => {
    const feed = document.getElementById('streamFeed');
    feed.innerHTML = `
      <div class="empty-placeholder">
        <p>已清空串流列表。等待新交易...</p>
      </div>
    `;
    liveTradesCount = 0;
    document.getElementById('liveTickerCount').innerText = '即時筆數: 0';
  });

  // Filter Event Listeners
  document.getElementById('streamMarketFilter').addEventListener('change', filterStreamItems);
  document.getElementById('streamSideFilter').addEventListener('change', filterStreamItems);
});

// --- Tab Navigation ---
function initTabs() {
  const btns = document.querySelectorAll('.tab-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');

      if (tabId === 'analyticsTab') {
        renderCharts();
      } else if (tabId === 'explorerTab') {
        loadExplorerTrades();
      } else if (tabId === 'slugsTab') {
        loadSlugsTable();
      }
    });
  });

  initSlugsTab();
}

// --- WebSocket Live Stream ---
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Connected to PolyEdge Server');
    updateStatusBadge(true);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'init') {
      updateSummaryUI(msg.data.analytics.summary);
      renderChartsData(msg.data.analytics);
    } else if (msg.type === 'new_trade') {
      handleNewTrade(msg.data);
    } else if (msg.type === 'backfill_status') {
      handleBackfillStatus(msg.data);
    } else if (msg.type === 'heartbeat') {
      updateStatusBadge(true);
    }
  };

  ws.onclose = () => {
    console.log('[WS] Connection closed. Retrying in 3s...');
    updateStatusBadge(false);
    setTimeout(initWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
    updateStatusBadge(false);
  };
}

function updateStatusBadge(isOnline) {
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');
  if (isOnline) {
    badge.style.color = '#10b981';
    badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    text.innerText = '即時監控中 (LIVE)';
  } else {
    badge.style.color = '#f43f5e';
    badge.style.borderColor = 'rgba(244, 63, 94, 0.3)';
    text.innerText = '連線中斷 (RECONNECTING)';
  }
}

// --- Live Stream Handler ---
function handleNewTrade(t) {
  const feed = document.getElementById('streamFeed');
  const emptyPlaceholder = feed.querySelector('.empty-placeholder');
  if (emptyPlaceholder) emptyPlaceholder.remove();

  liveTradesCount++;
  document.getElementById('liveTickerCount').innerText = `即時筆數: ${liveTradesCount}`;

  const isUp = (t.outcome || '').toLowerCase() === 'up';
  const isRedeem = t.type === 'REDEEM';
  
  let itemClass = 'up';
  let badgeText = '🟢 BUY UP';
  let badgeClass = 'up';

  if (isRedeem) {
    itemClass = 'redeem';
    badgeText = '💰 REDEEM';
    badgeClass = 'redeem';
  } else if (!isUp) {
    itemClass = 'down';
    badgeText = '🔴 BUY DOWN';
    badgeClass = 'down';
  }

  const dateStr = new Date((t.timestamp || Date.now() / 1000) * 1000).toLocaleTimeString('zh-TW', { hour12: false });
  const usdcVal = t.usdcSize ? `$${t.usdcSize.toFixed(2)}` : (t.size && t.price ? `$${(t.size * t.price).toFixed(2)}` : '$0.00');
  const priceVal = t.price ? `$${t.price.toFixed(3)}` : 'N/A';
  const sharesVal = t.size ? `${t.size.toFixed(2)} 股` : '';
  const txShort = t.transactionHash ? `${t.transactionHash.slice(0, 8)}...${t.transactionHash.slice(-6)}` : 'N/A';
  const btcTag = t.isBtc5m ? '<span class="handle-tag">⚡ BTC 5M</span>' : '';

  const itemEl = document.createElement('div');
  itemEl.className = `feed-item ${itemClass}`;
  itemEl.setAttribute('data-btc', t.isBtc5m ? 'true' : 'false');
  itemEl.setAttribute('data-side', t.outcome || '');

  itemEl.innerHTML = `
    <div class="item-badge ${badgeClass}">${badgeText}</div>
    <div class="item-details">
      <div class="item-title">${t.title || t.slug || 'Polymarket Option'} ${btcTag}</div>
      <div class="item-meta">
        <span>⏰ ${dateStr}</span>
        <span>🔗 Tx: <a class="tx-link" href="https://polygonscan.com/tx/${t.transactionHash}" target="_blank">${txShort}</a></span>
      </div>
    </div>
    <div class="item-metrics">
      <div class="item-price">${isRedeem ? '兌換領回' : priceVal}</div>
      <div class="item-amount">${usdcVal} ${sharesVal ? '(' + sharesVal + ')' : ''}</div>
    </div>
  `;

  feed.insertBefore(itemEl, feed.firstChild);

  // Keep list bounded to top 150 items for smooth DOM performance
  if (feed.children.length > 150) {
    feed.removeChild(feed.lastChild);
  }

  filterStreamItems();
  fetchStatusAndAnalytics(); // Refresh KPI values
}

function filterStreamItems() {
  const marketVal = document.getElementById('streamMarketFilter').value;
  const sideVal = document.getElementById('streamSideFilter').value;

  const items = document.querySelectorAll('#streamFeed .feed-item');
  items.forEach(item => {
    const isBtc = item.getAttribute('data-btc') === 'true';
    const side = item.getAttribute('data-side');

    let showMarket = true;
    if (marketVal === 'btc_5m' && !isBtc) showMarket = false;

    let showSide = true;
    if (sideVal !== 'all' && side !== sideVal) showSide = false;

    if (showMarket && showSide) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
}

// --- Fetch API & Update KPI ---
async function fetchStatusAndAnalytics() {
  try {
    const res = await fetch('/api/analytics');
    const analytics = await res.json();
    updateSummaryUI(analytics.summary);
    renderChartsData(analytics);
  } catch (err) {
    console.error('Error fetching analytics:', err);
  }
}

function updateSummaryUI(s) {
  if (!s) return;
  document.getElementById('kpiTotalVolume').innerText = `$${(s.totalBuyUsdc || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  const btcVol = s.btc5mVolumeUsdc || 0;
  const totalVol = s.totalBuyUsdc || 1;
  const share = ((btcVol / totalVol) * 100).toFixed(1);
  document.getElementById('kpiBtcVolumeShare').innerText = `BTC 5m 佔比: $${btcVol.toLocaleString(undefined, { minimumFractionDigits: 2 })} (${share}%)`;

  const pnl = s.estimatedNetPnL || 0;
  const pnlEl = document.getElementById('kpiNetPnL');
  pnlEl.innerText = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
  pnlEl.className = `kpi-value ${pnl >= 0 ? 'positive' : 'negative'}`;

  document.getElementById('kpiPnLStatus').innerText = `結算市場數: ${s.totalSettledMarkets || 0}`;

  document.getElementById('kpiWinRate').innerText = `${(s.winRate || 0).toFixed(1)}%`;
  document.getElementById('kpiWinMarkets').innerText = `獲利市場: ${s.totalWinMarkets || 0} / ${s.totalSettledMarkets || 0}`;

  document.getElementById('kpiTotalTrades').innerText = s.totalTrades || 0;
  document.getElementById('kpiRedeemCount').innerText = `兌換紅利(Redeem): ${s.totalRedemptions || 0} 筆`;
}

// --- Render Charts (Chart.js) ---
function renderChartsData(data) {
  if (!data) return;

  // Chart 1: Direction (Up vs Down)
  const dirCanvas = document.getElementById('chartDirection').getContext('2d');
  const upData = data.direction.Up || { count: 0, usdc: 0 };
  const downData = data.direction.Down || { count: 0, usdc: 0 };

  if (chartDirection) chartDirection.destroy();
  chartDirection = new Chart(dirCanvas, {
    type: 'doughnut',
    data: {
      labels: ['🟢 看漲 (UP)', '🔴 看跌 (DOWN)'],
      datasets: [{
        data: [upData.usdc, downData.usdc],
        backgroundColor: ['#10b981', '#f43f5e'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#9ca3af', font: { family: 'Outfit' } } }
      }
    }
  });

  // Chart 2: Price Brackets
  const pricesCanvas = document.getElementById('chartPrices').getContext('2d');
  const bracketLabels = (data.priceBrackets || []).map(b => b.bracket);
  const bracketCounts = (data.priceBrackets || []).map(b => b.count);

  if (chartPrices) chartPrices.destroy();
  chartPrices = new Chart(pricesCanvas, {
    type: 'bar',
    data: {
      labels: bracketLabels,
      datasets: [{
        label: '交易次數',
        data: bracketCounts,
        backgroundColor: '#06b6d4',
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#9ca3af' }, grid: { display: false } },
        y: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }
      },
      plugins: { legend: { display: false } }
    }
  });

  // Chart 3: Hourly Activity
  const hourlyCanvas = document.getElementById('chartHourly').getContext('2d');
  const hourlyLabels = (data.hourlyActivity || []).map(h => `${h.hour_utc}:00 UTC`);
  const hourlyUsdc = (data.hourlyActivity || []).map(h => h.total_usdc);

  if (chartHourly) chartHourly.destroy();
  chartHourly = new Chart(hourlyCanvas, {
    type: 'line',
    data: {
      labels: hourlyLabels,
      datasets: [{
        label: 'USDC 交易量',
        data: hourlyUsdc,
        borderColor: '#8b5cf6',
        backgroundColor: 'rgba(139, 92, 246, 0.1)',
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#9ca3af' }, grid: { display: false } },
        y: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function renderCharts() {
  fetchStatusAndAnalytics();
}

// --- Historical Backfill Manager ---
function initBackfill() {
  const btn = document.getElementById('btnStartBackfill');
  btn.addEventListener('click', async () => {
    const maxPages = document.getElementById('backfillPagesSelect').value;
    btn.disabled = true;
    document.getElementById('backfillProgressBox').classList.remove('hidden');
    document.getElementById('backfillStatusText').innerText = '正在發起歷史數據回補任務...';

    try {
      const res = await fetch('/api/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxPages })
      });
      const data = await res.json();
      console.log('Backfill trigger res:', data);
    } catch (err) {
      alert('發起回補失敗: ' + err.message);
      btn.disabled = false;
    }
  });
}

function handleBackfillStatus(state) {
  const box = document.getElementById('backfillProgressBox');
  const bar = document.getElementById('backfillProgressBar');
  const status = document.getElementById('backfillStatusText');
  const btn = document.getElementById('btnStartBackfill');

  box.classList.remove('hidden');

  if (state.status === 'running') {
    const pct = Math.min(100, Math.round((state.page / (state.maxPages || 50)) * 100));
    bar.style.width = `${pct}%`;
    status.innerText = `[處理中] 頁數: ${state.page} | 取得筆數: ${state.totalFetched} | 新寫入: ${state.totalInserted} (最舊時間: ${state.oldestDate || 'N/A'})`;
  } else if (state.status === 'completed') {
    bar.style.width = '100%';
    status.innerText = `✅ 數據回補完成! 總共抓取: ${state.totalFetched} 筆，新入庫: ${state.totalInserted} 筆。`;
    btn.disabled = false;
    fetchStatusAndAnalytics();
  } else if (state.status === 'error') {
    status.innerText = `❌ 回補失敗: ${state.error}`;
    btn.disabled = false;
  }
}

// --- Trade Explorer Tab ---
function initExplorer() {
  document.getElementById('btnExplorerSearch').addEventListener('click', () => {
    explorerPage = 1;
    loadExplorerTrades();
  });

  document.getElementById('explorerBtcFilter').addEventListener('change', () => {
    explorerPage = 1;
    loadExplorerTrades();
  });

  document.getElementById('btnPrevPage').addEventListener('click', () => {
    if (explorerPage > 1) {
      explorerPage--;
      loadExplorerTrades();
    }
  });

  document.getElementById('btnNextPage').addEventListener('click', () => {
    explorerPage++;
    loadExplorerTrades();
  });
}

async function loadExplorerTrades() {
  const search = document.getElementById('explorerSearchInput').value;
  const btcOnly = document.getElementById('explorerBtcFilter').value;

  const tbody = document.getElementById('explorerTableBody');
  tbody.innerHTML = `<tr><td colspan="8" class="text-center">載入數據中...</td></tr>`;

  try {
    const url = `/api/trades?page=${explorerPage}&limit=20&btcOnly=${btcOnly}&search=${encodeURIComponent(search)}`;
    const res = await fetch(url);
    const data = await res.json();

    document.getElementById('pageInfoText').innerText = `第 ${data.page} 頁 / 共 ${data.totalPages || 1} 頁 (總筆數: ${data.total})`;

    if (!data.trades || data.trades.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center">查無符合條件的交易紀錄</td></tr>`;
      return;
    }

    tbody.innerHTML = data.trades.map(t => {
      const dateStr = new Date(t.timestamp * 1000).toLocaleString('zh-TW');
      const isUp = (t.outcome || '').toLowerCase() === 'up';
      const isRedeem = t.type === 'REDEEM';

      let outcomeBadge = `<span class="item-badge ${isUp ? 'up' : 'down'}">${isUp ? '🟢 UP' : '🔴 DOWN'}</span>`;
      if (isRedeem) outcomeBadge = `<span class="item-badge redeem">💰 REDEEM</span>`;

      const txShort = t.transaction_hash ? `${t.transaction_hash.slice(0, 8)}...` : 'N/A';

      return `
        <tr>
          <td>${dateStr}</td>
          <td><strong>${t.type}</strong></td>
          <td>${outcomeBadge}</td>
          <td>${isRedeem ? '-' : '$' + (t.price || 0).toFixed(3)}</td>
          <td>${t.size ? t.size.toFixed(2) : '-'}</td>
          <td><strong>$${(t.usdc_size || 0).toFixed(2)}</strong></td>
          <td>${t.title || t.slug || 'N/A'}</td>
          <td><a class="tx-link" href="https://polygonscan.com/tx/${t.transaction_hash}" target="_blank">${txShort} ↗</a></td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Error loading explorer trades:', err);
    tbody.innerHTML = `<tr><td colspan="8" class="text-center">載入失敗: ${err.message}</td></tr>`;
  }
}

// --- Slugs Tab (Recent 50 By Slug) ---
function initSlugsTab() {
  const btn = document.getElementById('btnRefreshSlugs');
  if (btn) {
    btn.addEventListener('click', () => {
      loadSlugsTable();
    });
  }

  // Modal event listeners
  const modal = document.getElementById('timelineModal');
  const btnClose = document.getElementById('btnCloseTimelineModal');
  const btnCopy = document.getElementById('btnCopyTimelineText');
  const textarea = document.getElementById('timelineTextarea');

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
  }

  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(textarea.value);
      alert('已複製時間軸文字至剪貼簿！');
    });
  }
}

async function openTimelineModal(slug) {
  const modal = document.getElementById('timelineModal');
  const title = document.getElementById('timelineModalTitle');
  const textarea = document.getElementById('timelineTextarea');

  modal.classList.remove('hidden');
  textarea.value = '載入市場交易時間軸數據中...';

  try {
    const res = await fetch(`/api/timeline?slug=${encodeURIComponent(slug)}`);
    const data = await res.json();
    title.innerText = `市場交易時間軸 (${data.title || slug})`;
    textarea.value = data.text || '無數據';
  } catch (err) {
    textarea.value = '載入時間軸失敗: ' + err.message;
  }
}

async function loadSlugsTable() {
  const tbody = document.getElementById('slugsTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="text-center">載入數據中...</td></tr>`;

  try {
    const res = await fetch('/api/slugs?limit=50');
    const slugs = await res.json();

    if (!Array.isArray(slugs) || slugs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center">尚無 Slug 資料</td></tr>`;
      return;
    }

    tbody.innerHTML = slugs.map(s => {
      const pnlVal = s.pnl || 0;
      const roiVal = s.roi || 0;

      const pnlClass = pnlVal >= 0 ? 'positive' : 'negative';
      const roiClass = roiVal >= 0 ? 'up' : 'down';

      return `
        <tr>
          <td><code style="font-family: var(--font-mono); font-size: 12px; color: var(--accent-cyan);">${s.slug}</code></td>
          <td><strong class="kpi-value ${pnlClass}" style="font-size: 14px;">${pnlVal >= 0 ? '+' : ''}$${pnlVal.toFixed(2)}</strong></td>
          <td><span class="item-badge ${roiClass}">${roiVal >= 0 ? '+' : ''}${roiVal.toFixed(1)}%</span></td>
          <td><strong>$${(s.vol || 0).toFixed(2)}</strong></td>
          <td>${s.title}</td>
          <td style="font-size: 12px; color: var(--text-muted);">${s.dateStr}</td>
          <td>
            <button class="btn-secondary btn-show-timeline" data-slug="${s.slug}" style="padding: 2px 8px; font-size: 11px;">📋 時間軸</button>
          </td>
        </tr>
      `;
    }).join('');

    // Attach click handlers to Timeline buttons
    document.querySelectorAll('.btn-show-timeline').forEach(btn => {
      btn.addEventListener('click', () => {
        const slug = btn.getAttribute('data-slug');
        openTimelineModal(slug);
      });
    });

  } catch (err) {
    console.error('Error loading slugs table:', err);
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">載入失敗: ${err.message}</td></tr>`;
  }
}
