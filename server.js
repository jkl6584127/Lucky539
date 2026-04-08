const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
const DATA_DIR   = path.join(__dirname, 'data');
const CACHE_FILE       = path.join(DATA_DIR, 'lottery539.json');
const CALIF_CACHE_FILE = path.join(DATA_DIR, 'lotteryCalif.json');
const CACHE_TTL        = 30 * 60 * 1000; // 30 minutes

// ─── Generic pilio lottery config ────────────────────────
// 大樂透(lto) 和 六合彩(ltohk) 共用同一套 pilio 抓取邏輯
const PILIO_CFGS = {
  lotto: { kind: 'ltobig', maxNum: 49, numsPerDraw: 6, cacheFile: path.join(DATA_DIR, 'lotteryLotto.json') },
  mark6: { kind: 'ltohk', maxNum: 49, numsPerDraw: 6, cacheFile: path.join(DATA_DIR, 'lotteryMark6.json') },
};
const pilioState = {
  lotto: { updating: false, progress: { done: 0, total: 0 } },
  mark6: { updating: false, progress: { done: 0, total: 0 } },
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Cache ───────────────────────────────────────────────

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      // ── Migration: if records have no dex field, derive it from period (old format)
      if (c.draws && c.draws.length > 0 && !c.draws[0].dex) {
        c.draws = c.draws.map(d => ({ ...d, dex: d.period }));
      }
      // ── Migration: recompute if period is old format (plain dex or 7-digit custom)
      if (c.draws && c.draws.length > 0 && /^\d{1,8}$/.test(c.draws[0].period)) {
        console.log('[migrate] Recomputing official period numbers from cache…');
        c.draws = assignOfficialPeriods(c.draws);
        saveCache(c);
        console.log('[migrate] Done.');
      }
      return c;
    }
  } catch (_) {}
  return { draws: [], latestDex: 0, lastUpdated: 0 };
}

function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); }
  catch (e) { console.error('[cache] save failed:', e.message); }
}

// ─── California Cache ─────────────────────────────────────

