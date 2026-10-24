#!/usr/bin/env node
/* ============================================================
   財經儀表板 — 行情與總經數字抓取腳本(數字一律由程式抓,不靠模型填)
   ------------------------------------------------------------
   用法:
     node fetch-quotes.mjs              抓全球市場 + 美國總經,寫入 market.json,並印出摘要供模型撰寫評論
     node fetch-quotes.mjs today.json   以 market.json(過舊則重抓)覆蓋 today.json 的 day.market / day.macro,
                                        並依 stocks.movers 的 symbol 抓個股收盤價;模型寫的 note 會保留
   資料來源:
     官方主來源(免金鑰):台股加權指數與台股個股 臺灣證券交易所 / 櫃買中心、VIX CBOE、美債殖利率 美國財政部
     市場行情 Yahoo Finance chart API(非官方、免金鑰);有官方來源的項目只在官方失敗或尚未公布時備援
     美國總經 FRED(聖路易聯準銀行)正式 API(環境變數 FRED_API_KEY);無金鑰或失敗時用 fredgraph.csv
   數據防護:
     - 超過 7 天沒更新的報價視為失敗(避免到期合約停在舊值)
     - 期貨換月偵測:合約名稱改變、近月最後交易日、或與 CNBC 近月價差過大,漲跌不可信,標 rollover
     - 第二來源 CNBC(check2):當天比對數值與漲跌幅,一致即視為已核對
     - FRED 交叉核對(check):美股指數、VIX、美債殖利率、匯率、BTC/ETH 與官方序列比對歷史值
     - 大幅波動且沒有任何來源能核對者,才提醒引用時註明待確認
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// 需要 Node 18 以上內建的 fetch;版本太舊時給出看得懂的錯誤,而不是一串 ReferenceError
if (typeof fetch !== 'function') {
  console.error(`❌ 失敗:目前 Node 版本 ${process.version} 太舊,fetch-quotes.mjs 需要 Node 18 以上(內建 fetch)。`
    + '\n   今天的數字無法由程式抓取;請改用舊流程(模型自行蒐集數字)完成 today.json,並直接執行 node update.mjs today.json。');
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKET_PATH = join(HERE, 'market.json');
const MARKET_MAX_AGE_MS = 3 * 3600e3; // market.json 超過 3 小時就重抓
const SERIES_LEN = 30;
const MACRO_SERIES_LEN = 24;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

/* ---------- 市場清單:name 固定,儀表板走勢線靠 name 串歷史,請勿隨意改名 ---------- */
// unit: '%' 漲跌以百分比表示;'bp' 以基點(殖利率類)表示。dec: 數值小數位
// fred: 以 FRED 官方序列交叉核對(tol 容許誤差:'%' 類為相對 %,'bp' 類為基點)
// alert: 單日漲跌超過此值標記「大幅波動」,未設定則用 ALERT_DEFAULT
// cnbc: 第二來源(CNBC)代號,當天就能比對數值與漲跌幅
// official: 官方主來源(見 OFFICIAL_SOURCES),Yahoo 改為備援
const MARKETS = {
  indices: [
    { name: '道瓊工業指數',     symbol: '^DJI',  cnbc: '.DJI',  fred: { id: 'DJIA' } },
    { name: '標普500',          symbol: '^GSPC', cnbc: '.SPX',  fred: { id: 'SP500' } },
    { name: '那斯達克綜合指數', symbol: '^IXIC', cnbc: '.IXIC', fred: { id: 'NASDAQCOM' } },
    { name: '費城半導體指數',   symbol: '^SOX',  cnbc: '.SOX' },
    { name: '台灣加權指數',     symbol: '^TWII', cnbc: '.TWII', official: { src: 'taiex' } },
    { name: '日經225',          symbol: '^N225', cnbc: '.N225' },
    { name: '南韓KOSPI',        symbol: '^KS11', cnbc: '.KS11' },
    { name: '恒生指數',         symbol: '^HSI',  cnbc: '.HSI' },
    { name: '上證指數',         symbol: '000001.SS', cnbc: '.SSEC' },
    { name: '德國DAX',          symbol: '^GDAXI', cnbc: '.GDAXI' },
    { name: '英國富時100',      symbol: '^FTSE', cnbc: '.FTSE' },
    { name: '印度Sensex',       symbol: '^BSESN' },
  ],
  indicators: [
    { name: 'VIX恐慌指數',      symbol: '^VIX', dec: 2, alert: 30, cnbc: '.VIX', fred: { id: 'VIXCLS', tol: 2 }, official: { src: 'cboe-vix' } },
    // 主來源為財政部固定期限殖利率(與 FRED DGS10/DGS30 同源);備援 ^TNX/^TYX 為 CBOE 收盤值,與財政部本來就會差 1~3bp
    { name: '美債10年期殖利率', symbol: '^TNX',  unit: 'bp', dec: 3, cnbc: 'US10Y', fred: { id: 'DGS10', tol: 6 }, official: { src: 'treasury', col: '10 Yr' } },
    { name: '美債30年期殖利率', symbol: '^TYX',  unit: 'bp', dec: 3, cnbc: 'US30Y', fred: { id: 'DGS30', tol: 6 }, official: { src: 'treasury', col: '30 Yr' } },
    { name: '美元指數(DXY)',    symbol: 'DX-Y.NYB', dec: 2, alert: 1.5, cnbc: '.DXY' },
  ],
  commodities: [
    { name: '布蘭特原油', symbol: 'BZ=F', cnbc: '@LCO.1' },
    { name: 'WTI原油',    symbol: 'CL=F', cnbc: '@CL.1' },
    { name: '黃金',       symbol: 'GC=F', cnbc: '@GC.1' },
    { name: '白銀',       symbol: 'SI=F', cnbc: '@SI.1' },
    { name: '銅',         symbol: 'HG=F', dec: 3, cnbc: '@HG.1' },
    { name: '天然氣',     symbol: 'NG=F', dec: 3, cnbc: '@NG.1' },
  ],
  crypto: [
    { name: '比特幣', symbol: 'BTC-USD', dec: 0, cnbc: 'BTC.CM=', fred: { id: 'CBBTCUSD', tol: 3 } },
    { name: '以太幣', symbol: 'ETH-USD', dec: 2, cnbc: 'ETH.CM=', fred: { id: 'CBETHUSD', tol: 3 } },
  ],
  // FRED 匯率為紐約中午買入價,Yahoo 為倫敦收盤,同日最多差約 0.7%;fuzzy 取同日或前後一天的最小誤差
  fx: [
    { name: '美元兌台幣(USD/TWD)', symbol: 'TWD=X', dec: 3, cnbc: 'TWD=', fred: { id: 'DEXTAUS', tol: 0.8, fuzzy: true } },
    { name: '美元兌日圓(USD/JPY)', symbol: 'JPY=X', dec: 2, cnbc: 'JPY=', fred: { id: 'DEXJPUS', tol: 0.8, fuzzy: true } },
    { name: '歐元兌美元(EUR/USD)', symbol: 'EURUSD=X', dec: 4, cnbc: 'EUR=', fred: { id: 'DEXUSEU', tol: 0.8, fuzzy: true } },
    { name: '美元兌人民幣(USD/CNY)', symbol: 'CNY=X', dec: 4, cnbc: 'CNY=', fred: { id: 'DEXCHUS', tol: 0.8, fuzzy: true } },
  ],
};
// 24 小時市場沒有統一的「收盤」,兩家前收定義不同,漲跌幅改採 CNBC(以紐約收盤為基準)
const CNBC_CHANGE_GROUPS = new Set(['fx', 'crypto']);
const ALERT_DEFAULT = { indices: 4, indicators: 15, commodities: 6, crypto: 10, fx: 1.5 }; // bp 類一律用 indicators 的 15bp
const FRED_TOL_DEFAULT = 0.15; // 指數類相對誤差 %

