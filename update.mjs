#!/usr/bin/env node
/* ============================================================
   財經儀表板 — 每日資料合併腳本(確定性,不靠模型搬資料)
   ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(HERE, 'finance-data.js');
const MAX_DAYS = 30;
const MAX_EVENTS = 12;
const MAX_TIMELINE = 15; // 單一事件的時間軸筆數上限,避免長期事件(如持續數月的地緣政治)無限膨脹檔案大小
const WD = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const HEADER = `/* ============================================================
   財經儀表板資料檔
   ------------------------------------------------------------
   這個檔由每日排程的 update.mjs 自動維護,HTML 版面不需更動。
   結構: window.FINANCE_DATA = { lastUpdated, stocks{sectors,movers}, majorEvents[], days[] }
   ============================================================ */
window.FINANCE_DATA = `;

// 有些外部工具(例如 Windows 端的檔案寫入工具)在覆寫既有檔案時,若新內容比舊檔短,
// 底層掛載可能不會正確截斷檔案,導致尾端殘留 NUL 或空白字元。
// 這裡統一在讀檔時去除尾端的 NUL/空白,避免 JSON.parse / Function 解析失敗。
function readTextClean(path) {
  let txt = readFileSync(path, 'utf8');
  txt = txt.replace(/[ \s]+$/, '');
  return txt;
}

function loadData() {
  const txt = readTextClean(DATA_PATH);
  const win = {};
  new Function('window', txt)(win);
  const d = win.FINANCE_DATA || {};
  d.stocks ??= { sectors: [], movers: [] };
  d.majorEvents ??= [];
  d.days ??= [];
  return d;
}

function saveData(d) {
  const out = HEADER + JSON.stringify(d, null, 2) + ';\n';
  writeFileSync(DATA_PATH, out, 'utf8');
  const win = {};
  new Function('window', readTextClean(DATA_PATH))(win);
  if (!win.FINANCE_DATA) throw new Error('寫回後驗證失敗:解析不到 FINANCE_DATA');
  return win.FINANCE_DATA;
}

function listEvents(d) {
  const digest = d.majorEvents.map(e => ({
    id: e.id, title: e.title, status: e.status, updated: e.updated,
  }));
  process.stdout.write(JSON.stringify(digest, null, 2) + '\n');
}

function moveToFront(arr, idx) {
  const [it] = arr.splice(idx, 1);
  arr.unshift(it);
}

function applyEventOps(d, ops = []) {
  const log = [];
  for (const op of ops) {
    if (op.op === 'add') {
      const e = op.event || {};
      if (!e.id) { log.push('略過 add:缺 id'); continue; }
      if (d.majorEvents.some(x => x.id === e.id)) { log.push(`略過 add:${e.id} 已存在`); continue; }
      e.started ??= op.date || d.lastUpdated;
      e.updated = op.date || d.lastUpdated;
      (e.timeline ||= []).forEach(t => { t.date ??= e.updated; });
      if (e.timeline.length > MAX_TIMELINE) e.timeline = e.timeline.slice(0, MAX_TIMELINE);
      d.majorEvents.unshift(e);
      log.push(`新增事件 ${e.id}`);
    } else if (op.op === 'appendTimeline') {
      const i = d.majorEvents.findIndex(x => x.id === op.id);
      if (i < 0) { log.push(`略過 appendTimeline:找不到 ${op.id}`); continue; }
      const e = d.majorEvents[i];
      const tdate = op.date || d.lastUpdated;
      e.timeline ||= [];
      if (e.timeline[0] && e.timeline[0].date === tdate) {
        e.timeline[0].note = op.note || e.timeline[0].note;
      } else {
        e.timeline.unshift({ date: tdate, note: op.note || '' });
      }
      if (e.timeline.length > MAX_TIMELINE) e.timeline = e.timeline.slice(0, MAX_TIMELINE);
      e.updated = tdate;
      if (op.status) e.status = op.status;
      if (op.summary) e.summary = op.summary;
      if (op.importance) e.importance = op.importance;
      if (op.relatedStocks) e.relatedStocks = op.relatedStocks;
      if (op.sources) e.sources = op.sources;
      moveToFront(d.majorEvents, i);
      log.push(`更新事件 ${op.id}`);
    } else if (op.op === 'remove') {
      const before = d.majorEvents.length;
      d.majorEvents = d.majorEvents.filter(x => x.id !== op.id);
      log.push(d.majorEvents.length < before ? `移除事件 ${op.id}` : `略過 remove:找不到 ${op.id}`);
    } else {
      log.push(`未知 op:${op.op}`);
    }
  }
  while (d.majorEvents.length > MAX_EVENTS) {
    let idx = -1;
    for (let i = d.majorEvents.length - 1; i >= 0; i--) {
      if (d.majorEvents[i].status === 'closed') { idx = i; break; }
    }
    if (idx < 0) idx = d.majorEvents.length - 1;
    log.push(`封頂移除 ${d.majorEvents[idx].id}`);
    d.majorEvents.splice(idx, 1);
  }
  return log;
}

function mergePatch(patchPath) {
  let patch;
  try {
    patch = JSON.parse(readTextClean(patchPath));
  } catch (e) {
    throw new Error(`patch JSON 解析失敗(${e.message})。若懷疑是檔案尾端殘留空白/NUL 字元造成,` +
      `可用 bash 重新寫入 today.json(避免用 Windows 端檔案工具覆寫既有檔案)。`);
  }
  if (!patch.date) throw new Error('patch 缺 date');
  const d = loadData();
  d.lastUpdated = patch.date;
  if (patch.stocks) d.stocks = patch.stocks;
  if (patch.day) {
    const day = { ...patch.day, date: patch.date };
    day.weekday ||= WD[new Date(patch.date + 'T00:00:00').getUTCDay()];
    d.days = d.days.filter(x => x.date !== patch.date);
    d.days.unshift(day);
    if (d.days.length > MAX_DAYS) d.days = d.days.slice(0, MAX_DAYS);
    // 走勢序列、總經與日曆只需最新一天,舊日刪掉以免檔案膨脹(舊日仍保留當日數值)
    for (const old of d.days.slice(1)) {
      delete old.macro;
      delete old.calendar;
      if (old.risk) delete old.risk.history; // 舊日保留當天分數與分項即可
      for (const arr of Object.values(old.market || {})) (arr || []).forEach(x => { delete x.series; });
    }
  }
  const evlog = applyEventOps(d, patch.eventOps);
  const saved = saveData(d);
  console.log('✅ 合併完成');
  console.log(`   日期 ${saved.lastUpdated} | days ${saved.days.length} 天 | majorEvents ${saved.majorEvents.length} 筆`);
  if (patch.day) {
    const news = saved.days[0].news || [];
    console.log(`   今日新聞 ${news.length} 則`);
    // 新聞必須是上次更新之後的新文章:和前一天比對網址與標題
    const prevDay = saved.days.find(x => x.date < patch.date);
    if (prevDay) {
      const urls = new Set((prevDay.news || []).map(n => n.url).filter(Boolean));
      const titles = new Set((prevDay.news || []).map(n => n.title).filter(Boolean));
      const dup = news.filter(n => (n.url && urls.has(n.url)) || (n.title && titles.has(n.title)));
      if (dup.length) console.log(`   ⚠️ 有 ${dup.length} 則新聞和 ${prevDay.date} 重複(網址或標題相同),請換成上次更新後發布的新文章:`
        + dup.map(n => `\n     - ${n.title}`).join(''));
    }
    const noUrl = news.filter(n => !/^https?:\/\//.test(n.url || ''));
    if (noUrl.length) console.log(`   ⚠️ 有 ${noUrl.length} 則新聞沒有文章網址:` + noUrl.map(n => `\n     - ${n.title}`).join(''));
  }
  if (!patch.marketFetchedAt) console.log('   ⚠️ today.json 未經 fetch-quotes.mjs 校正,市場數字為模型自填,可能不準確');
  if (evlog.length) console.log('   事件線:' + evlog.join('; '));
}

/* 推送後確認 GitHub Pages 已經是新版本(Pages 部署通常要 1~3 分鐘,只看 HTTP 200 會拿到舊檔) */
const PAGES_URL = process.env.PAGES_URL || 'https://3a732038.github.io/finance_dashboard/finance-data.js';
async function checkPages() {
  const want = loadData().lastUpdated;
  let got = null, last = '';
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(`${PAGES_URL}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      last = `HTTP ${r.status}`;
      if (r.ok) {
        got = ((await r.text()).match(/"lastUpdated":\s*"([^"]+)"/) || [])[1] || null;
        if (got === want) { console.log(`✅ 網頁已更新:${PAGES_URL} lastUpdated ${got}`); return; }
        last += `,網頁上 lastUpdated 仍是 ${got}`;
      }
    } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 20000));
  }
  console.log(`⚠️ 等了 4 分鐘網頁仍不是最新版(本機 ${want};${last})。檔案已推送,可能是 GitHub Pages 部署延遲`);
  process.exitCode = 2;
}

const arg = process.argv[2];
try {
  if (arg === '--events') {
    listEvents(loadData());
  } else if (arg === '--check-pages') {
    await checkPages();
  } else if (arg) {
    mergePatch(arg);
  } else {
    console.error('用法: node update.mjs --events | node update.mjs today.json | node update.mjs --check-pages');
    process.exit(1);
  }
} catch (e) {
  console.error('❌ 失敗:', e.message);
  process.exit(1);
}