function loadCalifCache() {
  try {
    if (fs.existsSync(CALIF_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CALIF_CACHE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { draws: [], latestPeriod: 0, lastUpdated: 0 };
}

function saveCalifCache(c) {
  try { fs.writeFileSync(CALIF_CACHE_FILE, JSON.stringify(c)); }
  catch (e) { console.error('[calif-cache] save failed:', e.message); }
}

// ─── Generic pilio cache ──────────────────────────────────
function loadPilioCache(cacheFile) {
  try {
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch (_) {}
  return { draws: [], latestDex: 0, lastUpdated: 0 };
}
function savePilioCache(cacheFile, c) {
  try { fs.writeFileSync(cacheFile, JSON.stringify(c)); }
  catch (e) { console.error('[pilio-cache] save failed:', e.message); }
}

// ─── HTTP helpers ────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Referer': 'https://www.pilio.idv.tw/lto539/list.asp',
  'Accept': 'application/json, text/javascript, */*',
  'Accept-Language': 'zh-TW,zh;q=0.9'
};

/**
 * Probe the actual latest index by sending a very large Lindex.
 * The API returns the most recent 10 records regardless of index value.
 */
async function fetchMaxIndex() {
  // The page's lastindex HTML is often stale; probe with large value instead
  const probe = await fetchBatch(99999);
  if (probe && probe.length > 0) {
    // The first item in the response is the newest; its dex+1 is the "max index"
    return parseInt(probe[0].dex) + 1;
  }
  // fallback: read from HTML page
  try {
    const { data } = await axios.get(
      'https://www.pilio.idv.tw/lto539/list.asp?indexpage=1&orderby=new',
      { timeout: 15000, headers: HEADERS }
    );
    const m = data.match(/id="lastindex"[^>]*value="(\d+)"/);
    return m ? parseInt(m[1]) : null;
  } catch (_) { return null; }
}

/**
 * Fetch one batch (10 records) starting from index-1 going backwards.
 * Returns array of raw lotto objects, or null on error.
 */
async function fetchBatch(index) {
  try {
    const url = `https://www.pilio.idv.tw/Json_ltonew.asp?Lkind=lto539&Lindex=${index}&Ldesc=desc`;
    const { data } = await axios.post(url, '', {
      timeout: 12000,
      headers: { ...HEADERS, 'Content-Length': '0', 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return (parsed.lotto || []).filter(x => x.num && x.dex !== undefined);
  } catch (e) {
    console.error(`[batch] index=${index} error: ${e.message}`);
    return null;
  }
}

/** Parse "MM/DD<br>YY(星期)" → "YYYY-MM-DD" */
function parseDate(raw) {
  // raw example: "03/06<br>26(五)"
  const m = raw.match(/(\d{2})\/(\d{2}).*?(\d{2})\(/);
  if (!m) return raw;
  const [, mm, dd, yy] = m;
  return `20${yy}-${mm}-${dd}`;
}

/** Parse "01, 04, 08, 12, 36" → [1,4,8,12,36] */
function parseNums(raw) {
  return raw.split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 39);
}

function toRecord(item) {
  return {
    dex:     String(item.dex),   // pilio 內部序號，用於分頁
    period:  String(item.dex),   // 暫存，之後由 assignOfficialPeriods 覆寫
    date:    parseDate(item.date),
    numbers: parseNums(item.num).sort((a, b) => a - b)
  };
}

/**
 * 依日期由舊到新排序後，按年分配官方期號。
 * 格式：RRR (民國年3位) + NNNNNN (年內序號6位) = 9碼
 * 例：096000001 = 民國96年(2007)第1期  → 顯示 "第096000001期"
 */
function assignOfficialPeriods(draws) {
  const sorted = [...draws].sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return  1;
    return parseInt(a.dex) - parseInt(b.dex);
  });

  const yearCount = {};
  const periodMap = new Map();

  sorted.forEach(draw => {
    const ceYear  = parseInt(draw.date.slice(0, 4)) || 0;
    const rocYear = ceYear - 1911;
    yearCount[rocYear] = (yearCount[rocYear] || 0) + 1;
    const rocStr = String(rocYear).padStart(3, '0');
    const seqStr = String(yearCount[rocYear]).padStart(6, '0');
    periodMap.set(draw.dex, `${rocStr}${seqStr}`);
  });

  return draws.map(d => ({ ...d, period: periodMap.get(d.dex) || d.period }));
}

// ─── Main update ─────────────────────────────────────────

let updating = false;
let progress = { done: 0, total: 0 };

let califUpdating = false;
let califProgress = { done: 0, total: 0 };

// ─── Generic pilio fetch/update (大樂透 / 六合彩) ─────────

async function fetchPilioBatch(kind, index) {
  try {
    const url = `https://www.pilio.idv.tw/Json_ltonew.asp?Lkind=${kind}&Lindex=${index}&Ldesc=desc`;
    const { data } = await axios.post(url, '', {
      timeout: 12000,
      headers: { ...HEADERS, 'Content-Length': '0', 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return (parsed.lotto || []).filter(x => x.num && x.dex !== undefined);
  } catch (e) {
    console.error(`[pilio-batch] kind=${kind} index=${index} error: ${e.message}`);
    return null;
  }
}

function pilioToRecord(item, maxNum) {
  const nums = item.num.split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= maxNum);
  return {
    period:  String(item.dex),
    date:    parseDate(item.date),
    numbers: nums.sort((a, b) => a - b)
  };
}

async function updatePilioData(key, force = false) {
  const cfg   = PILIO_CFGS[key];
  const state = pilioState[key];
  const cache = loadPilioCache(cfg.cacheFile);
  const now   = Date.now();
  const stale = (now - cache.lastUpdated) > CACHE_TTL;
  const empty = cache.draws.length === 0;

  if (!force && !stale && !empty) return cache.draws;
  if (state.updating)             return cache.draws;

  if (!empty && stale && !force) {
    state.updating = true;
    updatePilioBackground(key, cache, now).catch(console.error);
    return cache.draws;
  }

  state.updating = true;
  state.progress = { done: 0, total: 0 };

  try {
    console.log(`[${key}] Fetching latest index…`);
    const probe = await fetchPilioBatch(cfg.kind, 99999);
    if (!probe || probe.length === 0) throw new Error('Could not get max index');
    const maxIndex = parseInt(probe[0].dex) + 1;

    console.log(`[${key}] maxIndex=${maxIndex}, cached=${cache.latestDex}`);

    if (empty || force) {
      // ── Full fetch ──
      state.progress.total = maxIndex;
      let index = maxIndex, errors = 0;
      const allItems = [];

      while (index > 0) {
        const batch = await fetchPilioBatch(cfg.kind, index);
        if (batch === null) { if (++errors >= 5) break; await delay(1000); continue; }
        if (batch.length === 0) break;
        errors = 0;
        allItems.push(...batch);
        index = parseInt(batch[batch.length - 1].dex);
        state.progress.done = maxIndex - index;
        if (allItems.length % 200 === 0) console.log(`[${key}] …${allItems.length} records (dex=${index})`);
        await delay(150);
      }

      cache.draws     = allItems.map(r => pilioToRecord(r, cfg.maxNum));
      cache.latestDex = maxIndex - 1;
      cache.lastUpdated = now;
      savePilioCache(cfg.cacheFile, cache);
      console.log(`[${key}] Full fetch done: ${cache.draws.length} draws`);

    } else if (maxIndex - 1 > cache.latestDex) {
      // ── Incremental ──
      const newItems = [];
      let index = maxIndex, errors = 0;

      while (index > cache.latestDex) {
        const batch = await fetchPilioBatch(cfg.kind, index);
        if (batch === null) { if (++errors >= 3) break; continue; }
        if (batch.length === 0) break;
        for (const item of batch) {
          if (parseInt(item.dex) > cache.latestDex) newItems.push(item);
        }
        index = parseInt(batch[batch.length - 1].dex);
        await delay(100);
      }

      if (newItems.length > 0) {
        cache.draws     = [...newItems.map(r => pilioToRecord(r, cfg.maxNum)), ...cache.draws];
        cache.latestDex = maxIndex - 1;
        console.log(`[${key}] +${newItems.length} new (total: ${cache.draws.length})`);
      }
      cache.lastUpdated = now;
      savePilioCache(cfg.cacheFile, cache);
    }

  } catch (e) {
    console.error(`[${key}]`, e.message);
  } finally {
    state.updating = false;
    state.progress = { done: cache.draws.length, total: cache.draws.length };
  }
  return cache.draws;
}

async function updatePilioBackground(key, cache, now) {
  const cfg   = PILIO_CFGS[key];
  const state = pilioState[key];
  state.progress = { done: 0, total: 0 };
  try {
    const probe = await fetchPilioBatch(cfg.kind, 99999);
    if (!probe || probe.length === 0) throw new Error('probe failed');
    const maxIndex = parseInt(probe[0].dex) + 1;

    if (maxIndex - 1 > cache.latestDex) {
      const newItems = [];
      let index = maxIndex, errors = 0;
      while (index > cache.latestDex) {
        const batch = await fetchPilioBatch(cfg.kind, index);
        if (batch === null) { if (++errors >= 3) break; continue; }
        if (batch.length === 0) break;
        for (const item of batch) {
          if (parseInt(item.dex) > cache.latestDex) newItems.push(item);
        }
        index = parseInt(batch[batch.length - 1].dex);
        await delay(100);
      }
      if (newItems.length > 0) {
        cache.draws     = [...newItems.map(r => pilioToRecord(r, cfg.maxNum)), ...cache.draws];
        cache.latestDex = maxIndex - 1;
        console.log(`[${key}-bg] +${newItems.length} (total: ${cache.draws.length})`);
      }
    }
    cache.lastUpdated = now;
    savePilioCache(cfg.cacheFile, cache);
  } catch (e) {
    console.error(`[${key}-bg]`, e.message);
    cache.lastUpdated = now;
    savePilioCache(cfg.cacheFile, cache);
  } finally {
    state.updating = false;
    state.progress = { done: cache.draws.length, total: cache.draws.length };
  }
}

async function updateData(force = false) {
  const cache = loadCache();
  const now   = Date.now();
  const stale = (now - cache.lastUpdated) > CACHE_TTL;
  const empty = cache.draws.length === 0;

  if (!force && !stale && !empty) return cache.draws;
  if (updating)                   return cache.draws;

  // If we have cached data but it's stale, return it immediately and update in background
  if (!empty && stale && !force) {
    updating = true;
    updateInBackground(cache, now).catch(console.error);
    return cache.draws;
  }

  updating = true;
  progress = { done: 0, total: 0 };

  try {
    console.log(`[${new Date().toLocaleTimeString()}] Fetching latest index…`);
    const maxIndex = await fetchMaxIndex();
    if (!maxIndex) throw new Error('Could not get max index');

    console.log(`Max index: ${maxIndex}, cached: ${cache.latestDex}`);

    if (empty || force) {
      // ── Full history fetch ──
      progress.total = maxIndex;
      let index  = maxIndex;
      let errors = 0;
      const allItems = [];

      while (index > 0) {
        const batch = await fetchBatch(index);

        if (batch === null) {
          if (++errors >= 5) break;
          await delay(1000);
          continue;
        }
        errors = 0;

        if (batch.length === 0) break;

        allItems.push(...batch);
        index = parseInt(batch[batch.length - 1].dex);

        progress.done = maxIndex - index;
        if (allItems.length % 200 === 0)
          console.log(`  …${allItems.length} records (dex=${index})`);

        await delay(150);
      }

      cache.draws     = assignOfficialPeriods(allItems.map(toRecord));
      cache.latestDex = maxIndex - 1;
      cache.lastUpdated = now;
      saveCache(cache);
      console.log(`Full fetch done: ${cache.draws.length} draws`);

    } else if (maxIndex - 1 > cache.latestDex) {
      // ── Incremental update ──
      const newItems = [];
      let index  = maxIndex;
      let errors = 0;

      while (index > cache.latestDex) {
        const batch = await fetchBatch(index);
        if (batch === null) { if (++errors >= 3) break; continue; }
        if (batch.length === 0) break;

        for (const item of batch) {
          if (parseInt(item.dex) > cache.latestDex) newItems.push(item);
        }

        index = parseInt(batch[batch.length - 1].dex);
        await delay(100);
      }

      if (newItems.length > 0) {
        const combined  = [...newItems.map(toRecord), ...cache.draws];
        cache.draws     = assignOfficialPeriods(combined);
        cache.latestDex = maxIndex - 1;
        console.log(`+${newItems.length} new draws (total: ${cache.draws.length})`);
      }

      cache.lastUpdated = now;
      saveCache(cache);
    }

  } catch (e) {
    console.error('[update]', e.message);
  } finally {
    updating  = false;
    progress = { done: cache.draws.length, total: cache.draws.length };
  }

  return cache.draws;
}

async function updateInBackground(cache, now) {
  progress = { done: 0, total: 0 };
  try {
    console.log(`[bg] Background incremental update…`);
    const maxIndex = await fetchMaxIndex();
    if (!maxIndex) throw new Error('Could not get max index');

    if (maxIndex - 1 > cache.latestDex) {
      const newItems = [];
      let index  = maxIndex;
      let errors = 0;

      while (index > cache.latestDex) {
        const batch = await fetchBatch(index);
        if (batch === null) { if (++errors >= 3) break; continue; }
        if (batch.length === 0) break;

        for (const item of batch) {
          if (parseInt(item.dex) > cache.latestDex) newItems.push(item);
        }
        index = parseInt(batch[batch.length - 1].dex);
        await delay(100);
      }

      if (newItems.length > 0) {
        const combined  = [...newItems.map(toRecord), ...cache.draws];
        cache.draws     = assignOfficialPeriods(combined);
        cache.latestDex = maxIndex - 1;
        console.log(`[bg] +${newItems.length} new draws (total: ${cache.draws.length})`);
      }
    }

    cache.lastUpdated = now;
    saveCache(cache);
    console.log(`[bg] Update done.`);
  } catch (e) {
    console.error('[bg]', e.message);
    // Still mark as updated to avoid retry loop
    cache.lastUpdated = now;
    saveCache(cache);
  } finally {
    updating = false;
    progress = { done: cache.draws.length, total: cache.draws.length };
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── California Fantasy5 fetch ────────────────────────────
// 資料來源：twlottery.in (年份逐年抓取) + cake.idv.tw (最新一頁增量)
// 注意：cake.idv.tw 的 ?p= 分頁參數無效，每頁都回傳相同最新資料，
//       因此全量抓取改用 twlottery.in，增量用 cake.idv.tw 第1頁。

const CALIF_FIRST_YEAR = 2022; // twlottery.in 有效資料起始年

const CALIF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/json,*/*'
};

/** 從 twlottery.in 抓取指定年份的全部開獎紀錄 */
async function fetchCalifYear(year) {
  try {
    const url = `https://twlottery.in/lotteryCA5/list/${year}`;
    const { data } = await axios.get(url, { timeout: 20000, headers: CALIF_HEADERS });
    const match = data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;
    const json  = JSON.parse(match[1]);
    const list  = json?.props?.pageProps?.lotteryCA5List || [];
    return list;
  } catch (e) {
    console.error(`[calif-year] ${year} error: ${e.message}`);
    return null;
  }
}

/** 從 cake.idv.tw 抓取最新 100 筆（僅用於增量，不分頁） */
async function fetchCalifLatest() {
  try {
    const url = 'https://www.cake.idv.tw/api/lottery?a=history&g=Fantasy5&limit=100&p=1';
    const { data } = await axios.get(url, { timeout: 15000, headers: CALIF_HEADERS });
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return (parsed.data?.g || []).filter(x => x.gResult && x.gNum !== undefined);
  } catch (e) {
    console.error(`[calif-latest] error: ${e.message}`);
    return null;
  }
}

/** twlottery.in 的格式 → 統一 record */
function califYearItemToRecord(item) {
  const dateStr = item.drawDate ? item.drawDate.slice(0, 10) : '';
  const numbers = (item.winningNumbers || [])
    .map(s => parseInt(s))
    .filter(n => n >= 1 && n <= 39)
    .sort((a, b) => a - b);
  return { period: String(item.period), date: dateStr, numbers };
}

/** cake.idv.tw 的格式 → 統一 record */
function califLatestItemToRecord(item) {
  const ts   = item.gDate * 1000;
  const d    = new Date(ts);
  const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const numbers = item.gResult.split(',')
    .map(s => parseInt(s.trim()))
    .filter(n => n >= 1 && n <= 39)
    .sort((a, b) => a - b);
  return { period: String(item.gNum), date, numbers };
}

async function updateCalifData(force = false) {
  const cache = loadCalifCache();
  const now   = Date.now();
  const stale = (now - cache.lastUpdated) > CACHE_TTL;
  const empty = cache.draws.length === 0;

  if (!force && !stale && !empty) return cache.draws;
  if (califUpdating)              return cache.draws;

  if (!empty && stale && !force) {
    califUpdating = true;
    updateCalifInBackground(cache, now).catch(console.error);
    return cache.draws;
  }

  califUpdating = true;
  const currentYear = new Date().getFullYear();
  califProgress = { done: 0, total: currentYear - CALIF_FIRST_YEAR + 1 };

  try {
    console.log(`[calif] Starting full history fetch (${CALIF_FIRST_YEAR}–${currentYear})…`);
    const allRecords = [];

    for (let year = currentYear; year >= CALIF_FIRST_YEAR; year--) {
      const items = await fetchCalifYear(year);
      if (items === null) {
        console.warn(`[calif] Failed to fetch year ${year}, skipping`);
      } else if (items.length === 0) {
        console.log(`[calif] Year ${year} is empty, stopping`);
        break;
      } else {
        const records = items.map(califYearItemToRecord).filter(r => r.numbers.length === 5);
        allRecords.push(...records);
        console.log(`[calif] Year ${year}: ${records.length} records (total: ${allRecords.length})`);
      }
      califProgress.done = currentYear - year + 1;
      await delay(400);
    }

    // Sort newest first and deduplicate by period
    allRecords.sort((a, b) => parseInt(b.period) - parseInt(a.period));
    const seen = new Set();
    cache.draws = allRecords.filter(r => {
      if (seen.has(r.period)) return false;
      seen.add(r.period);
      return true;
    });
    cache.latestPeriod = cache.draws.length > 0 ? parseInt(cache.draws[0].period) : 0;
    cache.lastUpdated  = now;
    saveCalifCache(cache);
    console.log(`[calif] Full fetch done: ${cache.draws.length} draws`);

  } catch (e) {
    console.error('[calif-update]', e.message);
  } finally {
    califUpdating = false;
    califProgress = { done: cache.draws.length, total: cache.draws.length };
  }

  return cache.draws;
}

async function updateCalifInBackground(cache, now) {
  califProgress = { done: 0, total: 0 };
  try {
    const latestPeriod = cache.latestPeriod;
    const items = await fetchCalifLatest();
    if (!items) { cache.lastUpdated = now; saveCalifCache(cache); return; }

    const newRecords = items
      .map(califLatestItemToRecord)
      .filter(r => parseInt(r.period) > latestPeriod && r.numbers.length === 5);

    if (newRecords.length > 0) {
      newRecords.sort((a, b) => parseInt(b.period) - parseInt(a.period));
      cache.draws = [...newRecords, ...cache.draws];
      cache.latestPeriod = parseInt(newRecords[0].period);
      console.log(`[calif-bg] +${newRecords.length} new draws (total: ${cache.draws.length})`);
    }
    cache.lastUpdated = now;
    saveCalifCache(cache);
    console.log(`[calif-bg] Done.`);
  } catch (e) {
    console.error('[calif-bg]', e.message);
    cache.lastUpdated = now;
    saveCalifCache(cache);
  } finally {
    califUpdating = false;
    califProgress = { done: cache.draws.length, total: cache.draws.length };
  }
}

// ─── Statistics ──────────────────────────────────────────

function computeStats(draws, maxNum = 39, recentN = 100) {
  const size     = maxNum + 1;
  const freq       = Array(size).fill(0);
  const lastSeen   = Array(size).fill(-1);
  const recentFreq = Array(size).fill(0);

  draws.forEach((d, idx) => {
    d.numbers.forEach(n => {
      if (n >= 1 && n <= maxNum) {
        freq[n]++;
        if (lastSeen[n] === -1) lastSeen[n] = idx;
      }
    });
  });

  const recentSlice = Math.min(recentN, draws.length);
  draws.slice(0, recentSlice).forEach(d => d.numbers.forEach(n => {
    if (n >= 1 && n <= maxNum) recentFreq[n]++;
  }));

  for (let i = 1; i <= maxNum; i++) if (lastSeen[i] === -1) lastSeen[i] = draws.length;

  return { freq, lastSeen, recentFreq, recentSlice };
}

// ─── Prediction ──────────────────────────────────────────

function predict(draws, maxNum = 39, numsPerDraw = 5, recentN = 100) {
  if (draws.length < 20) {
    const fallback = Array.from({ length: numsPerDraw }, (_, i) => Math.round((i + 1) * maxNum / (numsPerDraw + 1)));
    return { numbers: fallback, confidence: 0, details: [] };
  }

  const { freq, lastSeen, recentFreq, recentSlice } = computeStats(draws, maxNum, recentN);
  const total   = draws.length;
  const expFreq = (total * numsPerDraw) / maxNum;
  const expR100 = (recentSlice * numsPerDraw) / maxNum;
  const poolSize = Math.min(Math.ceil(maxNum * 0.55), maxNum);

  const scores = Array(maxNum + 1).fill(0);
  for (let i = 1; i <= maxNum; i++) {
    const fScore = freq[i]       / expFreq;
    const rScore = recentFreq[i] / expR100;
    const gScore = Math.min(lastSeen[i] / 12, 3.0);
    scores[i]    = fScore * 0.20 + rScore * 0.50 + gScore * 0.30;
  }

  const ranked = [];
  for (let i = 1; i <= maxNum; i++) ranked.push({ num: i, score: scores[i] });
  ranked.sort((a, b) => b.score - a.score);

  const pool      = ranked.slice(0, poolSize);
  const poolScore = pool.reduce((s, x) => s + x.score, 0);
  const selected  = [];
  let   tries     = 0;

  while (selected.length < numsPerDraw && tries++ < 500) {
    let r = Math.random() * poolScore;
    for (const { num, score } of pool) {
      r -= score;
      if (r <= 0 && !selected.includes(num)) { selected.push(num); break; }
    }
  }
  for (const { num } of ranked) {
    if (selected.length >= numsPerDraw) break;
    if (!selected.includes(num)) selected.push(num);
  }

  selected.sort((a, b) => a - b);

  const avgScore   = selected.reduce((s, n) => s + scores[n], 0) / numsPerDraw;
  const confidence = Math.min(Math.round(avgScore * 45 + 20), 92);

  return {
    numbers:    selected,
    confidence,
    recentN:    recentSlice,
    details:    selected.map(n => ({
      num:        n,
      freq:       freq[n],
      gap:        lastSeen[n],
      recentFreq: recentFreq[n],
      score:      Math.round(scores[n] * 100)
    }))
  };
}

// ─── API routes ──────────────────────────────────────────

// Helper: resolve draws + lottery meta from request
async function resolveDraws(req, force = false) {
  const type = req.query.lottery || '539';
  if (type === 'calif') {
    const draws = await updateCalifData(force);
    return { draws, maxNum: 39, numsPerDraw: 5 };
  }
  if (PILIO_CFGS[type]) {
    const draws = await updatePilioData(type, force);
    return { draws, maxNum: PILIO_CFGS[type].maxNum, numsPerDraw: PILIO_CFGS[type].numsPerDraw };
  }
  // default: 539
  const draws = await updateData(force);
  return { draws, maxNum: 39, numsPerDraw: 5 };
}

app.get('/api/status', (req, res) => {
  const type = req.query.lottery || '539';
  if (type === 'calif') {
    const c = loadCalifCache();
    return res.json({ total: c.draws.length, lastUpdated: c.lastUpdated, updating: califUpdating, progress: califProgress });
  }
  if (PILIO_CFGS[type]) {
    const c = loadPilioCache(PILIO_CFGS[type].cacheFile);
    const s = pilioState[type];
    return res.json({ total: c.draws.length, lastUpdated: c.lastUpdated, updating: s.updating, progress: s.progress });
  }
  const c = loadCache();
  res.json({ total: c.draws.length, lastUpdated: c.lastUpdated, updating, progress });
});

app.get('/api/draws', async (req, res) => {
  try {
    const { draws } = await resolveDraws(req);
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 10000);
    const offset = parseInt(req.query.offset) || 0;
    res.json({ total: draws.length, data: draws.slice(offset, offset + limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/latest', async (req, res) => {
  try {
    const { draws } = await resolveDraws(req);
    res.json(draws[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const { draws, maxNum, numsPerDraw } = await resolveDraws(req);
    if (!draws.length) return res.status(503).json({ error: 'No data' });

    // recentN: 使用者自訂分析期數，上限為歷史總期數
    const recentN = Math.max(1, Math.min(parseInt(req.query.recentN) || 100, draws.length));

    const { freq, lastSeen, recentFreq, recentSlice } = computeStats(draws, maxNum, recentN);
    const numbers = [];
    for (let i = 1; i <= maxNum; i++) {
      numbers.push({
        num:        i,
        freq:       freq[i],
        pct:        +((freq[i] / (draws.length * numsPerDraw)) * 100).toFixed(2),
        gap:        lastSeen[i],
        recentFreq: recentFreq[i]
      });
    }
    const byFreq = [...numbers].sort((a, b) => b.freq - a.freq);
    res.json({
      totalDraws: draws.length,
      recentN:    recentSlice,
      maxNum,
      numsPerDraw,
      numbers,
      hot10:   byFreq.slice(0, 10).map(x => x.num),
      cold10:  byFreq.slice(-10).reverse().map(x => x.num),
      maxFreq: byFreq[0].freq,
      minFreq: byFreq[byFreq.length - 1].freq
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/predict', async (req, res) => {
  try {
    const { draws, maxNum, numsPerDraw } = await resolveDraws(req);
    if (draws.length < 20) return res.status(503).json({ error: 'Insufficient data' });
    const recentN = Math.max(1, Math.min(parseInt(req.query.recentN) || 100, draws.length));
    res.json(predict(draws, maxNum, numsPerDraw, recentN));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const type = req.query.lottery || '539';
    if (type === 'calif') {
      const c = loadCalifCache(); c.lastUpdated = 0; saveCalifCache(c);
      updateCalifData(true).catch(console.error);
    } else if (PILIO_CFGS[type]) {
      const c = loadPilioCache(PILIO_CFGS[type].cacheFile); c.lastUpdated = 0; savePilioCache(PILIO_CFGS[type].cacheFile, c);
      updatePilioData(type, true).catch(console.error);
    } else {
      const c = loadCache(); c.lastUpdated = 0; saveCache(c);
      updateData().catch(console.error);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ───────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log(`  ║  539 / 加州 / 大樂透 / 六合彩 智能分析   ║`);
  console.log(`  ║   http://localhost:${PORT}                ║`);
  console.log('  ╚══════════════════════════════════════════╝\n');
  updateData().catch(console.error);
  updateCalifData().catch(console.error);
  updatePilioData('lotto').catch(console.error);
  updatePilioData('mark6').catch(console.error);
});