/* ---------- 美國總經(FRED) ---------- */
// tf: level 原值 / yoy 年增率(%)/ mom 月增率(%)/ diff 月增量;scale: 原值換算倍數(如百萬→兆);group 決定儀表板分組與順序
const MACRO = [
  { name: '聯邦基金利率(上限)', id: 'DFEDTARU',         tf: 'level', unit: '%',  dec: 2, freq: 'daily',     group: '貨幣政策' },
  { name: '美債2年期殖利率',     id: 'DGS2',             tf: 'level', unit: '%',  dec: 2, freq: 'daily',     group: '貨幣政策', hint: '對聯準會利率預期最敏感的天期' },
  { name: '10年-2年期利差',      id: 'T10Y2Y',           tf: 'level', unit: '%',  dec: 2, freq: 'daily',     group: '貨幣政策', hint: '負值=殖利率曲線倒掛,常被視為衰退前兆' },
  { name: '10年-3個月利差',      id: 'T10Y3M',           tf: 'level', unit: '%',  dec: 2, freq: 'daily',     group: '貨幣政策', hint: '紐約聯準銀行衰退機率模型採用的利差' },
  { name: '10年期實質利率',      id: 'DFII10',           tf: 'level', unit: '%',  dec: 2, freq: 'daily',     group: '貨幣政策', hint: '抗通膨公債(TIPS)殖利率;上升通常壓抑黃金與成長股' },
  { name: '聯準會資產負債表',    id: 'WALCL',            tf: 'level', unit: '兆美元', dec: 2, scale: 1e-6, freq: 'weekly', group: '貨幣政策', hint: '縮表=資產減少,市場資金收緊' },
  { name: 'M2貨幣供給年增率',    id: 'M2SL',             tf: 'yoy',   unit: '%',  dec: 1, freq: 'monthly',   group: '貨幣政策', hint: '市場整體資金量的變化' },
  { name: 'CPI年增率',           id: 'CPIAUCSL',         tf: 'yoy',   unit: '%',  dec: 1, freq: 'monthly',   group: '通膨' },
  { name: '核心CPI年增率',       id: 'CPILFESL',         tf: 'yoy',   unit: '%',  dec: 1, freq: 'monthly',   group: '通膨' },
  { name: 'PCE年增率',           id: 'PCEPI',            tf: 'yoy',   unit: '%',  dec: 1, freq: 'monthly',   group: '通膨' },
  { name: '核心PCE年增率',       id: 'PCEPILFE',         tf: 'yoy',   unit: '%',  dec: 1, freq: 'monthly',   group: '通膨', hint: '聯準會最重視的通膨指標,目標 2%' },
  { name: 'PPI年增率',           id: 'PPIFIS',           tf: 'yoy',   unit: '%',  dec: 1, freq: 'monthly',   group: '通膨', hint: '最終需求生產者物價,常領先 CPI' },
  { name: '5年期通膨預期',       id: 'T5YIE',            tf: 'level', unit: '%',  dec: 2, freq: 'daily',     group: '通膨', hint: '債市隱含的未來 5 年平均通膨' },
  { name: '失業率',              id: 'UNRATE',           tf: 'level', unit: '%',  dec: 1, freq: 'monthly',   group: '就業' },
  { name: '非農新增就業',        id: 'PAYEMS',           tf: 'diff',  unit: '千人', dec: 0, freq: 'monthly', group: '就業' },
  { name: '平均時薪年增率',      id: 'CES0500000003',    tf: 'yoy',   unit: '%',  dec: 1, freq: 'monthly',   group: '就業', hint: '薪資漲幅過高會推升服務業通膨' },
  { name: 'JOLTS職缺數',         id: 'JTSJOL',           tf: 'level', unit: '千個', dec: 0, freq: 'monthly', group: '就業', hint: '職缺減少=勞動市場降溫' },
  { name: '初領失業救濟金',      id: 'ICSA',             tf: 'level', unit: '人', dec: 0, freq: 'weekly',    group: '就業' },
  { name: '續領失業救濟金',      id: 'CCSA',             tf: 'level', unit: '人', dec: 0, freq: 'weekly',    group: '就業', hint: '持續增加=失業者較難找到工作' },
  { name: '實質GDP季增年率',     id: 'A191RL1Q225SBEA',  tf: 'level', unit: '%',  dec: 1, freq: 'quarterly', group: '成長' },
  { name: '零售銷售月增率',      id: 'RSAFS',            tf: 'mom',   unit: '%',  dec: 1, freq: 'monthly',   group: '成長', hint: '美國消費強弱,約占 GDP 七成的消費動能' },
  { name: '工業生產月增率',      id: 'INDPRO',           tf: 'mom',   unit: '%',  dec: 1, freq: 'monthly',   group: '成長' },
  { name: '密大消費者信心',      id: 'UMCSENT',          tf: 'level', unit: '',   dec: 1, freq: 'monthly',   group: '成長' },
  { name: '30年期房貸利率',      id: 'MORTGAGE30US',     tf: 'level', unit: '%',  dec: 2, freq: 'weekly',    group: '房市', hint: '房地美每週調查' },
  { name: '新屋開工',            id: 'HOUST',            tf: 'level', unit: '千戶', dec: 0, freq: 'monthly', group: '房市', hint: '經季節調整年率' },
  { name: '高收益債利差',        id: 'BAMLH0A0HYM2',     tf: 'level', unit: '%',  dec: 2, freq: 'daily',     group: '金融壓力', hint: '利差擴大=信用風險升溫' },
  { name: '投資級債利差',        id: 'BAMLC0A0CM',       tf: 'level', unit: '%',  dec: 2, freq: 'daily',     group: '金融壓力' },
  { name: '聖路易金融壓力指數',  id: 'STLFSI4',          tf: 'level', unit: '',   dec: 2, freq: 'weekly',    group: '金融壓力', hint: '0=正常水準,正值=壓力高於平均' },
];

/* ---------- 經濟日曆:只挑對全球總經有影響的重要數據 ----------
   imp: high 會明顯牽動市場(利率決議、CPI、非農...);medium 次要
   name 為 Nasdaq 的英文事件名(完全相符),zh 為顯示用中文名 */
const CAL_EVENTS = {
  'United States': { zh: '美國', flag: '🇺🇸', list: [
    ['Fed Interest Rate Decision', '聯準會利率決議', 'high'],
    ['FOMC Minutes', 'FOMC 會議紀要', 'high'],
    ['CPI', 'CPI 消費者物價', 'high'],
    ['Core CPI', '核心 CPI', 'high'],
    ['PPI', 'PPI 生產者物價', 'medium'],
    ['Core PCE Price Index', '核心 PCE 物價', 'high'],
    ['Nonfarm Payrolls', '非農就業人數', 'high'],
    ['Unemployment Rate', '失業率', 'high'],
    ['Average Hourly Earnings (YoY)', '平均時薪年增', 'medium'],
    ['GDP', 'GDP', 'high'],
    ['Retail Sales', '零售銷售', 'medium'],
    ['ISM Manufacturing PMI', 'ISM 製造業 PMI', 'medium'],
    ['ISM Non-Manufacturing PMI', 'ISM 服務業 PMI', 'medium'],
    ['JOLTS Job Openings', 'JOLTS 職缺', 'medium'],
    ['Initial Jobless Claims', '初領失業救濟金', 'medium'],
    ['Michigan Consumer Sentiment', '密大消費者信心', 'medium'],
    ['CB Consumer Confidence', '經濟諮商會消費者信心', 'medium'],
    ['Employment Cost Index', '就業成本指數', 'medium'],
    ['Durable Goods Orders', '耐久財訂單', 'medium'],
  ] },
  'China': { zh: '中國', flag: '🇨🇳', list: [
    ['Manufacturing PMI', '官方製造業 PMI', 'high'],
    ['Non-Manufacturing PMI', '官方非製造業 PMI', 'medium'],
    ['CPI', 'CPI 消費者物價', 'medium'],
    ['GDP', 'GDP', 'high'],
    ['Exports', '出口', 'medium'],
    ['Trade Balance', '貿易收支', 'medium'],
    ['Loan Prime Rate 1Y', '一年期 LPR', 'medium'],
  ] },
  'Euro Zone': { zh: '歐元區', flag: '🇪🇺', list: [
    ['ECB Interest Rate Decision', '歐洲央行利率決議', 'high'],
    ['CPI', 'CPI 消費者物價', 'high'],
    ['GDP', 'GDP', 'medium'],
    ['HCOB Eurozone Manufacturing PMI', '製造業 PMI', 'medium'],
    ['Unemployment Rate', '失業率', 'medium'],
  ] },
  'Japan': { zh: '日本', flag: '🇯🇵', list: [
    ['BoJ Interest Rate Decision', '日本央行利率決議', 'high'],
    ['Tokyo Core CPI', '東京核心 CPI', 'medium'],
    ['National Core CPI', '全國核心 CPI', 'medium'],
    ['GDP', 'GDP', 'medium'],
  ] },
  'United Kingdom': { zh: '英國', flag: '🇬🇧', list: [
    ['BoE Interest Rate Decision', '英國央行利率決議', 'high'],
    ['CPI', 'CPI 消費者物價', 'medium'],
    ['GDP', 'GDP', 'medium'],
  ] },
  'Germany': { zh: '德國', flag: '🇩🇪', list: [
    ['German CPI', 'CPI 消費者物價', 'medium'],
    ['German Ifo Business Climate Index', 'Ifo 商業景氣', 'medium'],
    ['German GDP', 'GDP', 'medium'],
  ] },
  'South Korea': { zh: '南韓', flag: '🇰🇷', list: [
    ['CPI', 'CPI 消費者物價', 'medium'],
    ['GDP', 'GDP', 'medium'],
    ['Exports', '出口', 'medium'],
  ] },
};
/* ---------- 類股熱力圖 ---------- */
// 美股:SPDR 11 大類股 ETF + 半導體(Yahoo 抓、CNBC 核對)
const US_SECTORS = [
  ['XLK', '科技'], ['SMH', '半導體'], ['XLC', '通訊服務'], ['XLY', '非必需消費'], ['XLF', '金融'],
  ['XLI', '工業'], ['XLV', '醫療保健'], ['XLP', '必需消費'], ['XLE', '能源'], ['XLB', '原物料'],
  ['XLU', '公用事業'], ['XLRE', '房地產'],
];
// 台股:證交所官方類股指數(名稱去掉「類指數」);不含電子工業類等彙總指數
const TW_SECTORS = ['半導體', '電腦及週邊設備', '光電', '通信網路', '電子零組件', '電子通路', '資訊服務', '其他電子',
  '金融保險', '航運', '塑膠', '化學', '生技醫療', '鋼鐵', '汽車', '電機機械', '電器電纜', '水泥', '食品', '紡織纖維',
  '玻璃陶瓷', '造紙', '橡膠', '建材營造', '觀光餐旅', '貿易百貨', '油電燃氣', '綠能環保', '數位雲端', '運動休閒', '居家生活'];

const CAL_DAYS = 7;
const EARNINGS_MIN_CAP = 200e9;          // 只列市值 2,000 億美元以上的財報
const EARNINGS_ALWAYS = new Set(['TSM']); // 不論市值都列(台積電 ADR)

