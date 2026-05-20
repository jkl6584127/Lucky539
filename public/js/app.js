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
let recentN     = 100;      // 使用者自訂分析期數
let analysisMode = 'recent'; // 'recent' 或 'range'
let rangeStart   = 1;        // 範圍起始 dex (1=最舊)
let rangeEnd     = 100;      // 範圍結束 dex (>=start)
const PAGE_SIZE = 30;

const LOTTERY_META = {
  '539':   { name: '今彩539',   icon: '🎯', brand: '今彩539<span class="brand-sub"> 智能分析系統</span>' },
  'lotto': { name: '大樂透',    icon: '🎰', brand: '大樂透<span class="brand-sub"> 智能分析系統</span>' },
  'super': { name: '威力彩',    icon: '⚡', brand: '威力彩<span class="brand-sub"> 智能分析系統</span>' },
  'mark6': { name: '六合彩',    icon: '🀄', brand: '六合彩<span class="brand-sub"> 智能分析系統</span>' },
  'calif': { name: '加州天天樂', icon: '🌴', brand: '加州天天樂<span class="brand-sub"> 智能分析系統</span>' },
};

function apiQ(base, extra = '') {
  const sep = base.includes('?') ? '&' : '?';
  const lq  = currentLottery !== '539' ? `${sep}lottery=${currentLottery}` : '';
  return base + lq + (extra ? (lq ? '&' : sep) + extra : '');
}

// 依目前模式組裝分析參數
function analysisQuery() {
  if (analysisMode === 'range') {
    return `startDex=${rangeStart}&endDex=${rangeEnd}`;
  }
  return `recentN=${recentN}`;
}

// 取目前分析窗口的顯示標籤,用於圖表/卡片
//   recent 模式 → "近100期" / "全部"
//   range  模式 → "第500~1000期"
function rangeLabel(src = statsData) {
  if (src && src.mode === 'range' && src.rangeStart && src.rangeEnd) {
    return `第${src.rangeStart}~${src.rangeEnd}期`;
  }
  const total = src ? src.totalDraws : 0;
  const rn = (src && src.recentN) || recentN;
  if (total && rn >= total) return '全部';
  return `近${rn}期`;
}

let freqChartInst    = null;
let gapChartInst     = null;
let freqAllChartInst = null;
let oddEvenChartInst = null;
let rangeChartInst   = null;
let sumChartInst     = null;
let specialChartInst = null;

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

    // 同步所有彩券按鈕（桌面 + 手機版）
    document.querySelectorAll('.lottery-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll(`.lottery-btn[data-lottery="${currentLottery}"]`).forEach(b => b.classList.add('active'));

    const meta = LOTTERY_META[currentLottery];
    $('brandText').innerHTML = meta.brand;

    // Reset state
    allDraws   = [];
    statsData  = null;
    predData   = null;
    histPage   = 1;
    histFilter = '';
    recentN    = 100;
    analysisMode = 'recent';
    rangeStart = 1;
    rangeEnd   = 100;
    $('searchInput').value  = '';
    $('recentNInput').value = 100;
    $('recentNSlider').value = 100;
    $('rangeStartInput').value = '';
    $('rangeEndInput').value   = '';
    setActiveSection('modeRecent');
    document.querySelectorAll('.period-quick-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.period-quick-btn[data-n="100"]').classList.add('active');

    showLoading(true);
    $('loadingSub').textContent = '正在切換彩券種類，請稍候…';
    await pollUntilReady();
    await loadAll();
  });
});

