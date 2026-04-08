/* ═══════════════════════════════════════════════════════
   Lucky 539 — Frontend Application
   ═══════════════════════════════════════════════════════ */

'use strict';

// ─── State ──────────────────────────────────────────────
let currentLottery = '539'; // '539' or 'calif'
let allDraws    = [];
let statsData   = null;
let predData    = null;
let histPage    = 1;
let histFilter  = '';
const PAGE_SIZE = 30;

const LOTTERY_META = {
  '539':   { name: '今彩539', icon: '🎯', brand: '今彩539<span class="brand-sub"> 智能分析系統</span>' },
  'calif': { name: '加州天天樂', icon: '🌴', brand: '加州天天樂<span class="brand-sub"> 智能分析系統</span>' }
};

function apiQ(base, extra = '') {
  const sep = base.includes('?') ? '&' : '?';
  const lq  = currentLottery === 'calif' ? `${sep}lottery=calif` : '';
  return base + lq + (extra ? (lq ? '&' : sep) + extra : '');
}

let freqChartInst    = null;
let gapChartInst     = null;
let freqAllChartInst = null;
let oddEvenChartInst = null;
let rangeChartInst   = null;
let sumChartInst     = null;

// ─── Helpers ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = n => String(n).padStart(2, '0');

/**
 * 把9碼官方期號 (e.g. "115000059") 轉為 "第115000059期"
 * 相容舊7碼格式
 */
function fmtPeriod(p) {
  if (!p) return '─';
  return `第${p}期`;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Chart defaults ──────────────────────────────────────
Chart.defaults.color          = '#94a3b8';
Chart.defaults.borderColor    = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family    = "'Noto Sans TC', sans-serif";

// ─── Lottery switcher ────────────────────────────────────
document.querySelectorAll('.lottery-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.dataset.lottery === currentLottery) return;
    currentLottery = btn.dataset.lottery;

    document.querySelectorAll('.lottery-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const meta = LOTTERY_META[currentLottery];
    $('brandText').innerHTML = meta.brand;

    // Reset state
    allDraws   = [];
    statsData  = null;
    predData   = null;
    histPage   = 1;
    histFilter = '';
    $('searchInput').value = '';

    await loadAll();
  });
});

// ─── Navigation ──────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    $('sec-' + btn.dataset.section).classList.add('active');

    // Lazy render on first open
    if (btn.dataset.section === 'analysis' && statsData)  renderAnalysis();
    if (btn.dataset.section === 'predict'  && predData)   renderPredictSection();
    if (btn.dataset.section === 'history'  && allDraws.length) renderHistory();
  });
});

// ─── Refresh button ───────────────────────────────────────
$('refreshBtn').addEventListener('click', async () => {
  $('refreshBtn').classList.add('spinning');
  await fetch(apiQ('/api/refresh'), { method: 'POST' }).catch(() => {});
  await delay(800);
  await loadAll();
  $('refreshBtn').classList.remove('spinning');
});

// ─── Regen button ─────────────────────────────────────────
$('regenBtn').addEventListener('click', async () => {
  try {
    const r = await fetch(apiQ('/api/predict'));
    predData = await r.json();
    renderPredictSection();
    renderHeroPred();
  } catch (e) { console.error(e); }
});