/* ---------- 共用 ---------- */
function readTextClean(path) {
  return readFileSync(path, 'utf8').replace(/[\0\s]+$/, '');
}
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
function autoDec(v) { const a = Math.abs(v); return a >= 100 ? 2 : a >= 10 ? 3 : 4; }
function dirOf(chg) { return Math.abs(chg) < 0.005 ? 'flat' : chg > 0 ? 'up' : 'down'; }

async function getText(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw lastErr;
}

/* 有限併發,避免一次打太多請求被限流 */
async function pool(items, n, fn) {
  const out = new Array(items.length); let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/* ---------- Yahoo Finance ---------- */
async function yahooChart(symbol, range = '3mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const j = JSON.parse(await getText(url));
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(j?.chart?.error?.description || '無資料');
  const meta = res.meta, off = meta.gmtoffset || 0;
  const ts = res.timestamp || [], cl = res.indicators?.quote?.[0]?.close || [];
  const day = t => new Date((t + off) * 1000).toISOString().slice(0, 10);
  const pts = [];
  ts.forEach((t, i) => { if (cl[i] != null && isFinite(cl[i])) pts.push({ d: day(t), c: cl[i] }); });
  // 同一交易日可能出現兩筆(盤中即時 + 日K),保留最後一筆
  const dedup = [];
  for (const p of pts) { if (dedup.length && dedup[dedup.length - 1].d === p.d) dedup[dedup.length - 1] = p; else dedup.push(p); }
  // 以 regularMarketPrice 校正最新一筆
  if (meta.regularMarketPrice != null && meta.regularMarketTime) {
    const d = day(meta.regularMarketTime);
    const last = dedup[dedup.length - 1];
    if (last && last.d === d) last.c = meta.regularMarketPrice;
    else if (!last || d > last.d) dedup.push({ d, c: meta.regularMarketPrice });
  }
  if (dedup.length < 2) throw new Error('資料點不足');
  // 期貨合約到期等情況會讓報價停在舊值,超過 7 天沒更新視為失敗,不拿舊數字充當今日
  const ageDays = (Date.now() - Date.parse(dedup[dedup.length - 1].d)) / 864e5;
  if (ageDays > 7) throw new Error(`資料過舊(最後一筆 ${dedup[dedup.length - 1].d})`);
  const now = Date.now() / 1000, reg = meta.currentTradingPeriod?.regular;
  const live = !!(reg && now >= reg.start && now < reg.end);
  return { pts: dedup, live, currency: meta.currency, contract: (meta.shortName || '').trim() };
}

function toMarketItem(cfg, chart, group) {
  const { pts, live } = chart;
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const dec = cfg.dec ?? autoDec(last.c);
  const change = cfg.unit === 'bp'
    ? round((last.c - prev.c) * 100, 1)
    : round((last.c / prev.c - 1) * 100, 2);
  const alert = cfg.alert ?? (cfg.unit === 'bp' ? ALERT_DEFAULT.indicators : ALERT_DEFAULT[group]);
  return {
    name: cfg.name, symbol: cfg.symbol,
    value: round(last.c, dec), change, unit: cfg.unit || '%', dir: dirOf(change),
    asOf: last.d, live, source: chart.source || 'Yahoo',
    bigMove: alert != null && Math.abs(change) >= alert,
    series: pts.slice(-SERIES_LEN).map(p => round(p.c, dec)),
    note: '',
  };
}

/* ---------- 官方主來源 ----------
   有官方來源的項目以官方收盤為主,Yahoo 只在兩種情況備援:官方抓取失敗,
   或 Yahoo 已有更新的「已收盤」交易日而官方尚未公布(兩邊不混用,避免來源差異算出假漲跌)。
   「尚未公布」只認當地最近 lag 天內的交易日:證交所當天就公布,所以更早的日期官方沒有就代表休市,
   Yahoo 在台股休市日會補一筆零漲跌的假資料,不能採用;CBOE、財政部可能晚一天更新。
   盤中執行時,官方只有前一日收盤,仍以官方為準。 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let twseNext = 0;
async function twseGet(url) { // 證交所與櫃買有流量限制,請求間隔至少 1 秒
  const at = Math.max(Date.now(), twseNext);
  twseNext = at + 1000;
  await sleep(at - Date.now());
  return getText(url);
}
const rocDate = s => { const [y, m, d] = s.split('/'); return `${+y + 1911}-${m}-${d}`; };
const numOf = s => parseFloat(String(s).replace(/<[^>]+>|,/g, ''));
/* 台北時間本月起往前的月份(月初 15 日前多抓一個月,走勢線才湊得滿 SERIES_LEN 筆) */
function recentMonths() {
  const t = tpeToday(); let y = +t.slice(0, 4), m = +t.slice(5, 7);
  const out = [];
  for (let i = 0; i < (+t.slice(8, 10) < 15 ? 3 : 2); i++) { out.unshift({ y, m }); if (--m === 0) { m = 12; y--; } }
  return out;
}
async function twMonthly(urlOf, rowsOf, col) {
  const pts = [];
  for (const ym of recentMonths()) {
    const j = JSON.parse(await twseGet(urlOf(ym)));
    for (const r of rowsOf(j) || []) { const c = numOf(r[col]); if (isFinite(c)) pts.push({ d: rocDate(r[0]), c }); }
  }
  return pts;
}
const ymd1 = ({ y, m }) => `${y}${String(m).padStart(2, '0')}01`;

let cboeVixP;
function cboeVix() { // 1990 年至今的 VIX 日收盤
  return cboeVixP ||= getText('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv').then(csv =>
    csv.trim().split(/\r?\n/).slice(1).map(l => l.split(','))
      .map(([d, , , , c]) => { const [m, dd, y] = d.split('/'); return { d: `${y}-${m}-${dd}`, c: +c }; })
      .filter(p => isFinite(p.c) && p.c > 0));
}

const treasuryYears = new Map();
function treasuryYear(y) { // 財政部每日固定期限殖利率(par yield curve),依年份分檔
  if (!treasuryYears.has(y)) treasuryYears.set(y, getText('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/'
    + `daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}`).then(csv => {
    const [head, ...rows] = csv.trim().split(/\r?\n/).map(l => l.split(','));
    const cols = head.map(h => h.replace(/"/g, '').trim());
    return rows.map(r => { const [m, d, yy] = r[0].split('/'); return { d: `${yy}-${m}-${d}`, v: Object.fromEntries(cols.map((c, i) => [c, r[i]])) }; });
  }));
  return treasuryYears.get(y);
}

const OFFICIAL_SOURCES = {
  taiex: { label: '證交所', tz: 'Asia/Taipei', lag: 0, fetch: () => twMonthly(
    ym => `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ymd1(ym)}&response=json`, j => j.data, 4) },
  twse: { label: '證交所', tz: 'Asia/Taipei', lag: 0, fetch: o => twMonthly(
    ym => `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymd1(ym)}&stockNo=${o.code}&response=json`, j => j.data, 6) },
  tpex: { label: '櫃買中心', tz: 'Asia/Taipei', lag: 0, fetch: o => twMonthly(
    ym => `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${o.code}&date=${ym.y}/${String(ym.m).padStart(2, '0')}/01&response=json`,
    j => j.tables?.[0]?.data, 6) },
  'cboe-vix': { label: 'CBOE', tz: 'America/New_York', lag: 1, fetch: async () => (await cboeVix()).slice(-90) },
  treasury: { label: '美國財政部', tz: 'America/New_York', lag: 1, fetch: async o => {
    const y = +new Date().toISOString().slice(0, 4);
    let rows = await treasuryYear(y);
    if (rows.length < 45) rows = [...rows, ...await treasuryYear(y - 1)];
    return rows.map(r => ({ d: r.d, c: parseFloat(r.v[o.col]) })).filter(p => isFinite(p.c)).sort((a, b) => a.d < b.d ? -1 : 1);
  } },
};

async function officialChart(official) {
  const pts = await OFFICIAL_SOURCES[official.src].fetch(official);
  if (pts.length < 2) throw new Error('資料點不足');
  const lastD = pts[pts.length - 1].d;
  if ((Date.now() - Date.parse(lastD)) / 864e5 > 7) throw new Error(`資料過舊(最後一筆 ${lastD})`);
  return { pts, live: false, contract: '' };
}

/* 個股代號對應的台股官方來源:2330.TW / 純數字 → 證交所,6488.TWO → 櫃買中心 */
function twOfficial(sym) {
  const s = String(sym).trim().toUpperCase(); let m;
  if ((m = s.match(/^(\d{4,6}[A-Z]?)\.TWO$/))) return { src: 'tpex', code: m[1] };
  if ((m = s.match(/^(\d{4,6}[A-Z]?)\.TW$/)) || (m = s.match(/^(\d{4,6})$/))) return { src: 'twse', code: m[1] };
  return null;
}

/* 取得報價走勢:有官方來源就以官方為主,notes 收集改用 Yahoo 備援的原因 */
async function primaryChart(official, yahooSymbol, label, notes) {
  if (!official) return { ...(await yahooChart(yahooSymbol)), source: 'Yahoo' };
  const { label: src, tz, lag } = OFFICIAL_SOURCES[official.src];
  const [o, y] = await Promise.allSettled([officialChart(official), yahooChart(yahooSymbol)]);
  if (o.status === 'rejected') {
    if (y.status === 'rejected') throw new Error(`${src}:${o.reason.message};Yahoo:${y.reason.message}`);
    notes.push(`${label} ${src}抓取失敗(${o.reason.message}),改用 Yahoo`);
    return { ...y.value, source: 'Yahoo' };
  }
  const oLast = o.value.pts[o.value.pts.length - 1].d;
  if (y.status === 'fulfilled' && !y.value.live) {
    const yLast = y.value.pts[y.value.pts.length - 1].d;
    const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    if (yLast > oLast && yLast >= shiftDate(localToday, -lag)) {
      notes.push(`${label} ${src}尚未公布 ${yLast} 收盤(最新 ${oLast}),暫用 Yahoo`);
      return { ...y.value, source: 'Yahoo' };
    }
  }
  return { ...o.value, source: src };
}

/* ---------- 期貨換月偵測 ----------
   Yahoo 的 XX=F 是「近月連續合約」,近月到期就自動接到下一個月份。
   新舊合約本來就有價差,換月當天用「今天新合約 vs 昨天舊合約」算出的漲跌是假的。
   判斷方式:(1) 合約名稱與上次抓取時不同 (2) 名稱含 Last Day(近月最後交易日,隨時會切換)
   換月時保留價格,但漲跌改標 flat 並加 rollover 旗標,儀表板顯示灰色「換月」。 */
function markRollover(item, contract, prevItem) {
  if (!item.symbol.endsWith('=F')) return;
  item.contract = contract;
  const reasons = [];
  if (prevItem?.contract && prevItem.contract !== contract) reasons.push(`合約由「${prevItem.contract}」換成「${contract}」`);
  if (/last day/i.test(contract)) reasons.push('近月合約最後交易日');
  // 同一交易日重跑時沿用先前的判斷,避免換月旗標被第二次抓取洗掉
  if (!reasons.length && prevItem?.rollover && prevItem.asOf === item.asOf) reasons.push(prevItem.rolloverReason || '同日先前已判定換月');
  if (reasons.length) {
    item.rollover = true;
    item.rolloverReason = reasons.join(';');
    item.dir = 'flat';
    item.bigMove = false;
  }
}

/* ---------- CNBC 第二來源 ---------- */
async function cnbcQuotes(symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += 40) {
    const batch = symbols.slice(i, i + 40);
    const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols='
      + encodeURIComponent(batch.join('|')) + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=0&output=json&events=0';
    const j = JSON.parse(await getText(url));
    let qs = j?.FormattedQuoteResult?.FormattedQuote || [];
    if (!Array.isArray(qs)) qs = [qs];
    const num = s => { const n = parseFloat(String(s ?? '').replace(/[,%]/g, '')); return isFinite(n) ? n : null; };
    for (const q of qs) {
      if (q.code !== 0 && q.code !== '0') continue;
      const last = num(q.last), chg = num(q.change_pct), prev = num(q.previous_day_closing);
      if (last == null) continue;
      out.set(q.symbol, { last, chg, prev, date: String(q.last_time || '').slice(0, 10) });
    }
  }
  return out;
}

/* 個股代號轉成 CNBC 格式:NVDA.US→NVDA、2330.TW→2330-TW、700.HK→700-HK、600519.SH→600519-CN */
function toCnbcSymbol(sym) {
  const s = String(sym).trim().toUpperCase();
  let m;
  if ((m = s.match(/^(.+)\.US$/))) return m[1];
  if ((m = s.match(/^(\d+)\.(TW|TWO)$/))) return `${m[1]}-${m[2]}`;
  if ((m = s.match(/^0*(\d+)\.HK$/))) return `${m[1]}-HK`;
  if ((m = s.match(/^(\d+)\.(SH|SZ|SS)$/))) return `${m[1]}-CN`;
  if (/^\d{4,6}$/.test(s)) return `${s}-TW`;
  if (/^[A-Z.\-]+$/.test(s)) return s;
  return null;
}

/* 與 CNBC 比對當天數值與漲跌幅。兩邊報價日期不同(其中一邊尚未更新)就不比 */
function crossCheck2(item, q, cnbcSym, group) {
  if (!q) return { src: 'CNBC', id: cnbcSym, status: 'none' };
  const bp = item.unit === 'bp';
  // CNBC 已進入新交易日、Yahoo 還停在前一日收盤:改拿 CNBC 的「前日收盤」比對數值(漲跌無法比)
  if (q.date > item.asOf && !item.live && q.prev != null) {
    const d = bp ? Math.abs(item.value - q.prev) * 100 : Math.abs(item.value / q.prev - 1) * 100;
    return { src: 'CNBC', id: cnbcSym, status: d <= (bp ? 3 : 0.15) ? 'ok' : 'mismatch', viaPrev: true,
      cnbc: q.prev, cnbcChange: null, valueDiff: round(d, 2), diffUnit: bp ? 'bp' : '%' };
  }
  if (q.date !== item.asOf) return { src: 'CNBC', id: cnbcSym, status: 'skip', reason: `報價日期不同(Yahoo ${item.asOf} / CNBC ${q.date})` };
  const valueDiff = bp ? Math.abs(item.value - q.last) * 100 : Math.abs(item.value / q.last - 1) * 100;
  const valueTol = bp ? (item.live ? 5 : 3) : (item.live ? 0.6 : 0.15);
  const out = { src: 'CNBC', id: cnbcSym, cnbc: q.last, cnbcChange: q.chg, valueDiff: round(valueDiff, 2), diffUnit: bp ? 'bp' : '%' };
  let ok = valueDiff <= valueTol;
  // 殖利率類 CNBC 的 change_pct 是「殖利率本身的百分比變化」,與 bp 不可比,只比數值
  if (!bp && q.chg != null) {
    out.changeDiff = round(Math.abs(item.change - q.chg), 2);
    if (CNBC_CHANGE_GROUPS.has(group)) {
      if (ok && out.changeDiff > 0.1) { out.changeFrom = item.change; item.change = round(q.chg, 2); item.dir = dirOf(item.change); out.changeAdopted = true; }
    } else if (out.changeDiff > (item.live ? 0.6 : 0.15)) ok = false;
  }
  out.status = ok ? 'ok' : 'mismatch';
  return out;
}

/* ---------- FRED 交叉核對 ----------
   FRED 官方資料通常比 Yahoo 晚 1~2 天,所以比對兩邊都有的最近 5 個交易日,取最大誤差。
   latest=true 代表連今天的值都核對到了;false 代表今天的值 FRED 尚未公布。 */
function crossCheck(cfg, unit, pts, obs) {
  // FRED 部分序列在假日填 0 而非空值,這些點不能拿來比對
  const fm = new Map(obs.filter(o => o.v > 0).map(o => [o.d, o.v]));
  const both = pts.filter(p => fm.has(p.d)).slice(-5);
  if (!both.length) return { src: 'FRED', id: cfg.fred.id, status: 'none' };
  const tol = cfg.fred.tol ?? FRED_TOL_DEFAULT;
  const ym = new Map(pts.map(p => [p.d, p.c]));
  const shift = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
  const diffOf = (y, f) => unit === 'bp' ? Math.abs(y - f) * 100 : Math.abs(y / f - 1) * 100;
  let worst = null;
  for (const p of both) {
    const f = fm.get(p.d);
    let y = p.c, diff = diffOf(y, f);
    if (cfg.fred.fuzzy) for (const n of [-1, 1]) {
      const y2 = ym.get(shift(p.d, n));
      if (y2 != null && diffOf(y2, f) < diff) { y = y2; diff = diffOf(y2, f); }
    }
    if (!worst || diff > worst.diff) worst = { d: p.d, y, f, diff };
  }
  const lastBoth = both[both.length - 1].d;
  return {
    src: 'FRED', id: cfg.fred.id,
    status: worst.diff <= tol ? 'ok' : 'mismatch',
    through: lastBoth, latest: lastBoth === pts[pts.length - 1].d,
    worstDate: worst.d, yahoo: round(worst.y, 4), fred: worst.f,
    diff: round(worst.diff, 2), diffUnit: unit === 'bp' ? 'bp' : '%', tol,
  };
}

/* 個股代號轉成 Yahoo 格式:NVDA.US→NVDA、700.HK→0700.HK、600519.SH→600519.SS */
function toYahooSymbol(sym) {
  const s = String(sym).trim().toUpperCase();
  let m;
  if ((m = s.match(/^(.+)\.US$/))) return m[1].replace(/\./g, '-');
  if ((m = s.match(/^(\d+)\.HK$/))) return m[1].padStart(4, '0') + '.HK';
  if ((m = s.match(/^(\d+)\.SH$/))) return m[1] + '.SS';
  if (/^\d{4,6}$/.test(s)) return s + '.TW';           // 純數字視為台股上市
  return s;
}

/* ---------- FRED ----------
   有 FRED_API_KEY 環境變數時用正式 API;沒有金鑰或 API 失敗時退回網頁 CSV */
async function fredSeries(id) {
  const start = new Date(Date.now() - 4 * 365 * 864e5).toISOString().slice(0, 10);
  const key = process.env.FRED_API_KEY;
  if (key) {
    try {
      const j = JSON.parse(await getText(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}`
        + `&observation_start=${start}&file_type=json&api_key=${encodeURIComponent(key)}`));
      const obs = (j.observations || []).filter(o => o.value !== '.' && isFinite(+o.value)).map(o => ({ d: o.date, v: +o.value }));
      if (obs.length) return obs;
    } catch {} // 錯誤訊息可能含金鑰網址,不往外丟,直接退回 CSV
  }
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`;
  let csv;
  try { csv = await getText(url); }
  catch (e) {
    // FRED 會對雲端機房 IP 擋瀏覽器 UA(503),改用 curl UA 重試
    if (!/HTTP 503|HTTP 403/.test(e.message)) throw e;
    const r = await fetch(url, { headers: { 'User-Agent': 'curl/8.5.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    csv = await r.text();
  }
  return csv.trim().split(/\r?\n/).slice(1).map(l => l.split(','))
    .filter(([, v]) => v && v !== '.' && isFinite(+v)).map(([d, v]) => ({ d, v: +v }));
}

function toMacroItem(cfg, obs) {
  let pts;
  if (cfg.tf === 'yoy') {
    const byDate = new Map(obs.map(o => [o.d, o.v]));
    pts = obs.map(o => {
      const d = new Date(o.d + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1);
      const base = byDate.get(d.toISOString().slice(0, 10));
      return base ? { d: o.d, v: (o.v / base - 1) * 100 } : null;
    }).filter(Boolean);
  } else if (cfg.tf === 'mom') {
    pts = obs.slice(1).map((o, i) => ({ d: o.d, v: (o.v / obs[i].v - 1) * 100 }));
  } else if (cfg.tf === 'diff') {
    pts = obs.slice(1).map((o, i) => ({ d: o.d, v: o.v - obs[i].v }));
  } else pts = obs.map(o => cfg.scale ? { d: o.d, v: o.v * cfg.scale } : o);
  if (pts.length < 2) throw new Error('資料點不足');
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const period = cfg.freq === 'monthly' ? last.d.slice(0, 7)
    : cfg.freq === 'quarterly' ? `${last.d.slice(0, 4)} Q${Math.floor((+last.d.slice(5, 7) - 1) / 3) + 1}` : last.d;
  return {
    name: cfg.name, id: cfg.id, group: cfg.group,
    value: round(last.v, cfg.dec), prev: round(prev.v, cfg.dec),
    change: round(last.v - prev.v, cfg.dec), unit: cfg.unit,
    dir: dirOf(last.v - prev.v), period, freq: cfg.freq,
    series: pts.slice(-(cfg.freq === 'daily' ? 60 : MACRO_SERIES_LEN)).map(p => round(p.v, cfg.dec)),
    hint: cfg.hint || '',
  };
}

/* ---------- 經濟日曆 ----------
   來源:Nasdaq 經濟日曆 / 財報日曆 API(非官方、免金鑰)、聯準會官網 FOMC 會議日程
   Nasdaq 經濟日曆的兩個怪癖(2026-10 實測):
     1. 時間欄位雖叫 gmt,實際是固定 UTC-4(不隨美國夏令時間變動)
     2. 查詢日期 d 回傳的事件,真實日期是 d 的前一天
   第 2 點每次都用「初領失業救濟金固定在週四公布」重新校準,並與聯準會官網的 FOMC 日期互相驗證 */
const NASDAQ_TZ_OFFSET_H = -4;
const shiftDate = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const tpeToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

async function nasdaqJson(path) {
  const r = await fetch('https://api.nasdaq.com' + path, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json())?.data;
}

/* 美東當地時間 → 台北時間(自動處理夏令/標準時間),回傳 "MM-DD HH:mm" */
function tpeFromNy(ymd, h, m) {
  const want = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), h, m);
  const nyAsUtc = t => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t)).map(x => [x.type, +x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); };
  let t = want; for (let i = 0; i < 3; i++) t += want - nyAsUtc(t);
  const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${q.month}-${q.day} ${q.hour}:${q.minute}`;
}

/* 聯準會官網 FOMC 會議日程(今年 + 明年) */
async function fomcMeetings() {
  const html = await getText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const out = [];
  const sections = html.split(/<h4><a[^>]*>(\d{4}) FOMC Meetings<\/a><\/h4>/);
  for (let i = 1; i < sections.length; i += 2) {
    const year = +sections[i], body = sections[i + 1];
    const re = /fomc-meeting__month[^>]*><strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g;
    let m;
    while ((m = re.exec(body))) {
      const mon = m[1].toLowerCase().split('/').map(s => months.indexOf(s.trim()));
      const dm = m[2].match(/^(\d+)(?:-(\d+))?(\*)?/);
      if (!dm || /notation|unscheduled/i.test(m[2]) || mon[0] < 0) continue;
      const m1 = mon[0], m2 = mon[1] >= 0 ? mon[1] : m1;
      const d1 = +dm[1], d2 = dm[2] ? +dm[2] : d1;
      const iso = (mm, dd) => `${year + (mm < m1 ? 1 : 0)}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      out.push({ start: iso(m1, d1), end: iso(m2, d2), sep: !!dm[3] }); // sep:有經濟預測摘要(點陣圖)
    }
  }
  return out.sort((a, b) => a.end.localeCompare(b.end));
}

/* 依「初領失業救濟金在週四(或假日週的週三)」推算 Nasdaq 日期偏移 */
function calibrateOffset(rowsByListed) {
  const votes = new Map();
  for (const [listed, rows] of rowsByListed) {
    if (!rows.some(r => r.country === 'United States' && r.eventName === 'Initial Jobless Claims')) continue;
    for (const k of [-1, 0, 1]) {
      const wd = new Date(shiftDate(listed, k) + 'T00:00:00Z').getUTCDay();
      if (wd === 4) votes.set(k, (votes.get(k) || 0) + 2);
      else if (wd === 3) votes.set(k, (votes.get(k) || 0) + 1);
    }
  }
  if (!votes.size) return { offset: -1, calibrated: false };
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { offset: best, calibrated: true };
}

/* UTC-4 的日期 + 時間 → 台北時間 */
function toTaipei(date, hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { date, time: '', sortKey: date + 'T99' };
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, +m[1] - NASDAQ_TZ_OFFSET_H + 8, +m[2]));
  const iso = t.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), sortKey: iso.slice(0, 16) };
}

