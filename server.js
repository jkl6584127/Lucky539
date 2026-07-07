const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app        = express();
const PORT       = process.env.PORT || 3000;
const SEED_DIR   = path.join(__dirname, 'data'); // repo 內建的歷史快取（git 版本）
const DATA_DIR   = process.env.DATA_DIR || SEED_DIR;
const CACHE_FILE       = path.join(DATA_DIR, 'lottery539.json');
const CALIF_CACHE_FILE = path.join(DATA_DIR, 'lotteryCalif.json');
const USERS_FILE       = path.join(DATA_DIR, 'users.json');
const CACHE_TTL        = 30 * 60 * 1000; // 30 minutes
const SESSION_TTL      = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Auth: 帳號 / Session ─────────────────────────────────
const sessions = new Map(); // token -> { username, expires }

function loadUsers() {
  try { if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) {}
  return {};
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function getSession(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return { token, username: s.username };
}
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}
// ─── Generic pilio lottery config ────────────────────────
// 大樂透 / 六合彩 / 威力彩 共用同一套 pilio 抓取邏輯
// specialMax: 特別號上限 (威力彩第二區 1-8;其他與 maxNum 相同)
const PILIO_CFGS = {
  lotto: { kind: 'ltobig', maxNum: 49, specialMax: 49, numsPerDraw: 6, cacheFile: path.join(DATA_DIR, 'lotteryLotto.json') },
  mark6: { kind: 'ltohk',  maxNum: 49, specialMax: 49, numsPerDraw: 6, cacheFile: path.join(DATA_DIR, 'lotteryMark6.json') },
  super: { kind: 'lto',    maxNum: 38, specialMax: 8,  numsPerDraw: 6, cacheFile: path.join(DATA_DIR, 'lotterySuper.json') },
};
const pilioState = {
  lotto: { updating: false, progress: { done: 0, total: 0 } },
  mark6: { updating: false, progress: { done: 0, total: 0 } },
  super: { updating: false, progress: { done: 0, total: 0 } },
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 首次啟動時，如果 DATA_DIR 指向全新的持久化硬碟（跟 repo 內建的種子資料不同路徑），
// 把 git 裡已經抓好的歷史快取複製過去，避免重新對外抓一次全部歷史資料。
// 只補「還不存在」的檔案，不會覆蓋硬碟上已經更新過的資料。
if (path.resolve(DATA_DIR) !== path.resolve(SEED_DIR) && fs.existsSync(SEED_DIR)) {
  for (const file of fs.readdirSync(SEED_DIR)) {
    if (!file.endsWith('.json')) continue;
    const dest = path.join(DATA_DIR, file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(SEED_DIR, file), dest);
      console.log(`[seed] copied ${file} -> ${dest}`);
    }
  }
}

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