// ─── Particle canvas ─────────────────────────────────────
function initParticles() {
  const canvas = $('particleCanvas');
  const ctx    = canvas.getContext('2d');

  const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  resize();
  window.addEventListener('resize', resize);

  const particles = Array.from({ length: 60 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    r: Math.random() * 1.5 + 0.5,
    dx: (Math.random() - 0.5) * 0.3,
    dy: (Math.random() - 0.5) * 0.3,
    a: Math.random()
  }));

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x = (p.x + p.dx + canvas.width)  % canvas.width;
      p.y = (p.y + p.dy + canvas.height) % canvas.height;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,160,255,${p.a * 0.4})`;
      ctx.fill();
    });
    requestAnimationFrame(frame);
  }
  frame();
}

// ─── Balls renderer ──────────────────────────────────────
function makeBall(num, type = 'latest', delay = 0) {
  const el = document.createElement('div');
  el.className = `ball ${type}`;
  el.textContent = fmt(num);
  el.style.animationDelay = `${delay}ms`;
  return el;
}

function renderBalls(containerId, numbers, type) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';
  numbers.forEach((n, i) => container.appendChild(makeBall(n, type, i * 80)));
}

// ─── Update badge ─────────────────────────────────────────
function setStatus(text, loading = false) {
  $('updateText').textContent = text;
  const dot = document.querySelector('.badge-dot');
  if (loading) dot.classList.add('loading'); else dot.classList.remove('loading');
}

// ─── Load all data ────────────────────────────────────────
async function loadAll() {
  showLoading(true);
  setStatus('更新中…', true);

  try {
    // Parallel fetch
    const [statsRes, predRes, latestRes, drawsRes] = await Promise.all([
      fetch(apiQ('/api/stats')),
      fetch(apiQ('/api/predict')),
      fetch(apiQ('/api/latest')),
      fetch(apiQ('/api/draws', 'limit=10000'))
    ]);

    if (!statsRes.ok) throw new Error('stats fetch failed');

    statsData = await statsRes.json();
    predData  = await predRes.json();
    const latest = await latestRes.json();
    const drawsJson = await drawsRes.json();
    allDraws = drawsJson.data || [];

    renderDashboard(latest);
    renderAnalysis();
    renderPredictSection();
    renderHistory();

    const now = new Date();
    setStatus(`已更新 ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`);
    showLoading(false);

    // Start background polling for new data
    schedulePoll();

  } catch (e) {
    console.error('[loadAll]', e);
    setStatus('載入失敗，請重試');
    showLoading(false);
  }
}

// ─── Background polling ───────────────────────────────────
function schedulePoll() {
  setTimeout(async () => {
    try {
      setStatus('檢查更新中…', true);
      const r = await fetch(apiQ('/api/status'));
      const s = await r.json();
      if (!s.updating) {
        // Check if server has new data
        const r2 = await fetch(apiQ('/api/stats'));
        const newStats = await r2.json();
        if (newStats.totalDraws !== statsData.totalDraws) {
          await loadAll();
          return;
        }
      }
      const now = new Date();
      setStatus(`上次更新 ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`);
    } catch (_) {}
    schedulePoll(); // reschedule
  }, 5 * 60 * 1000); // every 5 min
}

// ─── Loading overlay ──────────────────────────────────────
function showLoading(visible) {
  const el = $('loadingOverlay');
  if (visible) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

// ─── Dashboard ────────────────────────────────────────────
function renderDashboard(latest) {
  // Latest balls
  if (latest) {
    renderBalls('latestBalls', latest.numbers, 'latest');
    $('latestMeta').textContent = `${fmtPeriod(latest.period)} | ${latest.date}`;
    $('latestSum').textContent  = `總和: ${latest.numbers.reduce((a, b) => a + b, 0)}`;
  }

  // Prediction balls (hero)
  renderHeroPred();

  // KPI cards
  if (statsData) {
    $('kpiTotal').textContent = statsData.totalDraws.toLocaleString();
    $('kpiHot').textContent   = fmt(statsData.hot10[0]);
    $('kpiCold').textContent  = fmt(statsData.cold10[0]);

    // Earliest date from draws
    if (allDraws.length) {
      const earliest = allDraws[allDraws.length - 1];
      const yr = earliest.date ? earliest.date.slice(0, 4) : '─';
      $('kpiDate').textContent = yr + ' 年';
    }

    // Charts
    buildFreqChart();
    buildGapChart();
    buildHeatmap();
    renderHotCold();
  }
}

function renderHeroPred() {
  if (!predData) return;
  renderBalls('predictBalls', predData.numbers, 'pred');
  $('confBadge').textContent = `${predData.confidence}%`;
}

// ─── Frequency chart ──────────────────────────────────────
function buildFreqChart() {
  const nums    = statsData.numbers;
  const labels  = nums.map(n => fmt(n.num));
  const values  = nums.map(n => n.freq);
  const maxF    = Math.max(...values);
  const colors  = values.map(v => {
    const t = v / maxF;
    if (t > .75) return 'rgba(239,68,68,0.75)';
    if (t > .50) return 'rgba(245,158,11,0.75)';
    if (t > .25) return 'rgba(124,58,237,0.75)';
    return 'rgba(37,99,235,0.75)';
  });

  if (freqChartInst) freqChartInst.destroy();

  freqChartInst = new Chart($('freqChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '出現次數',
        data: values,
        backgroundColor: colors,
        borderRadius: 4,
        borderWidth: 0,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { title: i => `號碼 ${i[0].label}`, label: i => `出現 ${i.raw} 次` }
      }},
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

// ─── Gap chart ────────────────────────────────────────────
function buildGapChart() {
  const nums   = [...statsData.numbers].sort((a, b) => b.gap - a.gap).slice(0, 20);
  const labels = nums.map(n => fmt(n.num));
  const values = nums.map(n => n.gap);
  const colors = values.map(v => v > 30 ? 'rgba(239,68,68,.75)' : v > 15 ? 'rgba(245,158,11,.75)' : 'rgba(37,99,235,.75)');

  if (gapChartInst) gapChartInst.destroy();

  gapChartInst = new Chart($('gapChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '遺漏期數',
        data: values,
        backgroundColor: colors,
        borderRadius: 4,
        borderWidth: 0
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { title: i => `號碼 ${i[0].label}`, label: i => `遺漏 ${i.raw} 期` }
      }},
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });
}

// ─── Heatmap ──────────────────────────────────────────────
function buildHeatmap() {
  const hm    = $('heatmap');
  const nums  = statsData.numbers;
  const maxF  = Math.max(...nums.map(n => n.freq));
  const minF  = Math.min(...nums.map(n => n.freq));

  hm.innerHTML = '';

  // Build 13 cols × 3 rows = 39 cells
  for (let i = 1; i <= 39; i++) {
    const stat = nums.find(n => n.num === i);
    const t    = stat ? (stat.freq - minF) / (maxF - minF || 1) : 0;

    const cell  = document.createElement('div');
    cell.className = 'hm-cell';

    // Color: cold blue → purple → hot red
    const r = Math.round(30  + t * 220);
    const g = Math.round(50  + t * 20);
    const b = Math.round(180 - t * 130);
    const a = 0.4 + t * 0.55;
    cell.style.background = `rgba(${r},${g},${b},${a})`;
    cell.style.color = t > 0.5 ? '#fff' : '#c4b5fd';
    cell.title = `號碼 ${fmt(i)} — 出現 ${stat?.freq ?? 0} 次 (${stat?.pct ?? 0}%)`;
    cell.textContent = fmt(i);

    hm.appendChild(cell);
  }
}

// ─── Hot / Cold pills ─────────────────────────────────────
function renderHotCold() {
  const hot  = $('hotNums');
  const cold = $('coldNums');
  hot.innerHTML  = '';
  cold.innerHTML = '';

  statsData.hot10.forEach((num, i) => {
    const el = document.createElement('div');
    el.className = 'num-pill hot';
    el.textContent = fmt(num);
    el.innerHTML   = fmt(num) + `<span class="pill-rank">${i + 1}</span>`;
    el.title = `號碼 ${fmt(num)}`;
    hot.appendChild(el);
  });

  statsData.cold10.forEach((num, i) => {
    const el = document.createElement('div');
    el.className = 'num-pill cold';
    el.innerHTML = fmt(num) + `<span class="pill-rank">${i + 1}</span>`;
    el.title = `號碼 ${fmt(num)}`;
    cold.appendChild(el);
  });
}

// ─── Analysis section ─────────────────────────────────────
function renderAnalysis() {
  if (!statsData || !$('sec-analysis').classList.contains('active')) return;

  buildFreqAllChart();
  buildOddEvenChart();
  buildRangeChart();
  buildSumChart();
  buildStatsTable();
}

function buildFreqAllChart() {
  const nums   = statsData.numbers;
  const maxF   = Math.max(...nums.map(n => n.freq));

  if (freqAllChartInst) freqAllChartInst.destroy();

  freqAllChartInst = new Chart($('freqAllChart'), {
    type: 'bar',
    data: {
      labels: nums.map(n => fmt(n.num)),
      datasets: [
        {
          label: '全區間出現次數',
          data: nums.map(n => n.freq),
          backgroundColor: nums.map(n => {
            const t = n.freq / maxF;
            if (t > .75) return 'rgba(239,68,68,.7)';
            if (t > .50) return 'rgba(245,158,11,.7)';
            if (t > .25) return 'rgba(124,58,237,.7)';
            return 'rgba(37,99,235,.7)';
          }),
          borderRadius: 5,
          borderWidth: 0,
          order: 1
        },
        {
          label: '近100期出現',
          data: nums.map(n => n.recentFreq),
          type: 'line',
          borderColor: 'rgba(6,182,212,.8)',
          backgroundColor: 'rgba(6,182,212,.08)',
          borderWidth: 2,
          pointRadius: 2,
          fill: false,
          tension: 0.3,
          order: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: { callbacks: { title: i => `號碼 ${i[0].label}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