// ─── Navigation ──────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const section = btn.dataset.section;
    // 同步所有頁籤（桌面 nav-center + 手機 bottom-nav）
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll(`.nav-tab[data-section="${section}"]`).forEach(b => b.classList.add('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    $('sec-' + section).classList.add('active');

    // Lazy render on first open
    if (section === 'analysis' && statsData)    renderAnalysis();
    if (section === 'predict'  && predData)     renderPredictSection();
    if (section === 'history'  && allDraws.length) renderHistory();
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
    const r = await fetch(apiQ('/api/predict', analysisQuery()));
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

function renderBalls(containerId, numbers, type, special = null) {
  const container = $(containerId);
  if (!container || !numbers?.length) return;
  container.innerHTML = '';
  numbers.forEach((n, i) => container.appendChild(makeBall(n, type, i * 80)));
  // 特別號:在主號後加分隔符 + 紅球
  if (special != null) {
    const sep = document.createElement('span');
    sep.className = 'ball-separator';
    sep.textContent = '+';
    container.appendChild(sep);
    container.appendChild(makeBall(special, `${type} special`, numbers.length * 80));
  }
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
      fetch(apiQ('/api/stats', analysisQuery())),
      fetch(apiQ('/api/predict', analysisQuery())),
      fetch(apiQ('/api/latest')),
      fetch(apiQ('/api/draws', 'limit=10000'))
    ]);

    if (!statsRes.ok) throw new Error('stats fetch failed');

    statsData = await statsRes.json();
    predData  = predRes.ok ? await predRes.json() : null;
    if (predData && !predData.numbers) predData = null; // 過濾掉 error response
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
        const r2 = await fetch(apiQ('/api/stats', analysisQuery()));
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

// ─── Poll until server has data ───────────────────────────
async function pollUntilReady() {
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
        $('loadingSub').textContent = '首次啟動需要約 1-2 分鐘，請稍候…';
      }
    } catch (_) {}
    await delay(2500);
  }
}

// ─── Dashboard ────────────────────────────────────────────
function renderDashboard(latest) {
  // Latest balls
  if (latest) {
    renderBalls('latestBalls', latest.numbers, 'latest', latest.special);
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

    // 設定期數選擇器上限
    updatePeriodSelector();

    // Charts
    buildFreqChart();
    buildGapChart();
    buildHeatmap();
    renderHotCold();
    buildSpecialAnalysis();
  }
}

// ─── Period selector logic ───────────────────────────────
function updatePeriodSelector() {
  const total = statsData.totalDraws;
  const slider = $('recentNSlider');
  const input  = $('recentNInput');

  slider.max = total;
  input.max  = total;
  $('periodMaxLabel').textContent = total.toLocaleString();

  // 確保 recentN 不超過歷史總期數
  if (recentN > total) {
    recentN = total;
    slider.value = recentN;
    input.value  = recentN;
  }

  // 範圍輸入框: 動態更新 placeholder (最新 dex == totalDraws)
  $('rangeStartInput').max = total;
  $('rangeEndInput').max   = total;
  $('rangeStartInput').placeholder = `最舊 0001`;
  $('rangeEndInput').placeholder   = `最新 (${total})`;

  // 更新所有分析範圍標籤
  updateRecentLabels();
}

function updateRecentLabels() {
  // .recentN-label 元素顯示整段標籤:「近100期」/「全部」/「第500~1000期」
  const label = analysisMode === 'range'
    ? `第${rangeStart}~${rangeEnd}期`
    : (recentN >= statsData.totalDraws ? '全部' : `近${recentN}期`);
  document.querySelectorAll('.recentN-label').forEach(el => {
    el.textContent = label;
  });
}