function pilioToRecord(item, maxNum, specialMax = maxNum) {
  const nums = item.num.split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= maxNum);
  const sp   = parseInt(String(item.sp || '').trim());
  return {
    period:  String(item.dex),
    date:    parseDate(item.date),
    numbers: nums.sort((a, b) => a - b),
    // 特別號:大樂透/六合彩 (1~49) 或威力彩第二區 (1~8);無效或缺失時為 null
    special: !isNaN(sp) && sp >= 1 && sp <= specialMax ? sp : null
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

      cache.draws     = allItems.map(r => pilioToRecord(r, cfg.maxNum, cfg.specialMax));
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
        cache.draws     = [...newItems.map(r => pilioToRecord(r, cfg.maxNum, cfg.specialMax)), ...cache.draws];
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
        cache.draws     = [...newItems.map(r => pilioToRecord(r, cfg.maxNum, cfg.specialMax)), ...cache.draws];
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

// recentSpec: { kind:'recent', n } 或 { kind:'range', sliceStart, sliceEnd }
//   - recent: 取 draws.slice(0, n) 當「近期」窗口
//   - range : 取 draws.slice(sliceStart, sliceEnd) 當「範圍」窗口
function computeStats(draws, maxNum = 39, recentSpec = { kind: 'recent', n: 100 }) {
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

  let recentDraws;
  if (recentSpec.kind === 'range') {
    recentDraws = draws.slice(recentSpec.sliceStart, recentSpec.sliceEnd);
  } else {
    const n = Math.min(recentSpec.n || 100, draws.length);
    recentDraws = draws.slice(0, n);
  }
  recentDraws.forEach(d => d.numbers.forEach(n => {
    if (n >= 1 && n <= maxNum) recentFreq[n]++;
  }));

  for (let i = 1; i <= maxNum; i++) if (lastSeen[i] === -1) lastSeen[i] = draws.length;

  return { freq, lastSeen, recentFreq, recentSlice: recentDraws.length };
}

// ─── Special number statistics (大樂透/六合彩/威力彩) ───
// 特別號是獨立池 (威力彩 1-8 或大樂透/六合彩 1-49 各取一個)
function computeSpecialStats(draws, specialMax, recentSpec) {
  const freq       = Array(specialMax + 1).fill(0);
  const lastSeen   = Array(specialMax + 1).fill(-1);
  const recentFreq = Array(specialMax + 1).fill(0);

  draws.forEach((d, idx) => {
    const s = d.special;
    if (s != null && s >= 1 && s <= specialMax) {
      freq[s]++;
      if (lastSeen[s] === -1) lastSeen[s] = idx;
    }
  });

  let recentDraws;
  if (recentSpec.kind === 'range') {
    recentDraws = draws.slice(recentSpec.sliceStart, recentSpec.sliceEnd);
  } else {
    recentDraws = draws.slice(0, Math.min(recentSpec.n || 100, draws.length));
  }
  recentDraws.forEach(d => {
    const s = d.special;
    if (s != null && s >= 1 && s <= specialMax) recentFreq[s]++;
  });

  for (let i = 1; i <= specialMax; i++) if (lastSeen[i] === -1) lastSeen[i] = draws.length;

  return { freq, lastSeen, recentFreq, recentSlice: recentDraws.length };
}

// 預測特別號:加權隨機從前 40% 池子選一個
// exclude:大樂透/六合彩 special 跟主號同池,需排除已選主號
function predictSpecial(draws, specialMax, recentSpec, exclude = []) {
  if (specialMax <= 0 || draws.length < 20) return null;

  const { freq, lastSeen, recentFreq, recentSlice } = computeSpecialStats(draws, specialMax, recentSpec);
  const total = draws.length;
  const expF  = total / specialMax;
  const expR  = (recentSlice || 1) / specialMax;

  const ranked = [];
  for (let i = 1; i <= specialMax; i++) {
    if (exclude.includes(i)) continue;
    const fS = freq[i] / (expF || 1);
    const rS = recentFreq[i] / (expR || 1);
    const gS = Math.min(lastSeen[i] / 12, 3.0);
    ranked.push({ num: i, score: fS * 0.20 + rS * 0.50 + gS * 0.30 });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.score - a.score);

  const poolSize = Math.max(2, Math.ceil(ranked.length * 0.4));
  const pool = ranked.slice(0, poolSize);
  const sum  = pool.reduce((s, x) => s + x.score, 0);
  let r = Math.random() * sum;
  for (const x of pool) {
    r -= x.score;
    if (r <= 0) return x.num;
  }
  return pool[0].num;
}

// ─── Prediction ──────────────────────────────────────────

function predict(draws, maxNum = 39, numsPerDraw = 5, recentSpec = { kind: 'recent', n: 100 }, specialMax = 0) {
  if (draws.length < 20) {
    const fallback = Array.from({ length: numsPerDraw }, (_, i) => Math.round((i + 1) * maxNum / (numsPerDraw + 1)));
    return { numbers: fallback, confidence: 0, details: [] };
  }

  const { freq, lastSeen, recentFreq, recentSlice } = computeStats(draws, maxNum, recentSpec);
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

  const buildMainDetail = n => ({
    num:        n,
    freq:       freq[n],
    gap:        lastSeen[n],
    recentFreq: recentFreq[n],
    score:      Math.round(scores[n] * 100)
  });

  // 五不出牌:分數最低的 5 個主號
  const ascRanked = [...ranked].sort((a, b) => a.score - b.score);
  const notNumbers       = ascRanked.slice(0, 5).map(x => x.num).sort((a, b) => a - b);
  const notNumberDetails = notNumbers.map(buildMainDetail);

  // 特別號預測 + 反向預測 + 詳細
  let special           = null;
  let specialDetail     = null;
  let notSpecial        = null;
  let notSpecialDetail  = null;

  if (specialMax > 0) {
    const sStats = computeSpecialStats(draws, specialMax, recentSpec);
    const expF   = total / specialMax || 1;
    const expR   = (sStats.recentSlice / specialMax) || 1;

    const sRanked = [];
    for (let i = 1; i <= specialMax; i++) {
      const fS = sStats.freq[i] / expF;
      const rS = sStats.recentFreq[i] / expR;
      const gS = Math.min(sStats.lastSeen[i] / 12, 3.0);
      sRanked.push({ num: i, score: fS * 0.20 + rS * 0.50 + gS * 0.30 });
    }

    const buildSpecialDetail = (num, score) => ({
      num,
      freq:       sStats.freq[num],
      gap:        sStats.lastSeen[num],
      recentFreq: sStats.recentFreq[num],
      score:      Math.round(score * 100)
    });

    // 大樂透/六合彩 special 跟主號同池,需排除已選主號;威力彩特別池獨立
    const exclude    = specialMax === maxNum ? selected : [];
    const candidates = sRanked.filter(x => !exclude.includes(x.num));

    if (candidates.length) {
      // 預測:加權隨機從前 40% 池子
      const descPool = [...candidates].sort((a, b) => b.score - a.score);
      const poolSize = Math.max(2, Math.ceil(descPool.length * 0.4));
      const top      = descPool.slice(0, poolSize);
      const sum      = top.reduce((s, x) => s + x.score, 0);
      let r = Math.random() * sum;
      for (const x of top) {
        r -= x.score;
        if (r <= 0) { special = x.num; break; }
      }
      if (special == null) special = top[0].num;
      const sObj = candidates.find(x => x.num === special);
      specialDetail = buildSpecialDetail(special, sObj.score);

      // 反向預測:分數最低的一個
      const ascPool = [...candidates].sort((a, b) => a.score - b.score);
      notSpecial       = ascPool[0].num;
      notSpecialDetail = buildSpecialDetail(notSpecial, ascPool[0].score);
    }
  }

  return {
    numbers:           selected,
    special,
    specialDetail,
    notNumbers,
    notNumberDetails,
    notSpecial,
    notSpecialDetail,
    confidence,
    recentN:           recentSlice,
    details:           selected.map(buildMainDetail)
  };
}

// ─── API routes ──────────────────────────────────────────

// 解析使用者送來的分析範圍。回傳 recentSpec 給 computeStats / predict 使用。
// query 參數兩種:
//   1) recentN=N             → 近 N 期 (從最新算)
//   2) startDex=A&endDex=B   → 指定 dex 範圍 (A、B 為 1-based,1=最舊,total=最新)
function parseRecentSpec(req, draws) {
  const total    = draws.length;
  const startDex = parseInt(req.query.startDex);
  const endDex   = parseInt(req.query.endDex);
  if (!isNaN(startDex) && !isNaN(endDex) && startDex >= 1 && endDex >= startDex && endDex <= total) {
    // draws[i].dex = total - i  → dex=endDex 對應 index = total-endDex
    return {
      kind: 'range',
      startDex,
      endDex,
      sliceStart: total - endDex,
      sliceEnd:   total - startDex + 1
    };
  }
  const n = Math.max(1, Math.min(parseInt(req.query.recentN) || 100, total));
  return { kind: 'recent', n };
}

// Helper: resolve draws + lottery meta from request
// specialMax: 特別號上限 (0 = 該彩券無特別號,例如 539、加州)
async function resolveDraws(req, force = false) {
  const type = req.query.lottery || '539';
  if (type === 'calif') {
    const draws = await updateCalifData(force);
    return { draws, maxNum: 39, numsPerDraw: 5, specialMax: 0 };
  }
  if (PILIO_CFGS[type]) {
    const cfg = PILIO_CFGS[type];
    // 539 雖然也是 pilio,但沒有特別號;這裡的 specialMax 來自 PILIO_CFGS 設定
    const draws = await updatePilioData(type, force);
    return { draws, maxNum: cfg.maxNum, numsPerDraw: cfg.numsPerDraw, specialMax: cfg.specialMax || 0 };
  }
  // default: 539
  const draws = await updateData(force);
  return { draws, maxNum: 39, numsPerDraw: 5, specialMax: 0 };
}

// ─── Auth routes ─────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '請輸入帳號密碼' });
  const users = loadUsers();
  const u = users[username];
  if (!u || !verifyPassword(password, u.salt, u.hash)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL });
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`);
  res.json({ ok: true, username });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).sid;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const s = getSession(req);
  res.json({ loggedIn: !!s, username: s ? s.username : null });
});

// ─── Admin routes (帳號管理，需帶 x-admin-key) ──────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: Object.keys(loadUsers()) });
});
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '請輸入帳號密碼' });
  const users = loadUsers();
  users[username] = hashPassword(password);
  saveUsers(users);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
  const users = loadUsers();
  delete users[req.params.username];
  saveUsers(users);
  res.json({ ok: true });
});

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
    const { draws, maxNum, numsPerDraw, specialMax } = await resolveDraws(req);
    if (!draws.length) return res.status(503).json({ error: 'No data' });

    const recentSpec = parseRecentSpec(req, draws);
    const { freq, lastSeen, recentFreq, recentSlice } = computeStats(draws, maxNum, recentSpec);
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

    // 特別號統計 (僅大樂透 / 六合彩 / 威力彩)
    let specialBlock = null;
    if (specialMax > 0) {
      const sStats = computeSpecialStats(draws, specialMax, recentSpec);
      const specialNumbers = [];
      const validDraws = draws.filter(d => d.special != null).length;
      for (let i = 1; i <= specialMax; i++) {
        specialNumbers.push({
          num:        i,
          freq:       sStats.freq[i],
          pct:        validDraws > 0 ? +((sStats.freq[i] / validDraws) * 100).toFixed(2) : 0,
          gap:        sStats.lastSeen[i],
          recentFreq: sStats.recentFreq[i]
        });
      }
      const bySFreq = [...specialNumbers].sort((a, b) => b.freq - a.freq);
      const topN = Math.min(10, specialMax);
      specialBlock = {
        specialMax,
        specialNumbers,
        specialHot:  bySFreq.slice(0, topN).map(x => x.num),
        specialCold: bySFreq.slice(-topN).reverse().map(x => x.num),
        specialMaxFreq: bySFreq[0].freq,
        specialMinFreq: bySFreq[bySFreq.length - 1].freq
      };
    }

    const payload = {
      totalDraws: draws.length,
      recentN:    recentSlice,
      mode:       recentSpec.kind,
      rangeStart: recentSpec.kind === 'range' ? recentSpec.startDex : null,
      rangeEnd:   recentSpec.kind === 'range' ? recentSpec.endDex   : null,
      maxNum,
      numsPerDraw,
      numbers,
      hot10:   byFreq.slice(0, 10).map(x => x.num),
      cold10:  byFreq.slice(-10).reverse().map(x => x.num),
      maxFreq: byFreq[0].freq,
      minFreq: byFreq[byFreq.length - 1].freq,
      ...(specialBlock || {})
    };
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/predict', async (req, res) => {
  try {
    const { draws, maxNum, numsPerDraw, specialMax } = await resolveDraws(req);
    if (draws.length < 20) return res.status(503).json({ error: 'Insufficient data' });
    const recentSpec = parseRecentSpec(req, draws);
    const result = predict(draws, maxNum, numsPerDraw, recentSpec, specialMax);
    result.mode       = recentSpec.kind;
    result.rangeStart = recentSpec.kind === 'range' ? recentSpec.startDex : null;
    result.rangeEnd   = recentSpec.kind === 'range' ? recentSpec.endDex   : null;
    res.json(result);
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

// 既有 pilio cache 若缺 special 欄位,啟動時觸發強制重抓 (補上特別號)
function pilioCacheNeedsMigration(cfg) {
  try {
    const cache = loadPilioCache(cfg.cacheFile);
    return cache.draws.length > 0 && cache.draws[0].special === undefined;
  } catch { return false; }
}

app.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log(`  ║  539 / 加州 / 大樂透 / 六合彩 / 威力彩    ║`);
  console.log(`  ║   http://localhost:${PORT}                ║`);
  console.log('  ╚══════════════════════════════════════════╝\n');
  updateData().catch(console.error);
  updateCalifData().catch(console.error);

  for (const key of ['lotto', 'mark6', 'super']) {
    if (pilioCacheNeedsMigration(PILIO_CFGS[key])) {
      console.log(`[${key}] cache 缺 special 欄位,強制重抓補資料...`);
      updatePilioData(key, true).catch(console.error);
    } else {
      updatePilioData(key).catch(console.error);
    }
  }
});

// 每分鐘檢查一次是否需要更新。
// 這裡不是每分鐘都真的去對外抓資料——updateData / updateCalifData / updatePilioData
// 內部本來就有 30 分鐘 CACHE_TTL 判斷，沒過期就直接讀本地快取回傳，幾乎零成本。
// 目的只是讓資料更新「不再依賴有沒有人連進網站」，伺服器自己會固定追上最新一期。
setInterval(() => {
  updateData().catch(console.error);
  updateCalifData().catch(console.error);
  for (const key of ['lotto', 'mark6', 'super']) {
    updatePilioData(key).catch(console.error);
  }
}, 60 * 1000);