function buildOddEvenChart() {
  if (!allDraws.length) return;

  let odd = 0, even = 0;
  allDraws.forEach(d => d.numbers.forEach(n => { if (n % 2 === 0) even++; else odd++; }));

  if (oddEvenChartInst) oddEvenChartInst.destroy();

  oddEvenChartInst = new Chart($('oddEvenChart'), {
    type: 'doughnut',
    data: {
      labels: ['奇數', '偶數'],
      datasets: [{ data: [odd, even], backgroundColor: ['rgba(124,58,237,.7)', 'rgba(37,99,235,.7)'], borderWidth: 0, hoverOffset: 6 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } }
    }
  });
}

function buildRangeChart() {
  if (!allDraws.length) return;

  let low = 0, mid = 0, high = 0;
  allDraws.forEach(d => d.numbers.forEach(n => {
    if (n <= 13) low++;
    else if (n <= 26) mid++;
    else high++;
  }));

  if (rangeChartInst) rangeChartInst.destroy();

  rangeChartInst = new Chart($('rangeChart'), {
    type: 'doughnut',
    data: {
      labels: ['低段 1–13', '中段 14–26', '高段 27–39'],
      datasets: [{ data: [low, mid, high], backgroundColor: ['rgba(37,99,235,.7)', 'rgba(124,58,237,.7)', 'rgba(239,68,68,.7)'], borderWidth: 0, hoverOffset: 6 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } }
    }
  });
}