function renderHeroPred() {
  if (!predData?.numbers) return;
  renderBalls('predictBalls', predData.numbers, 'pred', predData.special);
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
  const hm     = $('heatmap');
  const nums   = statsData.numbers;
  const maxNum = statsData.maxNum || 39;
  const maxF   = Math.max(...nums.map(n => n.freq));
  const minF   = Math.min(...nums.map(n => n.freq));

  // 39 球: 13 cols × 3 rows; 49 球: 7 cols × 7 rows
  const cols = maxNum === 49 ? 7 : 13;
  hm.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  hm.innerHTML = '';

  for (let i = 1; i <= maxNum; i++) {
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
// ─── 特別號分析 (僅大樂透 / 六合彩 / 威力彩) ─────────────
function buildSpecialAnalysis() {
  const card = $('specialAnalysisCard');
  if (!card) return;

  if (!statsData || !statsData.specialMax || !statsData.specialNumbers) {
    card.style.display = 'none';
    if (specialChartInst) { specialChartInst.destroy(); specialChartInst = null; }
    return;
  }

  card.style.display = '';
  $('specialAnalysisHint').textContent =
    `共 ${statsData.totalDraws.toLocaleString()} 期 · 分析範圍 ${rangeLabel()}`;

  const sNums = statsData.specialNumbers;
  const labels = sNums.map(n => fmt(n.num));
  const values = sNums.map(n => n.freq);
  const maxF   = Math.max(...values, 1);

  const ctx = $('specialFreqChart').getContext('2d');
  if (specialChartInst) specialChartInst.destroy();
  specialChartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '出現次數',
        data: values,
        backgroundColor: values.map(v => {
          const t = v / maxF;
          if (t > .80) return 'rgba(220,38,38,.85)';
          if (t > .60) return 'rgba(239,68,68,.7)';
          if (t > .40) return 'rgba(245,158,11,.65)';
          return 'rgba(96,165,250,.5)';
        }),
        borderRadius: 6,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const n = sNums[c.dataIndex];
              return [
                `出現 ${n.freq} 次 (${n.pct}%)`,
                `${rangeLabel()}: ${n.recentFreq} 次`,
                `距上次: ${n.gap} 期`
              ];
            }
          }
        }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,.05)' }, ticks: { precision: 0 } },
        x: { grid: { display: false } }
      }
    }
  });

  // Pills
  const renderPills = (containerId, nums, extraClass, subFn) => {
    const c = $(containerId);
    if (!c) return;
    c.innerHTML = '';
    nums.forEach(num => {
      const n = sNums[num - 1];
      const el = document.createElement('div');
      el.className = `num-pill ${extraClass || ''}`.trim();
      const sub = subFn ? `<span class="pill-sub">${subFn(n)}</span>` : '';
      el.innerHTML = fmt(num) + sub;
      el.title = `號碼 ${fmt(num)} · 出現 ${n.freq} 次 · 距上次 ${n.gap} 期`;
      c.appendChild(el);
    });
  };

  renderPills('specialHotNums',  statsData.specialHot,  '',      n => `${n.freq}次`);
  renderPills('specialColdNums', statsData.specialCold, 'cold',  n => `${n.freq}次`);

  // 最久未出 (gap 最大)
  const byGap = [...sNums].sort((a, b) => b.gap - a.gap);
  const gapTop = byGap.slice(0, Math.min(10, sNums.length)).map(n => n.num);
  renderPills('specialGapNums', gapTop, 'gap-warn', n => `${n.gap}期`);
}

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
  buildSpecialStatsTable();
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
          label: `${rangeLabel()}出現`,
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

  const maxNum = statsData?.maxNum || 39;
  const t1 = Math.floor(maxNum / 3);
  const t2 = Math.floor(maxNum * 2 / 3);
  const titleEl = $('rangeChartTitle');
  if (titleEl) titleEl.textContent = `號碼段分佈 (1–${t1} / ${t1+1}–${t2} / ${t2+1}–${maxNum})`;

  let low = 0, mid = 0, high = 0;
  allDraws.forEach(d => d.numbers.forEach(n => {
    if (n <= t1) low++;
    else if (n <= t2) mid++;
    else high++;
  }));

  if (rangeChartInst) rangeChartInst.destroy();

  rangeChartInst = new Chart($('rangeChart'), {
    type: 'doughnut',
    data: {
      labels: [`低段 1–${t1}`, `中段 ${t1+1}–${t2}`, `高段 ${t2+1}–${maxNum}`],
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
    const rn = statsData.recentN || recentN;
    const maxN = statsData.maxNum || 39;
    const npd  = statsData.numsPerDraw || 5;
    const hotness = n.recentFreq / (rn * npd / maxN);
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

// 特別號詳細統計表 (分析頁) — 只在大樂透/六合彩/威力彩顯示
function buildSpecialStatsTable() {
  const card = $('specialStatsCard');
  if (!card) return;
  if (!statsData?.specialMax || !statsData.specialNumbers) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  const tbody   = $('specialStatsBody');
  const sNums   = statsData.specialNumbers;
  const maxFreq = statsData.specialMaxFreq || Math.max(...sNums.map(n => n.freq), 1);
  const sMax    = statsData.specialMax;
  const sRn     = statsData.recentN || recentN;
  // 特別號每期 1 顆,期望值 = recentN / specialMax
  const expRecent = (sRn / sMax) || 1;

  tbody.innerHTML = '';
  sNums.forEach(n => {
    const hotness = n.recentFreq / expRecent;
    let badge;
    if (hotness > 1.3)      badge = '<span class="badge-hot">熱門</span>';
    else if (hotness < 0.7) badge = '<span class="badge-cold">冷門</span>';
    else                    badge = '<span class="badge-warm">正常</span>';

    const barPct = Math.round((n.freq / maxFreq) * 100);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div style="display:flex;align-items:center;gap:8px">
        <div style="width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 38% 32%,#fecaca,#b91c1c 80%);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;font-family:Orbitron,monospace">${fmt(n.num)}</div>
      </div></td>
      <td><strong>${n.freq.toLocaleString()}</strong></td>
      <td>${n.pct}%</td>
      <td>${n.recentFreq} 次</td>
      <td style="color:${n.gap > 30 ? '#ef4444' : n.gap > 15 ? '#f59e0b' : '#60a5fa'}">${n.gap} 期</td>
      <td>
        <div class="heat-bar-wrap">
          <div class="heat-bar" style="width:${barPct}px;background:linear-gradient(90deg,rgba(185,28,28,.7),rgba(239,68,68,.4))"></div>
          ${badge}
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
  // 特別號:加分隔符 + 紅球 (大樂透/六合彩/威力彩才會有)
  if (predData.special != null) {
    const sep = document.createElement('span');
    sep.className = 'ball-separator';
    sep.textContent = '+';
    big.appendChild(sep);
    big.appendChild(makeBall(predData.special, 'pred special', predData.numbers.length * 100));
  }

  // Confidence bar
  const conf = predData.confidence || 0;
  $('confBar').style.width = `${conf}%`;
  $('confVal').textContent = `${conf}%`;

  // Detail cards
  const grid = $('predictDetail');
  const numsPerDraw = predData.numbers?.length || statsData?.numsPerDraw || 5;
  grid.style.gridTemplateColumns = `repeat(${numsPerDraw}, 1fr)`;
  grid.innerHTML = '';
  if (predData.details) {
    predData.details.forEach(d => {
      const card = document.createElement('div');
      card.className = 'detail-card';
      card.innerHTML = `
        <div class="detail-num">${fmt(d.num)}</div>
        <div class="detail-row">出現次數 <span>${d.freq}</span></div>
        <div class="detail-row">${rangeLabel(predData)}出現 <span>${d.recentFreq}/${predData.recentN || recentN}期</span></div>
        <div class="detail-row">遺漏值 <span style="color:${d.gap>20?'#ef4444':'#60a5fa'}">${d.gap} 期</span></div>
        <div class="detail-row">綜合評分 <span style="color:#a78bfa">${d.score}</span></div>
        <div class="detail-score" style="width:${Math.min(d.score,100)}%"></div>
      `;
      grid.appendChild(card);
    });
  }

  // 預測特別號詳細卡 (大樂透/六合彩/威力彩才顯示)
  renderSpecialDetailCard();

  // 五不出牌 (所有彩券都顯示)
  renderNotOutCard();

  // Multi predictions
  renderMultiPred();
}

// 預測特別號詳細分析卡 (預測頁)
function renderSpecialDetailCard() {
  const card = $('specialDetailCard');
  if (!card) return;
  const sd = predData?.specialDetail;
  if (!sd || predData.special == null) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  const body = $('specialDetailBody');
  body.innerHTML = '';

  // 大紅球
  const ballWrap = document.createElement('div');
  ballWrap.className = 'special-detail-ball';
  const ball = makeBall(sd.num, 'pred special', 0);
  ball.style.width = '80px';
  ball.style.height = '80px';
  ball.style.fontSize = '28px';
  ballWrap.appendChild(ball);
  body.appendChild(ballWrap);

  // 統計資訊
  const info = document.createElement('div');
  info.className = 'special-detail-info';
  info.innerHTML = `
    <div class="detail-row">出現次數 <span>${sd.freq}</span></div>
    <div class="detail-row">${rangeLabel(predData)}出現 <span>${sd.recentFreq} 次</span></div>
    <div class="detail-row">距上次出現 <span>${sd.gap} 期</span></div>
    <div class="detail-row">綜合評分 <span>${sd.score}</span></div>
  `;
  body.appendChild(info);
}

// 五不出牌卡 (預測頁)
function renderNotOutCard() {
  if (!predData?.notNumbers) return;

  const ballsEl = $('notOutBalls');
  ballsEl.innerHTML = '';
  predData.notNumbers.forEach((n, i) => {
    const b = makeBall(n, 'not-out', i * 80);
    b.style.width = '54px';
    b.style.height = '54px';
    b.style.fontSize = '18px';
    ballsEl.appendChild(b);
  });
  // 反向特別號:紅色球放最後
  if (predData.notSpecial != null) {
    const sep = document.createElement('span');
    sep.className = 'ball-separator';
    sep.textContent = '+';
    ballsEl.appendChild(sep);
    const b = makeBall(predData.notSpecial, 'not-out special', predData.notNumbers.length * 80);
    b.style.width = '54px';
    b.style.height = '54px';
    b.style.fontSize = '18px';
    ballsEl.appendChild(b);
  }

  // 細項
  const grid = $('notOutDetails');
  grid.innerHTML = '';
  if (predData.notNumberDetails) {
    predData.notNumberDetails.forEach(d => {
      const card = document.createElement('div');
      card.className = 'detail-card';
      card.innerHTML = `
        <div class="detail-num">${fmt(d.num)}</div>
        <div class="detail-row">出現次數 <span>${d.freq}</span></div>
        <div class="detail-row">${rangeLabel(predData)}出現 <span>${d.recentFreq} 次</span></div>
        <div class="detail-row">距上次出現 <span style="color:${d.gap>20?'#60a5fa':'#94a3b8'}">${d.gap} 期</span></div>
        <div class="detail-row">綜合評分 <span style="color:#60a5fa">${d.score}</span></div>
        <div class="detail-score" style="width:${Math.min(d.score,100)}%"></div>
      `;
      grid.appendChild(card);
    });
  }
  if (predData.notSpecialDetail) {
    const d = predData.notSpecialDetail;
    const card = document.createElement('div');
    card.className = 'detail-card special-out';
    card.innerHTML = `
      <div class="detail-num">${fmt(d.num)} <span style="font-size:11px;color:var(--muted);font-weight:400">特</span></div>
      <div class="detail-row">出現次數 <span>${d.freq}</span></div>
      <div class="detail-row">${rangeLabel(predData)}出現 <span>${d.recentFreq} 次</span></div>
      <div class="detail-row">距上次出現 <span>${d.gap} 期</span></div>
      <div class="detail-row">綜合評分 <span>${d.score}</span></div>
      <div class="detail-score" style="width:${Math.min(d.score,100)}%"></div>
    `;
    grid.appendChild(card);
  }
}

async function renderMultiPred() {
  const cont = $('multiPred');
  cont.innerHTML = '<div style="color:var(--sub);font-size:13px;padding:10px 0">正在生成多組推薦…</div>';

  const labels  = ['穩健型', '均衡型', '積極型', '冷門型', '熱門型'];
  const results = [];

  // Generate 5 different predictions via the API + local variation
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(apiQ('/api/predict', analysisQuery()));
      const p = await r.json();
      results.push({ label: labels[i], numbers: p.numbers, special: p.special, conf: p.confidence });
    } catch (_) {
      results.push({ label: labels[i], numbers: predData.numbers, special: predData.special, conf: predData.confidence });
    }
  }

  cont.innerHTML = '';
  results.forEach(res => {
    const row = document.createElement('div');
    row.className = 'multi-row';

    const ballsHtml = res.numbers.map((n, i) => `
      <div class="ball pred" style="animation-delay:${i*60}ms;width:44px;height:44px;font-size:16px">${fmt(n)}</div>
    `).join('');
    const specialHtml = (res.special != null)
      ? `<span class="ball-separator" style="font-size:22px">+</span><div class="ball pred special" style="animation-delay:${res.numbers.length*60}ms;width:44px;height:44px;font-size:16px">${fmt(res.special)}</div>`
      : '';

    row.innerHTML = `
      <div class="multi-label">${res.label}</div>
      <div class="multi-balls">${ballsHtml}${specialHtml}</div>
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
    const specialHtml = (draw.special != null)
      ? `<span class="mini-ball-sep">+</span><div class="mini-ball special">${fmt(draw.special)}</div>`
      : '';

    tr.innerHTML = `
      <td style="color:var(--muted);font-size:12px">${start + i + 1}</td>
      <td style="font-size:12px;color:var(--sub);line-height:1.5">${fmtPeriod(draw.period)}</td>
      <td style="font-size:13px;color:var(--sub)">${draw.date || '─'}</td>
      <td><div class="history-balls">${ballsHtml}${specialHtml}</div></td>
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

// ─── Period selector events ──────────────────────────────
$('recentNSlider').addEventListener('input', e => {
  const v = parseInt(e.target.value);
  $('recentNInput').value = v;
});

$('recentNInput').addEventListener('input', e => {
  let v = parseInt(e.target.value);
  if (!isNaN(v)) $('recentNSlider').value = v;
});

$('applyRecentN').addEventListener('click', async () => {
  let v = parseInt($('recentNInput').value);
  const total = statsData ? statsData.totalDraws : 10000;
  if (isNaN(v) || v < 10) v = 10;
  if (v > total) v = total;
  recentN = v;
  analysisMode = 'recent';
  setActiveSection('modeRecent');
  $('recentNInput').value  = v;
  $('recentNSlider').value = v;

  // 更新快捷按鈕 active 狀態
  document.querySelectorAll('.period-quick-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.period-quick-btn').forEach(b => {
    const n = parseInt(b.dataset.n);
    if ((n === 0 && v === total) || n === v) b.classList.add('active');
  });

  await loadAll();
});

// 按 Enter 也能套用
$('recentNInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('applyRecentN').click();
});

document.querySelectorAll('.period-quick-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const total = statsData ? statsData.totalDraws : 10000;
    let n = parseInt(btn.dataset.n);
    if (n === 0) n = total;  // 「全部期數」
    if (n > total) n = total;
    recentN = n;
    analysisMode = 'recent';
    setActiveSection('modeRecent');
    $('recentNInput').value  = n;
    $('recentNSlider').value = n;

    document.querySelectorAll('.period-quick-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    await loadAll();
  });
});

// ─── 模式區塊切換 (上下互斥) ────────────────────────────
function setActiveSection(id) {
  document.querySelectorAll('.period-mode-section').forEach(s => {
    s.classList.toggle('active', s.id === id);
  });
}

document.querySelectorAll('.period-mode-section').forEach(section => {
  section.addEventListener('click', () => {
    if (section.classList.contains('active')) return;
    setActiveSection(section.id);
    // 注意:純切換視覺,不發 API,使用者要按「套用」才會載入
  });
});

// ─── 自訂範圍套用 ───────────────────────────────────────
$('applyRange').addEventListener('click', async () => {
  const total = statsData ? statsData.totalDraws : 10000;
  let s = parseInt($('rangeStartInput').value);
  let e = parseInt($('rangeEndInput').value);
  if (isNaN(s)) s = 1;
  if (isNaN(e)) e = total;
  if (s < 1) s = 1;
  if (e > total) e = total;
  if (s > e) { const t = s; s = e; e = t; }  // 自動換位
  if (e - s + 1 < 10) {
    // 切片至少 10 期才有統計意義
    if (e + 9 <= total) e = s + 9;
    else                s = Math.max(1, e - 9);
  }
  rangeStart = s;
  rangeEnd   = e;
  analysisMode = 'range';
  setActiveSection('modeRange');
  $('rangeStartInput').value = s;
  $('rangeEndInput').value   = e;

  await loadAll();
});

// 範圍輸入按 Enter 也套用
['rangeStartInput', 'rangeEndInput'].forEach(id => {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') $('applyRange').click();
  });
});

// ─── 卡片拖曳排序 (SortableJS) ─────────────────────────
// 每頁可拖的卡片直接是 .section 的子元素 (.card / .hero-row / .kpi-grid / .chart-row)
// 順序存到 localStorage,每頁獨立。所有彩券共用同一份排列。
const SORTABLE_SECTIONS  = ['dashboard', 'analysis', 'predict', 'history'];
const DRAGGABLE_SELECTOR = '.card, .hero-row, .kpi-grid, .chart-row';
const SORT_STORAGE_KEY   = id => `lucky539-cardOrder-${id}`;

function initSortable() {
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS 未載入,拖曳功能停用');
    return;
  }

  SORTABLE_SECTIONS.forEach(secId => {
    const sec = $('sec-' + secId);
    if (!sec) return;

    // 為可拖元素分配穩定 ID + 插入拖曳把手
    Array.from(sec.children).forEach((el, idx) => {
      if (!el.matches(DRAGGABLE_SELECTOR)) return;
      if (!el.dataset.cardId) el.dataset.cardId = `${secId}-${idx}`;
      if (!el.querySelector(':scope > .drag-handle')) {
        const h = document.createElement('div');
        h.className = 'drag-handle';
        h.title = '拖曳排序';
        el.prepend(h);
      }
    });

    // 套用儲存的順序
    const saved = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY(secId)) || '[]');
    if (saved.length) {
      const byId = new Map();
      Array.from(sec.children).forEach(el => {
        if (el.dataset.cardId) byId.set(el.dataset.cardId, el);
      });
      saved.forEach(id => {
        const el = byId.get(id);
        if (el) sec.appendChild(el);
      });
    }

    // 初始化 Sortable
    Sortable.create(sec, {
      draggable: DRAGGABLE_SELECTOR,
      handle:    '.drag-handle',
      animation: 200,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass:  'sortable-drag',
      forceFallback: false,
      onEnd: () => {
        const order = Array.from(sec.children)
          .filter(el => el.matches(DRAGGABLE_SELECTOR) && el.dataset.cardId)
          .map(el => el.dataset.cardId);
        localStorage.setItem(SORT_STORAGE_KEY(secId), JSON.stringify(order));
      }
    });
  });
}

// ─── Init ─────────────────────────────────────────────────
(async () => {
  initParticles();
  initSortable();
  await pollUntilReady();
  await loadAll();
})();