async function fetchCalendar() {
  const warnings = [];
  const from = tpeToday(), to = shiftDate(from, CAL_DAYS);
  // 多抓前後各一天,確保偏移校正後仍涵蓋整個區間
  const listedDates = Array.from({ length: CAL_DAYS + 3 }, (_, i) => shiftDate(from, i - 1));
  const rowsByListed = new Map();
  await pool(listedDates, 3, async d => {
    try { rowsByListed.set(d, (await nasdaqJson(`/api/calendar/economicevents?date=${d}`))?.rows || []); }
    catch (e) { warnings.push(`經濟日曆 ${d} 抓取失敗:${e.message}`); }
  });
  const { offset, calibrated } = calibrateOffset(rowsByListed);
  if (!calibrated) warnings.push('無法用初領失業金校準 Nasdaq 日期偏移,沿用預設 -1 天');

  const clean = s => { const t = String(s ?? '').replace(/&nbsp;/g, ' ').trim(); return t || null; };
  const byKey = new Map();
  for (const [listed, rows] of rowsByListed) {
    for (const r of rows) {
      const c = CAL_EVENTS[r.country]; if (!c) continue;
      const hit = c.list.find(([n]) => n === r.eventName); if (!hit) continue;
      const tp = toTaipei(shiftDate(listed, offset), r.gmt);
      if (tp.date < from || tp.date > to) continue;
      const key = `${r.country}|${r.eventName}|${tp.sortKey}`;
      const prev = clean(r.previous), cons = clean(r.consensus), act = clean(r.actual);
      const ex = byKey.get(key);
      // 同一事件常有 MoM/YoY 多列,數值合併顯示
      if (ex) {
        if (prev && !ex.previous.includes(prev)) ex.previous.push(prev);
        if (cons && !ex.consensus.includes(cons)) ex.consensus.push(cons);
        if (act && !ex.actual.includes(act)) ex.actual.push(act);
        continue;
      }
      byKey.set(key, {
        date: tp.date, time: tp.time, sortKey: tp.sortKey,
        country: c.zh, flag: c.flag, name: hit[1], raw: r.eventName, importance: hit[2],
        previous: prev ? [prev] : [], consensus: cons ? [cons] : [], actual: act ? [act] : [],
      });
    }
  }
  const events = [...byKey.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(e => ({ ...e, previous: e.previous.join(' / '), consensus: e.consensus.join(' / '), actual: e.actual.join(' / ') }));

  // 大型企業財報(Nasdaq 財報日曆的日期為美東日期,無偏移)
  const earnings = [];
  await pool(Array.from({ length: CAL_DAYS + 1 }, (_, i) => shiftDate(from, i - 1)), 3, async d => {
    try {
      const rows = (await nasdaqJson(`/api/calendar/earnings?date=${d}`))?.rows || [];
      const seen = new Set();
      for (const r of rows) {
        const cap = parseFloat(String(r.marketCap || '').replace(/[$,]/g, '')) || 0;
        if (cap < EARNINGS_MIN_CAP && !EARNINGS_ALWAYS.has(r.symbol)) continue;
        const nm = String(r.name || '').replace(/\s+(Inc\.?|Corporation|Corp\.?|Company|Ltd\.?|plc|Co\.)$/i, '');
        if (seen.has(nm)) continue; seen.add(nm); // GOOG / GOOGL 只列一次
        const when = r.time === 'time-pre-market' ? '盤前' : r.time === 'time-after-hours' ? '盤後' : '';
        // 美股盤後公布,台北時間已是隔天清晨
        const tpeDate = when === '盤後' ? shiftDate(d, 1) : d;
        if (tpeDate < from || tpeDate > to) continue;
        earnings.push({ date: tpeDate, usDate: d, symbol: r.symbol, name: nm, when,
          capB: Math.round(cap / 1e9), epsForecast: clean(r.epsForecast), lastYearEPS: clean(r.lastYearEPS) });
      }
    } catch (e) { warnings.push(`財報日曆 ${d} 抓取失敗:${e.message}`); }
  });
  earnings.sort((a, b) => a.date.localeCompare(b.date) || b.capB - a.capB);

  // FOMC:以聯準會官網為準,並用來驗證 Nasdaq 日期校準是否正確
  let fomc = null;
  try {
    const meetings = await fomcMeetings();
    const next = meetings.find(m => m.end >= shiftDate(from, -1));
    if (next) {
      const days = Math.round((Date.parse(next.end) - Date.parse(from)) / 864e5);
      fomc = { ...next, daysToDecision: days, decisionTpe: tpeFromNy(next.end, 14, 0) };
      const dec = events.find(e => e.raw === 'Fed Interest Rate Decision');
      if (dec) {
        fomc.consensus = dec.consensus; fomc.previous = dec.previous;
        // 決議在美東下午 2 點,台北已是隔天凌晨
        if (dec.date !== shiftDate(next.end, 1)) warnings.push(`日曆日期校準可能有誤:Nasdaq 利率決議為台北 ${dec.date},聯準會官網會議結束日為 ${next.end}`);
      }
    }
  } catch (e) { warnings.push(`FOMC 日程抓取失敗:${e.message}`); }

  return { from, to, tz: 'Asia/Taipei', nasdaqOffset: offset, calibrated, fomc, events, earnings, warnings };
}

/* ---------- 類股熱力圖 ----------
   期間:d1 單日、w1 近一週(對比 7 個日曆天前)、m1 近一月(對比 28 個日曆天前),遇假日往前找最近交易日 */
async function twseIndices(ymd) {
  const j = JSON.parse(await getText(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd.replace(/-/g, '')}&type=IND&response=json`));
  const rows = (j.tables || []).flatMap(t => t.data || []);
  const num = s => parseFloat(String(s).replace(/<[^>]+>|,/g, ''));
  return new Map(rows.map(r => [String(r[0]).trim(), { close: num(r[1]), pct: num(r[4]) }]).filter(([, v]) => isFinite(v.close)));
}
/* 從 ymd 往前找有資料的交易日;證交所有流量限制,每次請求間隔 1 秒 */
async function twseOnOrBefore(ymd, maxBack = 6) {
  for (let i = 0; i <= maxBack; i++) {
    const d = shiftDate(ymd, -i);
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const m = await twseIndices(d);
    await new Promise(r => setTimeout(r, 1000));
    if (m.size) return { date: d, map: m };
  }
  return null;
}

async function fetchHeatmap(failures) {
  const out = { periods: { d1: '1 日', w1: '近一週', m1: '近一月' } };
  // 美股類股 ETF
  try {
    const items = (await pool(US_SECTORS, 6, async ([sym, name]) => {
      try {
        const { pts, live } = await yahooChart(sym);
        const last = pts[pts.length - 1], prev = pts[pts.length - 2];
        const before = days => [...pts].reverse().find(p => p.d <= shiftDate(last.d, -days));
        const chg = b => b ? round((last.c / b.c - 1) * 100, 2) : null;
        return { symbol: sym, name, value: round(last.c, 2), asOf: last.d, live, d1: chg(prev), w1: chg(before(7)), m1: chg(before(28)) };
      } catch (e) { failures.push(`類股 ${sym}:${e.message}`); return null; }
    })).filter(Boolean);
    try {
      const cq = await cnbcQuotes(items.map(x => x.symbol));
      for (const x of items) {
        const it = { value: x.value, change: x.d1, unit: '%', asOf: x.asOf, live: x.live };
        x.check2 = crossCheck2(it, cq.get(x.symbol), x.symbol, 'sectors');
      }
    } catch (e) { failures.push(`類股 CNBC 核對:${e.message}`); }
    out.us = { asOf: items[0]?.asOf, source: 'Yahoo Finance(CNBC 核對)', items };
  } catch (e) { failures.push(`美股類股:${e.message}`); }
  // 台股官方類股指數
  try {
    const now = await twseOnOrBefore(tpeToday());
    if (!now) throw new Error('近一週查無證交所類股資料');
    const wk = await twseOnOrBefore(shiftDate(now.date, -7));
    const mo = await twseOnOrBefore(shiftDate(now.date, -28));
    const chg = (base, name, cur) => { const b = base?.map.get(name); return b ? round((cur.close / b.close - 1) * 100, 2) : null; };
    const items = TW_SECTORS.map(n => {
      const key = n + '類指數', cur = now.map.get(key);
      if (!cur) return null;
      return { name: n, value: cur.close, d1: cur.pct, w1: chg(wk, key, cur), m1: chg(mo, key, cur) };
    }).filter(Boolean);
    const miss = TW_SECTORS.filter(n => !now.map.has(n + '類指數'));
    if (miss.length) failures.push(`證交所類股找不到:${miss.join('、')}`);
    out.tw = { asOf: now.date, weekBase: wk?.date, monthBase: mo?.date, source: '臺灣證券交易所', items };
  } catch (e) { failures.push(`台股類股:${e.message}`); }
  return out;
}

/* ---------- 風險溫度計 ----------
   0~100 分,越高越偏 Risk-On。每個面向先換算成 0~100 分,再依權重加總。
   「相對自身歷史」的面向用近一年(約 252 個交易日)的百分位數,避免平靜期與動盪期用同一把絕對標準。
   以美股交易日為主日曆,其他序列取「當日或之前最近一筆」。 */
// >= on 進入 Risk-On、跌破 onExit 才退出;<= off 進入 Risk-Off、站上 offExit 才退出(緩衝區避免燈號天天跳)
const RISK_ZONES = { on: 62, onExit: 55, off: 40, offExit: 46 };
// 權重依 2026-10 回測調整:殖利率曲線變化慢且長期偏高,權重降低以免整體偏 Risk-On
const RISK_COMPONENTS = [
  { key: 'vix',      name: '波動恐慌', weight: 25 },
  { key: 'credit',   name: '信用壓力', weight: 25 },
  { key: 'momentum', name: '股市動能', weight: 25 },
  { key: 'haven',    name: '避險需求', weight: 15 },
  { key: 'curve',    name: '殖利率曲線', weight: 10 },
];
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function pctRank(arr, v) {
  if (!arr.length) return 50;
  let below = 0, eq = 0;
  for (const x of arr) { if (x < v) below++; else if (x === v) eq++; }
  return (below + eq / 2) / arr.length * 100;
}

async function riskInputs() {
  const ySyms = { spx: '^GSPC', sox: '^SOX', gold: 'GC=F', dxy: 'DX-Y.NYB' };
  const out = {};
  await pool(Object.entries(ySyms), 5, async ([k, s]) => { out[k] = (await yahooChart(s, '2y')).pts.map(p => ({ d: p.d, v: p.c })); });
  // VIX 以 CBOE 官方收盤為主,失敗才用 Yahoo
  try { out.vix = (await cboeVix()).map(p => ({ d: p.d, v: p.c })); }
  catch { out.vix = (await yahooChart('^VIX', '2y')).pts.map(p => ({ d: p.d, v: p.c })); }
  await pool([['hy', 'BAMLH0A0HYM2'], ['curve', 'T10Y2Y']], 2, async ([k, id]) => { out[k] = await fredSeries(id); });
  return out;
}

/* 計算某一天(主日曆第 i 天)的分數;只用該日以前的資料,所以也能拿來回測 */
function riskAt(inp, i) {
  const dates = inp.spx.map(p => p.d), d = dates[i];
  const upTo = (key, n) => { // key 序列在 d 之前(含)最後 n 筆
    const s = inp[key]; let j = s.length - 1;
    while (j >= 0 && s[j].d > d) j--;
    return j < 0 ? [] : s.slice(Math.max(0, j - n + 1), j + 1).map(p => p.v);
  };
  const last = a => a[a.length - 1];
  const ret = (a, n) => a.length > n ? (last(a) / a[a.length - 1 - n] - 1) * 100 : 0;
  const maDev = (a, n) => { const w = a.slice(-n); return (last(a) / (w.reduce((x, y) => x + y, 0) / w.length) - 1) * 100; };

  const vixH = upTo('vix', 252), hyH = upTo('hy', 252), cv = last(upTo('curve', 1));
  const spx = upTo('spx', 60), sox = upTo('sox', 60), gold = upTo('gold', 25), dxy = upTo('dxy', 25);
  if (vixH.length < 120 || hyH.length < 120 || spx.length < 50 || cv == null) return null;

  const vixPct = pctRank(vixH, last(vixH)), hyPct = pctRank(hyH, last(hyH));
  const spxDev = maDev(spx, 50), soxDev = maDev(sox, 50);
  const rel20 = ret(spx, 20) - ret(gold, 20), dxy20 = ret(dxy, 20);
  // VIX 與信用利差:相對近一年(看方向)與絕對水準(看高低)各半,避免平靜年的小波動被放大成極端值
  // 絕對水準以「長期正常值 = 50 分」為中心:VIX 長期中位約 18,高收益債利差近年常態約 3.5%
  const vixAbs = clamp((26 - last(vixH)) / (26 - 10) * 100);   // VIX 10 → 100 分,18 → 50 分,26 → 0 分
  const hyAbs = clamp((5 - last(hyH)) / (5 - 2) * 100);         // 利差 2% → 100 分,3.5% → 50 分,5% → 0 分
  const s = {
    vix: { score: ((100 - vixPct) + vixAbs) / 2, value: round(last(vixH), 2), detail: `VIX ${round(last(vixH), 2)},近一年第 ${Math.round(vixPct)} 百分位` },
    credit: { score: ((100 - hyPct) + hyAbs) / 2, value: round(last(hyH), 2), detail: `高收益債利差 ${round(last(hyH), 2)}%,近一年第 ${Math.round(hyPct)} 百分位` },
    momentum: {
      score: (clamp(50 + spxDev * 10) + clamp(50 + soxDev * 5)) / 2,
      detail: `標普500 距 50 日均線 ${spxDev > 0 ? '+' : ''}${round(spxDev, 1)}%;費城半導體 ${soxDev > 0 ? '+' : ''}${round(soxDev, 1)}%`,
    },
    haven: {
      score: (clamp(50 + rel20 * 5) + clamp(50 - dxy20 * 20)) / 2,
      detail: `近 20 日標普500 減黃金報酬 ${rel20 > 0 ? '+' : ''}${round(rel20, 1)} 個百分點;美元指數 ${dxy20 > 0 ? '+' : ''}${round(dxy20, 1)}%`,
    },
    curve: { score: clamp((cv + 0.5) / 1.5 * 100), value: cv, detail: `10年-2年期利差 ${cv}%${cv < 0 ? '(倒掛)' : ''}` },
  };
  const total = RISK_COMPONENTS.reduce((a, c) => a + s[c.key].score * c.weight, 0) / 100;
  return { date: d, score: round(total, 1), parts: s };
}

/* 有緩衝區的分區:進入與退出門檻不同,所以需要前一天的區間 */
function zoneOf(score, prev = 'neutral') {
  if (prev === 'risk-on' && score >= RISK_ZONES.onExit) return 'risk-on';
  if (prev === 'risk-off' && score <= RISK_ZONES.offExit) return 'risk-off';
  return score >= RISK_ZONES.on ? 'risk-on' : score <= RISK_ZONES.off ? 'risk-off' : 'neutral';
}
/* 依序計算每天的分數與區間(回測與今日共用) */
function riskSeries(inp, days) {
  const rows = []; let z = 'neutral';
  for (let i = Math.max(0, inp.spx.length - days); i < inp.spx.length; i++) {
    const r = riskAt(inp, i); if (!r) continue;
    z = zoneOf(r.score, z); rows.push({ ...r, zone: z });
  }
  return rows;
}

async function riskGauge() {
  const inp = await riskInputs();
  const rows = riskSeries(inp, 252); // 從一年前開始跑,區間的緩衝狀態才會穩定
  const now = rows[rows.length - 1];
  if (!now) throw new Error('資料不足,無法計算');
  const history = rows.slice(-60).map(r => ({ d: r.date, s: r.score, z: r.zone }));
  return {
    score: now.score, zone: now.zone, asOf: now.date, zones: RISK_ZONES,
    components: RISK_COMPONENTS.map(c => ({ key: c.key, name: c.name, weight: c.weight,
      score: round(now.parts[c.key].score, 1), detail: now.parts[c.key].detail })),
    history,
  };
}

/* 回測:node fetch-quotes.mjs --risk-backtest,印出近一年分數分布,調整權重與門檻用 */
async function riskBacktest() {
  const inp = await riskInputs();
  const rows = riskSeries(inp, inp.spx.length);
  const yr = rows.slice(-252);
  const cnt = z => yr.filter(r => r.zone === z).length;
  console.log(`回測 ${yr[0].date} ~ ${yr[yr.length - 1].date},共 ${yr.length} 個交易日`);
  console.log(`  Risk-On ${cnt('risk-on')} 天 | 中性 ${cnt('neutral')} 天 | Risk-Off ${cnt('risk-off')} 天`);
  const sc = yr.map(r => r.score).sort((a, b) => a - b);
  console.log(`  分數 最低 ${sc[0]} / 25% ${sc[Math.floor(sc.length * .25)]} / 中位 ${sc[Math.floor(sc.length / 2)]} / 75% ${sc[Math.floor(sc.length * .75)]} / 最高 ${sc[sc.length - 1]}`);
  let flips = 0; for (let i = 1; i < yr.length; i++) if (yr[i].zone !== yr[i - 1].zone) flips++;
  console.log(`  區間切換 ${flips} 次`);
  const spx = new Map(inp.spx.map(p => [p.d, p.v]));
  console.log('  每月月底:');
  for (let i = 0; i < yr.length; i++) {
    const r = yr[i], nx = yr[i + 1];
    if (nx && nx.date.slice(0, 7) === r.date.slice(0, 7)) continue;
    console.log(`    ${r.date} 分數 ${String(r.score).padStart(5)} ${r.zone.padEnd(8)} 標普 ${round(spx.get(r.date), 0)} | ` +
      RISK_COMPONENTS.map(c => `${c.name}${Math.round(r.parts[c.key].score)}`).join(' '));
  }
  const tail = rows.slice(-8);
  console.log('  最近 8 天:');
  for (const r of tail) console.log(`    ${r.date} ${String(r.score).padStart(5)} ${r.zone} | ` + RISK_COMPONENTS.map(c => `${c.name}${Math.round(r.parts[c.key].score)}`).join(' '));
}

/* ---------- 主流程 ---------- */
async function fetchAll() {
  const failures = [], warnings = [];
  const market = {};
  // 上一次的 market.json:用來比對期貨合約是否換月
  let prevItems = [];
  try { prevItems = Object.values(JSON.parse(readTextClean(MARKET_PATH)).market || {}).flat(); } catch {}
  const flat = Object.entries(MARKETS).flatMap(([g, arr]) => arr.map(cfg => ({ g, cfg })));
  const items = await pool(flat, 6, async ({ g, cfg }) => {
    try {
      const chart = await primaryChart(cfg.official, cfg.symbol, cfg.name, warnings);
      const item = toMarketItem(cfg, chart, g);
      markRollover(item, chart.contract, prevItems.find(p => p.symbol === cfg.symbol));
      if (cfg.fred) {
        try { item.check = crossCheck(cfg, item.unit, chart.pts, await fredSeries(cfg.fred.id)); }
        catch (e) { item.check = { src: 'FRED', id: cfg.fred.id, status: 'error', error: e.message }; }
      }
      return { g, item };
    }
    catch (e) { failures.push(`${cfg.name}(${cfg.symbol}):${e.message}`); return { g, item: null }; }
  });
  for (const g of Object.keys(MARKETS)) market[g] = items.filter(x => x.g === g && x.item).map(x => x.item);

  // 第二來源 CNBC:當天比對數值與漲跌幅
  const cfgOf = new Map(flat.map(({ g, cfg }) => [cfg.symbol, { g, cfg }]));
  let cq = new Map();
  try { cq = await cnbcQuotes(flat.map(x => x.cfg.cnbc).filter(Boolean)); }
  catch (e) { failures.push(`CNBC 第二來源:${e.message}`); }
  for (const x of Object.values(market).flat()) {
    const { g, cfg } = cfgOf.get(x.symbol);
    if (!cfg.cnbc || !cq.size) continue;
    x.check2 = crossCheck2(x, cq.get(cfg.cnbc), cfg.cnbc, g);
    // 期貨與 CNBC 近月價差過大:幾乎都是其中一邊已換到下個月合約,漲跌不可信
    if (x.symbol.endsWith('=F') && x.check2.status === 'mismatch' && x.check2.valueDiff > 1 && !x.rollover) {
      x.rollover = true;
      x.rolloverReason = `與 CNBC 近月報價差 ${x.check2.valueDiff}%(CNBC ${x.check2.cnbc}),疑似 Yahoo 已換到下個月合約`;
      x.dir = 'flat';
    }
    if (x.check2.changeAdopted) {
      const alert = cfg.alert ?? ALERT_DEFAULT[g];
      x.bigMove = alert != null && Math.abs(x.change) >= alert;
    }
  }

  for (const x of Object.values(market).flat()) {
    x.verified = x.check2?.status === 'ok' || (x.check?.status === 'ok' && x.check.latest);
    if (x.rollover) { x.bigMove = false; warnings.push(`${x.name} 期貨換月(${x.rolloverReason}),今日漲跌不可信,只能引用價格`); continue; }
    if (x.check?.status === 'mismatch')
      warnings.push(`${x.name} 與 FRED 官方數據不符:${x.check.worstDate} Yahoo ${x.check.yahoo} vs FRED ${x.check.fred}(差 ${x.check.diff}${x.check.diffUnit},容許 ${x.check.tol})`);
    if (x.check2?.status === 'mismatch')
      warnings.push(`${x.name} 與 CNBC 不符:Yahoo ${x.value}(${x.change}${x.unit}) vs CNBC ${x.check2.cnbc}(${x.check2.cnbcChange ?? '-'}%),不要引用此項`);
    if (x.bigMove && !x.verified)
      warnings.push(`${x.name} 單日 ${x.change > 0 ? '+' : ''}${x.change}${x.unit} 屬大幅波動,且沒有第二來源可核對,引用時請註明「待確認」`);
  }

  const macro = (await pool(MACRO, 4, async cfg => {
    try { return toMacroItem(cfg, await fredSeries(cfg.id)); }
    catch (e) { failures.push(`${cfg.name}(FRED ${cfg.id}):${e.message}`); return null; }
  })).filter(Boolean);

  let calendar = null;
  try {
    calendar = await fetchCalendar();
    warnings.push(...calendar.warnings);
  } catch (e) { failures.push(`經濟日曆:${e.message}`); }

  let risk = null;
  try { risk = await riskGauge(); }
  catch (e) { failures.push(`風險溫度計:${e.message}`); }

  const heatmap = await fetchHeatmap(failures);
  for (const x of heatmap.us?.items || [])
    if (x.check2?.status === 'mismatch') warnings.push(`類股 ${x.symbol} 與 CNBC 不符:Yahoo ${x.value}(${x.d1}%) vs CNBC ${x.check2.cnbc}(${x.check2.cnbcChange}%)`);
  return { fetchedAt: new Date().toISOString(), market, macro, calendar, risk, heatmap, failures, warnings };
}

function checkLabel(x) {
  const c = x.check, c2 = x.check2, out = [];
  if (c2?.status === 'ok') out.push('✓CNBC');
  if (c2?.status === 'mismatch') out.push('✗CNBC不符');
  if (c?.status === 'ok') out.push(c.latest ? '✓FRED' : `✓FRED至${c.through.slice(5)}`);
  if (c?.status === 'mismatch') out.push('✗FRED不符');
  if (x.bigMove && !x.verified) out.push('⚠️大波動未能核對');
  return out.length ? ' ' + out.join(' ') : '';
}
const ZONE_ZH = { 'risk-on': '風險偏好 Risk-On', 'risk-off': '避險 Risk-Off', neutral: '中性' };
function summary(data) {
  const lines = [`抓取時間 ${data.fetchedAt}`];
  const r = data.risk;
  if (r) {
    const prev = r.history[r.history.length - 2];
    lines.push(`【風險溫度計】${r.score} 分 → ${ZONE_ZH[r.zone]}(${r.asOf} 美股收盤;前一日 ${prev ? prev.s + ' 分' : '—'})`);
    for (const c of r.components) lines.push(`  ${c.name}(權重 ${c.weight}%)${c.score} 分:${c.detail}`);
  }
  for (const [g, arr] of Object.entries(data.market)) {
    lines.push(`【${g}】`);
    for (const x of arr) lines.push(`  ${x.name} ${x.value} ${x.rollover ? '(換月,漲跌不可信)' : (x.change > 0 ? '+' : '') + x.change + x.unit}`
      + ` (${x.asOf}${x.live ? ' 盤中' : ''}${x.source && x.source !== 'Yahoo' ? ',' + x.source + '官方' : ''})${checkLabel(x)}`);
  }
  lines.push('【美國總經】');
  for (const x of data.macro) lines.push(`  ${x.name} ${x.value}${x.unit} (前值 ${x.prev}${x.unit}, ${x.period})`);
  const hm = data.heatmap;
  const rank = (arr, k) => [...arr].filter(x => x[k] != null).sort((a, b) => b[k] - a[k]);
  const fmt = x => `${x.name}${x.d1 > 0 ? '+' : ''}${x.d1}%`;
  if (hm?.us?.items?.length) { const r = rank(hm.us.items, 'd1'); lines.push(`【美股類股 ${hm.us.asOf}】最強 ${r.slice(0, 3).map(fmt).join('、')};最弱 ${r.slice(-3).reverse().map(fmt).join('、')}`); }
  if (hm?.tw?.items?.length) { const r = rank(hm.tw.items, 'd1'); lines.push(`【台股類股 ${hm.tw.asOf}(證交所官方)】最強 ${r.slice(0, 3).map(fmt).join('、')};最弱 ${r.slice(-3).reverse().map(fmt).join('、')}`); }
  const cal = data.calendar;
  if (cal) {
    lines.push(`【未來一週日曆 ${cal.from} ~ ${cal.to},台北時間】`);
    if (cal.fomc) lines.push(`  下次 FOMC:${cal.fomc.start} ~ ${cal.fomc.end}(${cal.fomc.daysToDecision} 天後決議${cal.fomc.decisionTpe ? `,台北時間 ${cal.fomc.decisionTpe} 公布(美東14:00,依慣例推算,待官方確認)` : ''}${cal.fomc.sep ? ',含點陣圖' : ''}${cal.fomc.consensus ? `,市場預期 ${cal.fomc.consensus}` : ''})`);
    for (const e of cal.events.filter(e => e.importance === 'high'))
      lines.push(`  ${e.date} ${e.time} ${e.country} ${e.name}${e.consensus ? ` 預期 ${e.consensus}` : ''}${e.previous ? ` 前值 ${e.previous}` : ''}${e.actual ? ` 實際 ${e.actual}` : ''}`);
    if (cal.earnings.length) lines.push('  大型財報:' + cal.earnings.map(e => `${e.date.slice(5)} ${e.symbol}${e.when ? '(' + e.when + ')' : ''}`).join('、'));
  }
  if (data.warnings?.length) lines.push('⚠️ 數據警示:\n  - ' + data.warnings.join('\n  - '));
  if (data.failures.length) lines.push('⚠️ 抓取失敗:' + data.failures.join('; '));
  return lines.join('\n');
}

async function loadMarket() {
  if (existsSync(MARKET_PATH)) {
    const m = JSON.parse(readTextClean(MARKET_PATH));
    if (Date.now() - Date.parse(m.fetchedAt) < MARKET_MAX_AGE_MS) return m;
  }
  const m = await fetchAll();
  writeFileSync(MARKET_PATH, JSON.stringify(m, null, 2), 'utf8');
  return m;
}

/* 把程式抓的數字套進 today.json;模型寫的 note 依 name 保留 */
async function apply(patchPath) {
  const patch = JSON.parse(readTextClean(patchPath));
  const data = await loadMarket();
  patch.day ||= {};
  const old = patch.day.market || {};
  const noteOf = (g, name) => (old[g] || []).find(x => x.name === name)?.note || '';
  const market = {};
  for (const [g, arr] of Object.entries(data.market)) market[g] = arr.map(x => ({ ...x, note: noteOf(g, x.name) }));
  const dropped = Object.entries(old).flatMap(([g, arr]) =>
    (arr || []).filter(x => !(market[g] || []).some(y => y.name === x.name)).map(x => x.name));
  patch.day.market = market;
  patch.day.macro = data.macro;
  if (data.calendar) patch.day.calendar = data.calendar;
  if (data.heatmap) { patch.stocks ||= {}; patch.stocks.heatmap = data.heatmap; }
  // 情緒燈號由溫度計決定;模型原本填的 mood 保留在 moodByModel 供對照
  if (data.risk) {
    if (patch.day.mood && patch.day.mood !== data.risk.zone) patch.day.moodByModel = patch.day.mood;
    patch.day.mood = data.risk.zone;
    patch.day.risk = data.risk;
  }

  // 個股:以 symbol 抓收盤價(台股以證交所/櫃買為主),失敗則保留模型原值並標記
  const movers = patch.stocks?.movers || [];
  const mlog = [], mnotes = [];
  await pool(movers, 4, async m => {
    if (!m.symbol) return;
    try {
      const c = await primaryChart(twOfficial(m.symbol), toYahooSymbol(m.symbol), m.symbol, mnotes);
      const it = toMarketItem({ name: m.name, symbol: m.symbol }, c);
      Object.assign(m, { price: it.value, change: it.change, dir: it.dir, asOf: it.asOf, live: it.live, source: it.source, series: it.series, verified: true });
    } catch (e) {
      m.verified = false;
      mlog.push(`${m.symbol}:${e.message}`);
    }
  });
  // 個股第二來源:CNBC
  const csyms = movers.filter(m => m.verified).map(m => [m, toCnbcSymbol(m.symbol)]).filter(([, s]) => s);
  if (csyms.length) {
    try {
      const cq = await cnbcQuotes(csyms.map(([, s]) => s));
      for (const [m, s] of csyms) {
        const it = { value: m.price, change: m.change, unit: '%', asOf: m.asOf, live: m.live };
        m.check2 = crossCheck2(it, cq.get(s), s, 'stocks');
        if (m.check2.status === 'mismatch') mlog.push(`${m.symbol} 與 CNBC 不符:Yahoo ${m.price}(${m.change}%) vs CNBC ${m.check2.cnbc}(${m.check2.cnbcChange}%)`);
      }
    } catch (e) { mlog.push(`個股 CNBC 核對失敗:${e.message}`); }
  }

  patch.marketFetchedAt = data.fetchedAt;
  writeFileSync(patchPath, JSON.stringify(patch, null, 2), 'utf8');
  console.log('✅ 已將程式抓取的數字寫入 ' + patchPath);
  console.log(`   市場 ${Object.values(market).flat().length} 項(雙來源一致 ${Object.values(market).flat().filter(x => x.verified).length} 項)| 總經 ${data.macro.length} 項 | 個股 ${movers.filter(m => m.verified).length}/${movers.length} 檔已校正(CNBC 一致 ${movers.filter(m => m.check2?.status === 'ok').length} 檔)`);
  if (dropped.length) console.log('   略過模型自填、不在清單內的市場項目:' + dropped.join('、'));
  if (mnotes.length) console.log('   ℹ️ 個股來源備援:' + mnotes.join('; '));
  if (mlog.length) console.log('   ⚠️ 個股抓取失敗(保留原值):' + mlog.join('; '));
  if (data.warnings?.length) console.log('   ⚠️ 數據警示:\n     - ' + data.warnings.join('\n     - '));
  if (data.failures.length) console.log('   ⚠️ 市場/總經抓取失敗:' + data.failures.join('; '));
}

const arg = process.argv[2];
try {
  if (arg === '--risk-backtest') await riskBacktest();
  else if (arg) await apply(resolve(arg));
  else {
    const data = await fetchAll();
    writeFileSync(MARKET_PATH, JSON.stringify(data, null, 2), 'utf8');
    console.log(summary(data));
  }
} catch (e) {
  console.error('❌ 失敗:', e.message);
  process.exit(1);
}