function buildSumChart() {
  if (!allDraws.length) return;

  const sums    = allDraws.map(d => d.numbers.reduce((a, b) => a + b, 0));
  const minSum  = Math.min(...sums);
  const maxSum  = Math.max(...sums);
  const buckets = 20;
  const step    = Math.ceil((maxSum - minSum + 1) / buckets);

  const counts = Array(buckets).fill(0);
  sums.forEach(s => {
    const idx = Math.min(Math.floor((s - minSum) / step), buckets - 1);
    counts[idx]++;
  });

  const labels = counts.map((_, i) => `${minSum + i * step}`);

  if (sumChartInst) sumChartInst.destroy();

  sumChartInst = new Chart($('sumChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '出現次數',
        data: counts,
        backgroundColor: 'rgba(124,58,237,.65)',
        borderRadius: 4,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { title: i => `總和 ~${i[0].label}` }
      }},
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0 } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

function buildStatsTable() {
  const tbody = $('statsBody');
  tbody.innerHTML = '';
  const maxFreq = statsData.maxFreq;

  statsData.numbers.forEach(n => {
    const hotness = n.recentFreq / (100 * 5 / 39);
    let badgeHtml = '';
    if (hotness > 1.3)      badgeHtml = '<span class="badge-hot">熱門</span>';
    else if (hotness < 0.7) badgeHtml = '<span class="badge-cold">冷門</span>';
    else                    badgeHtml = '<span class="badge-warm">正常</span>';

    const barPct = Math.round((n.freq / maxFreq) * 100);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div style="display:flex;align-items:center;gap:8px">
        <div style="width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 38% 32%,#fde68a,#d97706 80%);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#1a0800;font-family:Orbitron,monospace">${fmt(n.num)}</div>
      </div></td>
      <td><strong>${n.freq.toLocaleString()}</strong></td>
      <td>${n.pct}%</td>
      <td>${n.recentFreq} 次</td>
      <td style="color:${n.gap > 30 ? '#ef4444' : n.gap > 15 ? '#f59e0b' : '#60a5fa'}">${n.gap} 期</td>
      <td>
        <div class="heat-bar-wrap">
          <div class="heat-bar" style="width:${barPct}px"></div>
          ${badgeHtml}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Prediction section ───────────────────────────────────
function renderPredictSection() {
  if (!predData || !$('sec-predict').classList.contains('active')) return;

  // Big balls
  const big = $('predictBallsLg');
  big.innerHTML = '';
  predData.numbers.forEach((n, i) => {
    const b = makeBall(n, 'pred', i * 100);
    big.appendChild(b);
  });

  // Confidence bar
  const conf = predData.confidence || 0;
  $('confBar').style.width = `${conf}%`;
  $('confVal').textContent = `${conf}%`;

  // Detail cards
  const grid = $('predictDetail');
  grid.innerHTML = '';
  if (predData.details) {
    predData.details.forEach(d => {
      const card = document.createElement('div');
      card.className = 'detail-card';
      card.innerHTML = `
        <div class="detail-num">${fmt(d.num)}</div>
        <div class="detail-row">出現次數 <span>${d.freq}</span></div>
        <div class="detail-row">近期出現 <span>${d.recentFreq}/100期</span></div>
        <div class="detail-row">遺漏值 <span style="color:${d.gap>20?'#ef4444':'#60a5fa'}">${d.gap} 期</span></div>
        <div class="detail-row">綜合評分 <span style="color:#a78bfa">${d.score}</span></div>
        <div class="detail-score" style="width:${Math.min(d.score,100)}%"></div>
      `;
      grid.appendChild(card);
    });
  }

  // Multi predictions
  renderMultiPred();
}

async function renderMultiPred() {
  const cont = $('multiPred');
  cont.innerHTML = '<div style="color:var(--sub);font-size:13px;padding:10px 0">正在生成多組推薦…</div>';

  const labels  = ['穩健型', '均衡型', '積極型', '冷門型', '熱門型'];
  const results = [];

  // Generate 5 different predictions via the API + local variation
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(apiQ('/api/predict'));
      const p = await r.json();
      results.push({ label: labels[i], numbers: p.numbers, conf: p.confidence });
    } catch (_) {
      results.push({ label: labels[i], numbers: predData.numbers, conf: predData.confidence });
    }
  }

  cont.innerHTML = '';
  results.forEach(res => {
    const row = document.createElement('div');
    row.className = 'multi-row';

    const ballsHtml = res.numbers.map((n, i) => `
      <div class="ball pred" style="animation-delay:${i*60}ms;width:44px;height:44px;font-size:16px">${fmt(n)}</div>
    `).join('');

    row.innerHTML = `
      <div class="multi-label">${res.label}</div>
      <div class="multi-balls">${ballsHtml}</div>
      <div style="margin-left:auto;font-size:12px;color:var(--sub)">信心 ${res.conf}%</div>
    `;
    cont.appendChild(row);
  });
}

// ─── History ──────────────────────────────────────────────
function renderHistory() {
  if (!$('sec-history').classList.contains('active')) return;

  const filtered = filterDraws(histFilter);
  $('totalBadge').textContent = `共 ${filtered.length} 期`;

  renderHistoryPage(filtered, histPage);
  renderPagination(filtered.length);
}

function filterDraws(q) {
  if (!q) return allDraws;
  return allDraws.filter(d =>
    d.period.includes(q) ||
    (d.date && d.date.includes(q)) ||
    d.numbers.some(n => fmt(n) === q || String(n) === q)
  );
}

function renderHistoryPage(draws, page) {
  const tbody = $('historyBody');
  tbody.innerHTML = '';
  const start = (page - 1) * PAGE_SIZE;
  const slice = draws.slice(start, start + PAGE_SIZE);

  slice.forEach((draw, i) => {
    const tr = document.createElement('tr');
    const sum = draw.numbers.reduce((a, b) => a + b, 0);

    const ballsHtml = draw.numbers.map(n =>
      `<div class="mini-ball">${fmt(n)}</div>`
    ).join('');

    tr.innerHTML = `
      <td style="color:var(--muted);font-size:12px">${start + i + 1}</td>
      <td style="font-size:12px;color:var(--sub);line-height:1.5">${fmtPeriod(draw.period)}</td>
      <td style="font-size:13px;color:var(--sub)">${draw.date || '─'}</td>
      <td><div class="history-balls">${ballsHtml}</div></td>
      <td style="font-family:Orbitron,monospace;font-size:14px;font-weight:700;color:var(--gold)">${sum}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPagination(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const pag   = $('pagination');
  pag.innerHTML = '';

  if (pages <= 1) return;

  const makeBtn = (label, page, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled    = disabled;
    btn.addEventListener('click', () => {
      histPage = page;
      const filtered = filterDraws(histFilter);
      renderHistoryPage(filtered, histPage);
      renderPagination(total);
      pag.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return btn;
  };

  pag.appendChild(makeBtn('«', 1,    histPage === 1));
  pag.appendChild(makeBtn('‹', histPage - 1, histPage === 1));

  const start = Math.max(1, histPage - 2);
  const end   = Math.min(pages, histPage + 2);
  if (start > 1) pag.appendChild(makeBtn('…', start - 1, true));
  for (let p = start; p <= end; p++)
    pag.appendChild(makeBtn(p, p, false, p === histPage));
  if (end < pages) pag.appendChild(makeBtn('…', end + 1, true));

  pag.appendChild(makeBtn('›', histPage + 1, histPage === pages));
  pag.appendChild(makeBtn('»', pages,        histPage === pages));
}

// ─── Search ───────────────────────────────────────────────
let searchTimer = null;
$('searchInput').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    histFilter = e.target.value.trim();
    histPage   = 1;
    renderHistory();
  }, 250);
});

// ─── Init ─────────────────────────────────────────────────
(async () => {
  initParticles();

  // Poll until server has data
  let tries = 0;
  while (tries++ < 120) {
    try {
      const r = await fetch(apiQ('/api/status'));
      const s = await r.json();
      if (s.total > 0) break;
      if (s.updating && s.progress && s.progress.total > 0) {
        const pct = Math.round((s.progress.done / s.progress.total) * 100);
        $('loadingSub').textContent = `正在抓取歷史資料… ${s.progress.done} / ${s.progress.total} (${pct}%)`;
      } else {
        $('loadingSub').textContent = '首次啟動需要約 2-3 分鐘，請稍候…';
      }
    } catch (_) {}
    await delay(2500);
  }

  await loadAll();
})();
