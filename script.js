// ===============================================================
// AURUM TERMINAL — Complete Logic (v2.1 Enhanced)
// Features: Paper Trading + History, Manual SL/TP, Keyboard Shortcuts,
//           Enhanced Calculator, Confirm Reset, Canvas Volume
// ===============================================================
"use strict";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "aurum_terminal_v2_state";
const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1H": 3600, "4H": 14400, "1D": 86400 };
const TD_INTERVAL = { "1m": "1min", "5m": "5min", "15m": "15min", "1H": "1h", "4H": "4h", "1D": "1day" };
const FH_INTERVAL = { "1m": "1", "5m": "5", "15m": "15", "1H": "60", "4H": "240", "1D": "D" };

const ASSETS = {
  "XAU/USD": { name: "Gold Spot / US Dollar", seed: 3300, minuteVol: 0.00037, tickVol: 0.000023, decimals: 2 },
  "AAPL":    { name: "Apple Inc.",           seed: 220,  minuteVol: 0.00065, tickVol: 0.000045, decimals: 2 },
  "NVDA":    { name: "NVIDIA Corporation",   seed: 145,  minuteVol: 0.00110, tickVol: 0.000070, decimals: 2 },
  "TSLA":    { name: "Tesla, Inc.",          seed: 280,  minuteVol: 0.00145, tickVol: 0.000088, decimals: 2 },
  "SPY":     { name: "SPDR S&P 500 ETF",     seed: 590,  minuteVol: 0.00043, tickVol: 0.000029, decimals: 2 }
};

const COLORS = {
  ema9: "#fbbf24", ema21: "#8b9dff", ema50: "#21c9e0", ema200: "#de78f7",
  bb: "#8f88ba", bull: "#10B981", bear: "#EF4444"
};

const state = {
  apiKey: "",
  apiProvider: "twelvedata",
  asset: "XAU/USD",
  tf: "1m",
  mode: "SIM",
  bars: [],
  ind: null,
  structure: null,
  lastPlan: null,
  lastSignalLabel: "NEUTRAL / WAIT",
  soundEnabled: false,
  calcBalance: 10000,
  calcRiskPct: 1.0,
  recommendedUnits: 1,
  paper: {
    balance: 10000,
    positions: [],
    history: [],          // closed trades log
    nextId: 1
  },
  chart: null, candle: null, volume: null, lines: {}, priceLines: [],
  ws: null, heartbeat: null, simTimer: null, pollTimer: null, retryTimer: null, abort: null,
  generation: 0, tdDayVolume: null, lastWsAt: 0, useCanvas: false,
  enabled: { ema9: true, ema21: true, ema50: true, ema200: false, bb: true, sr: true, fvg: true, volume: true }
};

let resizeObserver = null;
let audioCtx = null;
const maxBars = 450;
const MAX_HISTORY = 80;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const valid = x => Number.isFinite(x);
const last = a => (a && a.length ? a[a.length - 1] : null);
const fmt = (x, d = 2) => valid(x) ? Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";
const fmtSigned = x => valid(x) ? (x >= 0 ? "+" : "") + fmt(x, 2) : "—";
const fmtMacd = x => valid(x) ? Number(x).toFixed(Math.abs(x) < 1 ? 4 : 2) : "—";
const rand = (min = 0, max = 1) => min + (max - min) * Math.random();
const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, Math.random()))) * Math.cos(2 * Math.PI * Math.random());
const bucket = (seconds, tf) => Math.floor(seconds / TF_SECONDS[tf]) * TF_SECONDS[tf];
const isDemoKey = () => !state.apiKey || state.apiKey === "YOUR_API_KEY" || state.apiKey.trim() === "";
const fmtTime = ts => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toISOString().slice(11, 19) + " UTC";
};

// -------------------- Persistence & Audio --------------------
function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.apiKey === "string") state.apiKey = saved.apiKey;
    if (saved.apiProvider === "twelvedata" || saved.apiProvider === "finnhub") state.apiProvider = saved.apiProvider;
    if (saved.asset && ASSETS[saved.asset]) state.asset = saved.asset;
    if (saved.tf && TF_SECONDS[saved.tf]) state.tf = saved.tf;
    if (typeof saved.soundEnabled === "boolean") state.soundEnabled = saved.soundEnabled;
    if (valid(saved.calcBalance) && saved.calcBalance > 0) state.calcBalance = saved.calcBalance;
    if (valid(saved.calcRiskPct) && saved.calcRiskPct > 0) state.calcRiskPct = saved.calcRiskPct;
    if (saved.enabled && typeof saved.enabled === "object") {
      state.enabled = { ...state.enabled, ...saved.enabled };
    }
    if (saved.paper && valid(saved.paper.balance)) {
      state.paper.balance = saved.paper.balance;
      state.paper.positions = Array.isArray(saved.paper.positions) ? saved.paper.positions : [];
      state.paper.history = Array.isArray(saved.paper.history) ? saved.paper.history : [];
      state.paper.nextId = saved.paper.nextId || 1;
    }
  } catch (e) {
    console.warn("Failed to load state from localStorage:", e);
  }
}

function savePersistedState() {
  try {
    const payload = {
      apiKey: state.apiKey,
      apiProvider: state.apiProvider,
      asset: state.asset,
      tf: state.tf,
      soundEnabled: state.soundEnabled,
      calcBalance: state.calcBalance,
      calcRiskPct: state.calcRiskPct,
      enabled: state.enabled,
      paper: state.paper
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Failed to save state:", e);
  }
}

function syncControlsFromState() {
  $("asset").value = state.asset;
  document.querySelectorAll(".tf").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tf === state.tf);
  });
  document.querySelectorAll("#toggles input[data-line]").forEach(input => {
    const key = input.dataset.line;
    if (key in state.enabled) input.checked = !!state.enabled[key];
  });
  $("calcBalance").value = state.calcBalance;
  $("calcRiskPct").value = state.calcRiskPct;
  $("soundToggle").textContent = state.soundEnabled ? "🔔 Sound: On" : "🔕 Sound: Off";
}

function notifyToast(message) {
  const container = $("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function playBeep(type = "signal") {
  if (!state.soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (type === "bull") {
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.setValueAtTime(880, now + 0.09);
    } else if (type === "bear") {
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(349.23, now + 0.09);
    } else {
      osc.frequency.setValueAtTime(660, now);
    }
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch (e) {}
}

// -------------------- Pure indicator mathematics --------------------
function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function emaNullable(values, period) {
  const out = Array(values.length).fill(null);
  const first = values.findIndex(valid);
  if (first < 0 || values.length - first < period) return out;
  let sum = 0;
  for (let i = first; i < first + period; i++) sum += values[i];
  let prev = sum / period;
  out[first + period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = first + period; i < values.length; i++) {
    if (!valid(values[i])) continue;
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gains += Math.max(0, d);
    losses += Math.max(0, -d);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  const value = () => avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

function macdSeries(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const macd = closes.map((_, i) => valid(ef[i]) && valid(es[i]) ? ef[i] - es[i] : null);
  const signal = emaNullable(macd, signalPeriod);
  const histogram = macd.map((x, i) => valid(x) && valid(signal[i]) ? x - signal[i] : null);
  return { macd, signal, histogram };
}

function atrSeries(bars, period = 14) {
  const out = Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const b = bars[i], p = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - p), Math.abs(b.low - p));
  }
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1].close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p), Math.abs(b.low - p));
    prev = (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

function bollingerSeries(closes, period = 20, deviations = 2) {
  const mid = Array(closes.length).fill(null);
  const upper = [...mid];
  const lower = [...mid];
  let sum = 0, sumSq = 0;
  for (let i = 0; i < closes.length; i++) {
    const v = closes[i];
    sum += v;
    sumSq += v * v;
    if (i >= period) {
      sum -= closes[i - period];
      sumSq -= closes[i - period] ** 2;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const variance = Math.max(0, sumSq / period - mean * mean);
      mid[i] = mean;
      upper[i] = mean + deviations * Math.sqrt(variance);
      lower[i] = mean - deviations * Math.sqrt(variance);
    }
  }
  return { mid, upper, lower };
}

function indicators(bars) {
  const closes = bars.map(b => b.close);
  return {
    ema9: emaSeries(closes, 9),
    ema21: emaSeries(closes, 21),
    ema50: emaSeries(closes, 50),
    ema200: emaSeries(closes, 200),
    rsi: rsiSeries(closes),
    macd: macdSeries(closes),
    atr: atrSeries(bars),
    bb: bollingerSeries(closes)
  };
}

function detectStructure(bars, atr) {
  const pivotsHigh = [], pivotsLow = [], gapList = [];
  const n = bars.length;
  const threshold = Math.max((atr || last(bars).close * 0.001) * 0.15, 1e-8);

  for (let i = Math.max(3, n - 175); i < n - 3; i++) {
    if (bars[i].high > Math.max(bars[i - 1].high, bars[i - 2].high, bars[i - 3].high) &&
        bars[i].high > Math.max(bars[i + 1].high, bars[i + 2].high, bars[i + 3].high)) {
      pivotsHigh.push(bars[i].high);
    }
    if (bars[i].low < Math.min(bars[i - 1].low, bars[i - 2].low, bars[i - 3].low) &&
        bars[i].low < Math.min(bars[i + 1].low, bars[i + 2].low, bars[i + 3].low)) {
      pivotsLow.push(bars[i].low);
    }
  }

  for (let i = Math.max(2, n - 105); i < n; i++) {
    const a = bars[i - 2], c = bars[i];
    let type = null, low = 0, high = 0;
    if (c.low - a.high > threshold) { type = "bull"; low = a.high; high = c.low; }
    else if (a.low - c.high > threshold) { type = "bear"; low = c.high; high = a.low; }
    if (!type) continue;
    let filled = false;
    for (let j = i + 1; j < n; j++) {
      if ((type === "bull" && bars[j].low <= low) || (type === "bear" && bars[j].high >= high)) {
        filled = true;
        break;
      }
    }
    if (!filled) gapList.push({ type, low, high, startTime: a.time, index: i });
  }

  const price = last(bars).close;
  const supports = pivotsLow.filter(v => v < price).sort((a, b) => b - a);
  const resistances = pivotsHigh.filter(v => v > price).sort((a, b) => a - b);
  const fallback = bars.slice(-85);
  const support = supports[0] ?? Math.min(...fallback.map(b => b.low));
  const resistance = resistances[0] ?? Math.max(...fallback.map(b => b.high));

  return {
    support,
    resistance,
    latestSwingHigh: last(pivotsHigh),
    latestSwingLow: last(pivotsLow),
    gaps: gapList.slice(-5)
  };
}

function analyze(bars, ind, structure) {
  const i = bars.length - 1;
  const c = bars[i].close;
  const atr = ind.atr[i];
  const e9 = ind.ema9[i], e21 = ind.ema21[i], e50 = ind.ema50[i], e200 = ind.ema200[i];
  const r = ind.rsi[i], m = ind.macd.macd[i], s = ind.macd.signal[i], h = ind.macd.histogram[i];
  const up = ind.bb.upper[i], down = ind.bb.lower[i], mid = ind.bb.mid[i];

  let trend = 0, momentum = 0, vol = 0, structureScore = 0;

  if ([e9, e21, e50, e200].every(valid)) {
    if (c > e9 && e9 > e21 && e21 > e50 && e50 > e200) trend = 1;
    else if (c < e9 && e9 < e21 && e21 < e50 && e50 < e200) trend = -1;
    else if (e9 > e21 && c > e50) trend = 0.55;
    else if (e9 < e21 && c < e50) trend = -0.55;
  }

  if ([r, m, s, h].every(valid)) {
    const rScore = r > 55 ? 1 : r < 45 ? -1 : 0;
    const macdScore = m > s ? 1 : m < s ? -1 : 0;
    const histScore = h > 0 ? 1 : h < 0 ? -1 : 0;
    momentum = (rScore + macdScore + histScore) / 3;
    if ((r > 75 && momentum > 0) || (r < 25 && momentum < 0)) momentum *= 0.65;
  }

  if ([up, down, mid].every(valid)) {
    if (c > up) vol = 1;
    else if (c < down) vol = -1;
    else if (c > mid) vol = 0.4;
    else if (c < mid) vol = -0.4;
  }

  const mostRecent = last(structure.gaps);
  if (mostRecent) structureScore = mostRecent.type === "bull" ? 0.5 : -0.5;
  if (valid(structure.latestSwingHigh) && c > structure.latestSwingHigh) structureScore = 1;
  else if (valid(structure.latestSwingLow) && c < structure.latestSwingLow) structureScore = -1;
  else if (valid(atr) && atr > 0) {
    if (c - structure.support < atr * 0.45) structureScore = Math.max(structureScore, 0.35);
    if (structure.resistance - c < atr * 0.45) structureScore = Math.min(structureScore, -0.35);
  }

  const score = trend * 0.35 + momentum * 0.30 + vol * 0.15 + structureScore * 0.20;
  const confidence = clamp(Math.round(Math.abs(score) * 100), 0, 100);
  const side = score >= 0.26 ? 1 : score <= -0.26 ? -1 : 0;
  const strong = Math.abs(score) >= 0.67;
  const label = side === 0
    ? "NEUTRAL / WAIT"
    : side > 0
      ? (strong ? "STRONG LONG" : "LONG")
      : (strong ? "STRONG SHORT" : "SHORT");
  const risk = valid(atr) && atr > 0 ? 1.5 * atr : null;

  return {
    trend, momentum, vol, structureScore, score, confidence, side, label, risk,
    entry: c,
    sl: side && risk ? c - side * risk : null,
    tp1: side && risk ? c + side * risk * 2 : null,
    tp2: side && risk ? c + side * risk * 3 : null
  };
}

function statusTag(v) {
  const cls = v > 0.18 ? "bull" : v < -0.18 ? "bear" : "neutral";
  const word = cls === "bull" ? "Bullish" : cls === "bear" ? "Bearish" : "Neutral";
  return `<span class="tag ${cls}">${word}</span>`;
}

function setStatus(label, kind = "sim") {
  $("connectionText").textContent = label;
  $("connection").className = "status " + (kind === "live" ? "live" : kind === "error" ? "error" : "");
}

// -------------------- Position Size Calculator (Enhanced) --------------------
function updatePositionCalculator(plan) {
  const balance = Math.max(0, Number($("calcBalance").value) || 0);
  const riskPct = clamp(Number($("calcRiskPct").value) || 0, 0.01, 100);
  state.calcBalance = balance;
  state.calcRiskPct = riskPct;

  const riskUsd = balance * (riskPct / 100);
  $("calcRiskUsd").textContent = "$" + fmt(riskUsd, 2);

  if (!plan || !valid(plan.risk) || plan.risk <= 0) {
    $("calcUnits").textContent = "—";
    $("calcLots").textContent = "—";
    $("calcRR").textContent = "—";
    $("calcTp1Usd").textContent = "—";
    $("calcTp2Usd").textContent = "—";
    return;
  }

  const units = riskUsd / plan.risk;
  const stdLots = units / 100;
  state.recommendedUnits = Math.max(0.01, Number(units.toFixed(2)));

  $("calcUnits").textContent = fmt(units, 2) + (state.asset === "XAU/USD" ? " oz" : " sh");
  $("calcLots").textContent = fmt(stdLots, 2) + " lots";

  // Risk:Reward and potential profit (using 1.5 ATR stop → 1:2 and 1:3)
  const riskDist = plan.risk;
  const reward1 = riskDist * 2;
  const reward2 = riskDist * 3;
  const rr = "1 : 2 / 1 : 3";
  $("calcRR").textContent = rr;

  const profit1 = units * reward1;
  const profit2 = units * reward2;
  $("calcTp1Usd").textContent = "$" + fmt(profit1, 2);
  $("calcTp2Usd").textContent = "$" + fmt(profit2, 2);
}

// -------------------- Paper Trading Engine + History --------------------
function pushHistory(entry) {
  state.paper.history.unshift(entry);
  if (state.paper.history.length > MAX_HISTORY) {
    state.paper.history.length = MAX_HISTORY;
  }
}

function checkPaperStopsAndTargets(currentPrice) {
  if (!state.paper.positions.length) return;
  const remaining = [];
  let changed = false;

  for (const pos of state.paper.positions) {
    if (pos.asset !== state.asset) {
      remaining.push(pos);
      continue;
    }
    let closedReason = null;
    let exitPrice = currentPrice;

    if (pos.side === "LONG") {
      if (valid(pos.sl) && currentPrice <= pos.sl) { closedReason = "Stop Loss"; exitPrice = pos.sl; }
      else if (valid(pos.tp) && currentPrice >= pos.tp) { closedReason = "Take Profit"; exitPrice = pos.tp; }
    } else {
      if (valid(pos.sl) && currentPrice >= pos.sl) { closedReason = "Stop Loss"; exitPrice = pos.sl; }
      else if (valid(pos.tp) && currentPrice <= pos.tp) { closedReason = "Take Profit"; exitPrice = pos.tp; }
    }

    if (closedReason) {
      const pnl = (exitPrice - pos.entry) * (pos.side === "LONG" ? 1 : -1) * pos.size;
      state.paper.balance += pnl;
      changed = true;
      pushHistory({
        id: pos.id,
        asset: pos.asset,
        side: pos.side,
        size: pos.size,
        entry: pos.entry,
        exit: exitPrice,
        pnl,
        reason: closedReason,
        closedAt: nowSeconds()
      });
      playBeep(pnl >= 0 ? "bull" : "bear");
      notifyToast(`${pos.asset} ${pos.side} closed by ${closedReason} (${fmtSigned(pnl)} USD)`);
    } else {
      remaining.push(pos);
    }
  }

  if (changed) {
    state.paper.positions = remaining;
    savePersistedState();
    renderTradeHistory();
  }
}

function openPaperPosition(side) {
  if (!state.bars.length) {
    notifyToast("No price data yet. Wait for bars to load.");
    return;
  }
  const price = last(state.bars).close;
  const size = Math.max(0.01, Number($("orderSize").value) || 1);
  const mode = $("useAutoSlTp").value;
  const atr = state.ind ? last(state.ind.atr) : null;
  const riskDist = valid(atr) && atr > 0 ? 1.5 * atr : price * 0.005;
  const dir = side === "LONG" ? 1 : -1;

  let sl = null;
  let tp = null;

  if (mode === "auto") {
    sl = price - dir * riskDist;
    tp = price + dir * riskDist * 2;
  } else if (mode === "manual") {
    const rawSl = Number($("manualSl").value);
    const rawTp = Number($("manualTp").value);
    if (valid(rawSl) && rawSl > 0) sl = rawSl;
    if (valid(rawTp) && rawTp > 0) tp = rawTp;

    // Basic sanity check
    if (side === "LONG") {
      if (sl !== null && sl >= price) {
        notifyToast("For LONG, Stop Loss must be below entry.");
        return;
      }
      if (tp !== null && tp <= price) {
        notifyToast("For LONG, Take Profit must be above entry.");
        return;
      }
    } else {
      if (sl !== null && sl <= price) {
        notifyToast("For SHORT, Stop Loss must be above entry.");
        return;
      }
      if (tp !== null && tp >= price) {
        notifyToast("For SHORT, Take Profit must be below entry.");
        return;
      }
    }
  }

  const pos = {
    id: state.paper.nextId++,
    asset: state.asset,
    side,
    size,
    entry: price,
    sl,
    tp,
    openedAt: nowSeconds()
  };

  state.paper.positions.push(pos);
  savePersistedState();
  renderPaperTrading();
  playBeep(side === "LONG" ? "bull" : "bear");
  notifyToast(`Opened ${side} ${fmt(size, 2)} ${state.asset} @ ${fmt(price, 2)}`);
}

function closePaperPosition(id) {
  const idx = state.paper.positions.findIndex(p => p.id === id);
  if (idx < 0) return;
  const pos = state.paper.positions[idx];
  const mark = pos.asset === state.asset && state.bars.length ? last(state.bars).close : pos.entry;
  const pnl = (mark - pos.entry) * (pos.side === "LONG" ? 1 : -1) * pos.size;
  state.paper.balance += pnl;

  pushHistory({
    id: pos.id,
    asset: pos.asset,
    side: pos.side,
    size: pos.size,
    entry: pos.entry,
    exit: mark,
    pnl,
    reason: "Manual Close",
    closedAt: nowSeconds()
  });

  state.paper.positions.splice(idx, 1);
  savePersistedState();
  renderPaperTrading();
  renderTradeHistory();
  notifyToast(`Closed ${pos.asset} ${pos.side} (${fmtSigned(pnl)} USD)`);
}

function renderPaperTrading() {
  const currentPrice = state.bars.length ? last(state.bars).close : null;
  let openPnl = 0;
  const tbody = $("positionsBody");
  tbody.replaceChildren();

  if (!state.paper.positions.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="8" class="empty-row">No open positions. Click Buy or Sell to open a virtual trade.</td>`;
    tbody.appendChild(tr);
  } else {
    for (const pos of state.paper.positions) {
      const mark = pos.asset === state.asset && valid(currentPrice) ? currentPrice : pos.entry;
      const pnl = (mark - pos.entry) * (pos.side === "LONG" ? 1 : -1) * pos.size;
      openPnl += pnl;

      const tr = document.createElement("tr");
      const slTpText = valid(pos.sl) || valid(pos.tp)
        ? `${valid(pos.sl) ? fmt(pos.sl, 2) : "—"} / ${valid(pos.tp) ? fmt(pos.tp, 2) : "—"}`
        : "None";
      tr.innerHTML = `
        <td><strong>${pos.asset}</strong></td>
        <td><span class="tag ${pos.side === "LONG" ? "bull" : "bear"}">${pos.side}</span></td>
        <td>${fmt(pos.size, 2)}</td>
        <td>${fmt(pos.entry, 2)}</td>
        <td>${slTpText}</td>
        <td>${fmt(mark, 2)}</td>
        <td class="${pnl >= 0 ? "up" : "down"}"><strong>$${fmtSigned(pnl)}</strong></td>
        <td><button type="button" class="close-pos-btn" data-close-id="${pos.id}">Close</button></td>
      `;
      tbody.appendChild(tr);
    }
  }

  const equity = state.paper.balance + openPnl;
  $("paperBalance").textContent = "$" + fmt(state.paper.balance, 2);
  $("paperEquity").textContent = "$" + fmt(equity, 2);
  $("paperOpenPnl").textContent = (openPnl >= 0 ? "+$" : "-$") + fmt(Math.abs(openPnl), 2);
  $("paperOpenPnl").className = openPnl > 0 ? "up" : openPnl < 0 ? "down" : "";
}

function renderTradeHistory() {
  const tbody = $("historyBody");
  if (!tbody) return;
  tbody.replaceChildren();

  if (!state.paper.history.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7" class="empty-row">No closed trades yet.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const h of state.paper.history) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(h.closedAt)}</td>
      <td><strong>${h.asset}</strong></td>
      <td><span class="tag ${h.side === "LONG" ? "bull" : "bear"}">${h.side}</span></td>
      <td>${fmt(h.size, 2)}</td>
      <td>${fmt(h.entry, 2)} → ${fmt(h.exit, 2)}</td>
      <td class="${h.pnl >= 0 ? "up" : "down"}"><strong>$${fmtSigned(h.pnl)}</strong></td>
      <td>${h.reason}</td>
    `;
    tbody.appendChild(tr);
  }
}

function toggleManualInputs() {
  const mode = $("useAutoSlTp").value;
  const wrap = $("manualSlTpWrap");
  if (!wrap) return;
  wrap.style.display = mode === "manual" ? "flex" : "none";
}

// -------------------- Dashboard & Visuals --------------------
function renderDashboard() {
  if (!state.bars.length || !state.ind) return;
  const bars = state.bars;
  const ind = state.ind;
  const i = bars.length - 1;
  const b = bars[i];
  const ref = bars[Math.max(0, i - 1)].close;
  const out = analyze(bars, ind, state.structure);
  const meta = ASSETS[state.asset];
  state.lastPlan = out;

  if (out.label !== state.lastSignalLabel) {
    if (out.side > 0) {
      playBeep("bull");
      notifyToast(`Signal Alert: ${state.asset} (${state.tf}) → ${out.label}`);
    } else if (out.side < 0) {
      playBeep("bear");
      notifyToast(`Signal Alert: ${state.asset} (${state.tf}) → ${out.label}`);
    }
    state.lastSignalLabel = out.label;
  }

  $("assetTitle").textContent = meta.name;
  $("assetMeta").textContent = `${state.asset} · ${state.tf} · ${state.mode === "SIM" ? "Simulation" : "Provider quotes"}`;
  $("lastPrice").textContent = fmt(b.close, meta.decimals);
  $("lastPrice").className = "price " + (b.close >= b.open ? "up" : "down");

  const delta = b.close - ref;
  const percent = ref > 0 ? delta / ref * 100 : 0;
  $("priceChange").textContent = `${fmtSigned(delta)}  (${delta >= 0 ? "+" : ""}${fmt(percent)}%) vs previous bar`;
  $("priceChange").className = "change " + (delta >= 0 ? "up" : "down");

  $("masterSignal").textContent = out.label;
  $("masterSignal").className = "signal-label " + (out.side > 0 ? "long" : out.side < 0 ? "short" : "wait");
  $("signalDetail").textContent = out.side === 0
    ? "No directional setup meets threshold"
    : `Directional setup · ${state.asset} / ${state.tf}`;

  $("confidence").textContent = out.confidence + "%";
  $("confidenceFill").style.width = out.confidence + "%";
  $("confidenceFill").style.background = out.side > 0 ? "var(--green)" : out.side < 0 ? "var(--red)" : "var(--gold)";

  $("trendStatus").innerHTML = statusTag(out.trend);
  $("momentumStatus").innerHTML = statusTag(out.momentum);
  $("volStatus").innerHTML = statusTag(out.vol);
  $("structureStatus").innerHTML = statusTag(out.structureScore);

  const rsi = ind.rsi[i];
  const macd = ind.macd.histogram[i];
  const atr = ind.atr[i];
  const bb = ind.bb;

  $("rsiVal").textContent = fmt(rsi, 1);
  $("rsiNeedle").style.left = clamp(valid(rsi) ? rsi : 50, 0, 100) + "%";
  $("macdVal").textContent = fmtMacd(macd);
  $("macdVal").className = macd > 0 ? "up" : macd < 0 ? "down" : "";
  $("macdSub").textContent = `Line ${fmtMacd(ind.macd.macd[i])} · Signal ${fmtMacd(ind.macd.signal[i])}`;
  $("atrVal").textContent = fmt(atr, meta.decimals);
  $("bbWidth").textContent = valid(bb.upper[i]) && bb.mid[i] > 0
    ? fmt(100 * (bb.upper[i] - bb.lower[i]) / bb.mid[i], 2) + "%"
    : "—";

  $("direction").textContent = out.side > 0 ? "LONG" : out.side < 0 ? "SHORT" : "WAIT";
  $("entry").textContent = out.side ? fmt(out.entry) : "WAIT";
  $("stop").textContent = fmt(out.sl);
  $("tp1").textContent = fmt(out.tp1);
  $("tp2").textContent = fmt(out.tp2);
  $("riskNote").textContent = out.side
    ? `Illustrative ${out.side > 0 ? "long" : "short"} setup · risk distance ${fmt(out.risk)} (${state.tf}).`
    : "No trade levels while neutral. Calculator uses 1.5 × ATR stop distance.";
  $("chartWatermark").textContent = state.mode === "SIM" ? "SIMULATED / EDUCATIONAL" : `${state.apiProvider.toUpperCase()} DATA`;

  updatePositionCalculator(out);
  checkPaperStopsAndTargets(b.close);
  renderPaperTrading();
}

function initChart() {
  if (!window.LightweightCharts) {
    state.useCanvas = true;
    $("fallback").style.display = "block";
    $("chartError").style.display = "block";
    $("chartError").textContent = "TradingView CDN unavailable: using built-in offline canvas chart.";
  } else {
    const L = window.LightweightCharts;
    const el = $("chartWrap");
    const chart = L.createChart($("chart"), {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { type: "solid", color: "#101a2c" },
        textColor: "#9caecc",
        fontFamily: "Inter, Arial, sans-serif",
        panes: { separatorColor: "#263651", separatorHoverColor: "#54627c" }
      },
      grid: { vertLines: { color: "#1e2b3f" }, horzLines: { color: "#1e2b3f" } },
      crosshair: {
        mode: L.CrosshairMode.Normal,
        vertLine: { color: "#8293af55" },
        horzLine: { color: "#8293af55" }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "#2a3b52",
        rightOffset: 8,
        barSpacing: 8,
        minBarSpacing: 3
      },
      rightPriceScale: {
        borderColor: "#2a3b52",
        scaleMargins: { top: 0.08, bottom: 0.08 }
      }
    });

    const candle = chart.addSeries(L.CandlestickSeries, {
      upColor: COLORS.bull,
      downColor: COLORS.bear,
      borderVisible: false,
      wickUpColor: COLORS.bull,
      wickDownColor: COLORS.bear
    }, 0);

    const line = (color, title, width = 1) =>
      chart.addSeries(L.LineSeries, {
        title,
        color,
        lineWidth: width,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false
      }, 0);

    state.chart = chart;
    state.candle = candle;
    state.lines.ema9 = line(COLORS.ema9, "EMA 9", 2);
    state.lines.ema21 = line(COLORS.ema21, "EMA 21", 2);
    state.lines.ema50 = line(COLORS.ema50, "EMA 50", 1);
    state.lines.ema200 = line(COLORS.ema200, "EMA 200", 1);
    state.lines.bbUpper = line(COLORS.bb, "BB Upper");
    state.lines.bbMid = line("#6e6b95", "BB Mid");
    state.lines.bbLower = line(COLORS.bb, "BB Lower");

    state.volume = chart.addSeries(L.HistogramSeries, {
      title: "Volume",
      priceFormat: { type: "volume" },
      priceScaleId: "right",
      lastValueVisible: false,
      priceLineVisible: false
    }, 1);

    try { chart.panes()[1].setHeight(100); } catch (e) {}

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestOverlay());
    chart.timeScale().subscribeVisibleTimeRangeChange(() => requestOverlay());
    applyVisibility();
  }

  resizeObserver = new ResizeObserver(() => {
    if (state.chart) state.chart.resize($("chartWrap").clientWidth, $("chartWrap").clientHeight);
    if (state.useCanvas) drawFallback();
    requestOverlay();
  });
  resizeObserver.observe($("chartWrap"));
}

function toLineData(series, bars) {
  const output = [];
  for (let i = 0; i < bars.length; i++) {
    if (valid(series[i])) output.push({ time: bars[i].time, value: series[i] });
  }
  return output;
}

function refreshChart(full = false) {
  if (!state.bars.length) return;
  const b = state.bars;
  const i = b.length - 1;
  const ind = state.ind;

  if (state.useCanvas) {
    drawFallback();
    return;
  }

  try {
    if (full) {
      state.candle.setData(b.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      state.volume.setData(b.map(v => ({
        time: v.time,
        value: v.volume || 0,
        color: v.close >= v.open ? "#176e5d" : "#87323e"
      })));
      for (const key of ["ema9", "ema21", "ema50", "ema200"]) {
        state.lines[key].setData(toLineData(ind[key], b));
      }
      for (const [k, v] of [["bbUpper", ind.bb.upper], ["bbMid", ind.bb.mid], ["bbLower", ind.bb.lower]]) {
        state.lines[k].setData(toLineData(v, b));
      }
      state.chart.timeScale().fitContent();
      try { state.chart.panes()[1].setHeight(100); } catch (e) {}
    } else {
      const v = b[i];
      state.candle.update({ time: v.time, open: v.open, high: v.high, low: v.low, close: v.close });
      state.volume.update({
        time: v.time,
        value: v.volume || 0,
        color: v.close >= v.open ? "#176e5d" : "#87323e"
      });
      for (const key of ["ema9", "ema21", "ema50", "ema200"]) {
        if (valid(ind[key][i])) state.lines[key].update({ time: v.time, value: ind[key][i] });
      }
      for (const [k, a] of [["bbUpper", ind.bb.upper], ["bbMid", ind.bb.mid], ["bbLower", ind.bb.lower]]) {
        if (valid(a[i])) state.lines[k].update({ time: v.time, value: a[i] });
      }
    }
  } catch (err) {
    console.error("Chart update error:", err);
  }
}

function applyVisibility() {
  const a = state.enabled;
  for (const k of ["ema9", "ema21", "ema50", "ema200"]) {
    state.lines[k]?.applyOptions({ visible: a[k] });
  }
  for (const k of ["bbUpper", "bbMid", "bbLower"]) {
    state.lines[k]?.applyOptions({ visible: a.bb });
  }
  state.volume?.applyOptions({ visible: a.volume });
  requestOverlay();
  if (state.useCanvas) drawFallback();
}

function clearPriceLines() {
  if (!state.candle) return;
  for (const p of state.priceLines) {
    try { state.candle.removePriceLine(p); } catch (e) {}
  }
  state.priceLines = [];
}

function updateStructureVisuals() {
  if (!state.structure) return;
  clearPriceLines();
  if (state.chart && state.enabled.sr) {
    const levels = [
      [state.structure.support, "Support", COLORS.bull],
      [state.structure.resistance, "Resistance", COLORS.bear]
    ];
    for (const [price, title, color] of levels) {
      if (!valid(price)) continue;
      const line = state.candle.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: window.LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title
      });
      state.priceLines.push(line);
    }
  }
  requestOverlay();
}

let overlayPending = false;
function requestOverlay() {
  if (overlayPending) return;
  overlayPending = true;
  requestAnimationFrame(() => {
    overlayPending = false;
    drawGaps();
  });
}

function drawGaps() {
  const root = $("fvgOverlay");
  root.replaceChildren();
  if (state.useCanvas || !state.chart || !state.enabled.fvg || !state.structure || !state.bars.length) return;

  const ts = state.chart.timeScale();
  const maxX = $("chartWrap").clientWidth - 67;
  const end = last(state.bars).time;
  const endX = ts.timeToCoordinate(end);
  if (!valid(endX)) return;

  for (const gap of state.structure.gaps) {
    const x = ts.timeToCoordinate(gap.startTime);
    const top = state.candle.priceToCoordinate(gap.high);
    const bottom = state.candle.priceToCoordinate(gap.low);
    if (![x, top, bottom].every(valid)) continue;

    const left = clamp(x, 0, maxX);
    const right = clamp(endX + 10, 0, maxX);
    if (right <= left) continue;

    const div = document.createElement("div");
    div.className = "gap-area";
    div.style.left = left + "px";
    div.style.width = (right - left) + "px";
    div.style.top = Math.min(top, bottom) + "px";
    div.style.height = Math.max(2, Math.abs(bottom - top)) + "px";
    div.style.background = gap.type === "bull" ? "#10b98120" : "#ef444420";
    div.style.borderTop = "1px solid " + (gap.type === "bull" ? "#10b98170" : "#ef444470");
    div.style.borderBottom = div.style.borderTop;
    root.appendChild(div);
  }
}

function drawFallback() {
  if (!state.useCanvas || !state.bars.length) return;
  const canvas = $("fallback");
  const w = $("chartWrap").clientWidth;
  const h = $("chartWrap").clientHeight;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#101a2c";
  ctx.fillRect(0, 0, w, h);

  const leftPad = 10, rightPad = 75, topPad = 25;
  const volumeHeight = state.enabled.volume ? 72 : 0;
  const priceHeight = h - 65 - volumeHeight;
  const visible = state.bars.slice(-Math.max(45, Math.min(120, Math.floor(w / 7))));

  let min = Math.min(...visible.map(b => b.low));
  let max = Math.max(...visible.map(b => b.high));
  const pad = Math.max((max - min) * 0.08, max * 0.0002);
  min -= pad;
  max += pad;

  const y = v => topPad + (max - v) / (max - min) * priceHeight;
  const dx = (w - leftPad - rightPad) / visible.length;
  const x = i => leftPad + (i + 0.5) * dx;

  // Candles
  for (let i = 0; i < visible.length; i++) {
    const b = visible[i];
    const up = b.close >= b.open;
    const px = x(i);
    ctx.strokeStyle = up ? COLORS.bull : COLORS.bear;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(px, y(b.high));
    ctx.lineTo(px, y(b.low));
    ctx.stroke();
    ctx.fillRect(
      px - Math.max(1, dx * 0.32),
      Math.min(y(b.open), y(b.close)),
      Math.max(2, dx * 0.64),
      Math.max(1, Math.abs(y(b.close) - y(b.open)))
    );
  }

  // Volume bars (if enabled)
  if (state.enabled.volume && volumeHeight > 0) {
    const volMax = Math.max(...visible.map(b => b.volume || 0), 1);
    const volTop = topPad + priceHeight + 8;
    for (let i = 0; i < visible.length; i++) {
      const b = visible[i];
      const vh = ((b.volume || 0) / volMax) * (volumeHeight - 12);
      const px = x(i);
      ctx.fillStyle = b.close >= b.open ? "#176e5d" : "#87323e";
      ctx.fillRect(px - Math.max(1, dx * 0.32), volTop + volumeHeight - 12 - vh, Math.max(2, dx * 0.64), vh);
    }
  }
}

// -------------------- Live WebSocket & Data Layer --------------------
function disposeConnections() {
  if (state.abort) {
    state.abort.abort();
    state.abort = null;
  }
  for (const name of ["simTimer", "heartbeat", "pollTimer", "retryTimer"]) {
    if (state[name]) {
      clearInterval(state[name]);
      clearTimeout(state[name]);
      state[name] = null;
    }
  }
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (e) {}
  }
}

function seedHistory(asset, tf, anchor = ASSETS[asset].seed) {
  const meta = ASSETS[asset];
  const seconds = TF_SECONDS[tf];
  const t = bucket(nowSeconds(), tf);
  const n = 340;
  const volatility = meta.minuteVol * Math.min(Math.sqrt(seconds / 60), 42);
  const closes = Array(n);
  closes[n - 1] = anchor;
  let regime = 0;

  for (let i = n - 2; i >= 0; i--) {
    if (i % 33 === 0) regime = rand(-0.32, 0.32);
    closes[i] = Math.max(0.1, closes[i + 1] * Math.exp(-(gaussian() * volatility + regime * volatility * 0.20)));
  }

  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    const o = i === 0 ? c : closes[i - 1];
    const wiggle = c * volatility * rand(0.2, 0.8);
    bars.push({
      time: t - (n - 1 - i) * seconds,
      open: o,
      high: Math.max(o, c) + wiggle,
      low: Math.min(o, c) - wiggle,
      close: c,
      volume: Math.round(rand(180, 2200))
    });
  }

  const lastBar = last(bars);
  lastBar.open = lastBar.close;
  lastBar.high = lastBar.close;
  lastBar.low = lastBar.close;
  lastBar.volume = Math.round(rand(10, 200));
  return bars;
}

function changeBars(newBars, full) {
  state.bars = newBars.slice(-maxBars);
  state.ind = indicators(state.bars);
  state.structure = detectStructure(state.bars, last(state.ind.atr));
  refreshChart(full);
  updateStructureVisuals();
  renderDashboard();
}

function simulateTick() {
  if (state.mode !== "SIM" || !state.bars.length) return;
  const meta = ASSETS[state.asset];
  const previous = last(state.bars);
  const target = Math.max(0.01, previous.close * Math.exp(gaussian() * meta.tickVol));
  receivePrice(target, nowSeconds(), Math.round(rand(1, 12)));
}

function enterSimulator(reason = "Demo ticks every second", anchor = null) {
  disposeConnections();
  state.mode = "SIM";
  state.tdDayVolume = null;
  const startPrice = valid(anchor) ? anchor : ASSETS[state.asset].seed;
  changeBars(seedHistory(state.asset, state.tf, startPrice), true);
  setStatus("SIMULATION · 1s ticks", "sim");
  $("chartCaption").textContent = reason + " · Synthetic OHLCV · Not exchange data";
  state.simTimer = setInterval(simulateTick, 1000);
}

function receivePrice(price, unixSeconds, volume = 1) {
  if (!valid(price) || price <= 0 || !state.bars.length) return;
  const time = bucket(unixSeconds, state.tf);
  const bars = state.bars;
  const b = last(bars);

  if (time < b.time) return;

  if (time === b.time) {
    bars[bars.length - 1] = {
      ...b,
      high: Math.max(b.high, price),
      low: Math.min(b.low, price),
      close: price,
      volume: (b.volume || 0) + Math.max(0, volume)
    };
  } else {
    bars.push({
      time,
      open: b.close,
      high: Math.max(b.close, price),
      low: Math.min(b.close, price),
      close: price,
      volume: Math.max(0, volume)
    });
    if (bars.length > maxBars) bars.shift();
  }

  state.ind = indicators(bars);
  state.structure = detectStructure(bars, last(state.ind.atr));
  refreshChart(false);
  updateStructureVisuals();
  renderDashboard();
}

function parseTwelveDate(text) {
  if (!text) return NaN;
  const normalized = String(text).trim().replace(" ", "T");
  const date = new Date(/Z$|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : normalized + "Z");
  return Math.floor(date.getTime() / 1000);
}

async function fetchHistory(signal) {
  if (state.apiProvider === "twelvedata") {
    const params = new URLSearchParams({
      symbol: state.asset,
      interval: TD_INTERVAL[state.tf],
      outputsize: "400",
      timezone: "UTC",
      apikey: state.apiKey
    });
    const response = await fetch(`https://api.twelvedata.com/time_series?${params}`, { signal });
    if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status}`);
    const data = await response.json();
    if (data.status === "error" || !Array.isArray(data.values)) {
      throw new Error(data.message || "Twelve Data returned no OHLC series");
    }
    return data.values.map(x => ({
      time: parseTwelveDate(x.datetime),
      open: +x.open,
      high: +x.high,
      low: +x.low,
      close: +x.close,
      volume: valid(+x.volume) ? +x.volume : 0
    }));
  }

  if (state.apiProvider === "finnhub") {
    const name = state.asset === "XAU/USD" ? "OANDA:XAU_USD" : state.asset;
    const end = nowSeconds();
    const from = end - TF_SECONDS[state.tf] * 650;
    const endpoint = state.asset === "XAU/USD" ? "forex/candle" : "stock/candle";
    const params = new URLSearchParams({
      symbol: name,
      resolution: FH_INTERVAL[state.tf],
      from: String(from),
      to: String(end),
      token: state.apiKey
    });
    const response = await fetch(`https://finnhub.io/api/v1/${endpoint}?${params}`, { signal });
    if (!response.ok) throw new Error(`Finnhub HTTP ${response.status}`);
    const data = await response.json();
    if (data.s !== "ok" || !Array.isArray(data.t)) {
      throw new Error(data.error || `Finnhub returned no data for ${name}`);
    }
    return data.t.map((time, i) => ({
      time,
      open: +data.o[i],
      high: +data.h[i],
      low: +data.l[i],
      close: +data.c[i],
      volume: valid(+data.v?.[i]) ? +data.v[i] : 0
    }));
  }

  throw new Error(`Unknown provider: ${state.apiProvider}`);
}

function sanitizeBars(bars) {
  const map = new Map();
  for (const b of bars) {
    if (![b.time, b.open, b.high, b.low, b.close].every(valid) || b.time <= 0) continue;
    const high = Math.max(b.high, b.open, b.close);
    const low = Math.min(b.low, b.open, b.close);
    map.set(b.time, {
      ...b,
      high,
      low,
      volume: valid(b.volume) ? Math.max(0, b.volume) : 0
    });
  }
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-maxBars);
}

function startSocket(generation, attempt = 0) {
  if (generation !== state.generation || state.mode !== "LIVE") return;

  const isTD = state.apiProvider === "twelvedata";
  const symbol = isTD ? state.asset : (state.asset === "XAU/USD" ? "OANDA:XAU_USD" : state.asset);
  const url = isTD
    ? `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(state.apiKey)}`
    : `wss://ws.finnhub.io?token=${encodeURIComponent(state.apiKey)}`;

  try {
    const ws = new WebSocket(url);
    state.ws = ws;
    const timeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
    }, 12000);

    ws.onopen = () => {
      if (generation !== state.generation) { ws.close(); return; }
      clearTimeout(timeout);
      state.lastWsAt = Date.now();
      const subscribe = isTD
        ? { action: "subscribe", params: { symbols: symbol } }
        : { type: "subscribe", symbol };
      ws.send(JSON.stringify(subscribe));
      setStatus(`${state.apiProvider.toUpperCase()} · STREAMING`, "live");

      if (isTD) {
        if (state.heartbeat) clearInterval(state.heartbeat);
        state.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: "heartbeat" }));
          }
        }, 10000);
      }
    };

    ws.onmessage = evt => {
      if (generation !== state.generation) return;
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }

      if (isTD) {
        if (msg.event === "price" && msg.symbol === symbol) {
          const price = Number(msg.price);
          const seconds = Number(msg.timestamp) || nowSeconds();
          let vol = 1;
          if (valid(+msg.day_volume)) {
            const current = +msg.day_volume;
            if (state.tdDayVolume !== null && current >= state.tdDayVolume) {
              vol = current - state.tdDayVolume;
            }
            state.tdDayVolume = current;
          }
          state.lastWsAt = Date.now();
          receivePrice(price, seconds, vol);
        } else if (msg.event === "subscribe-status" && (msg.status === "error" || msg.success === false)) {
          $("chartCaption").textContent = `Subscription notice: ${msg.message || "check symbol entitlement"}`;
        }
      } else if (msg.type === "trade" && Array.isArray(msg.data)) {
        for (const trade of msg.data) {
          if (trade.s === symbol) {
            state.lastWsAt = Date.now();
            receivePrice(Number(trade.p), Math.floor(Number(trade.t) / 1000), Number(trade.v) || 1);
          }
        }
      }
    };

    ws.onerror = () => {
      if (generation === state.generation) setStatus("STREAM ERROR · reconnecting", "error");
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (state.heartbeat) {
        clearInterval(state.heartbeat);
        state.heartbeat = null;
      }
      if (generation !== state.generation || state.mode !== "LIVE") return;
      if (attempt < 2) {
        setStatus(`Reconnecting ${attempt + 1}/3…`, "error");
        state.retryTimer = setTimeout(() => startSocket(generation, attempt + 1), 2000 * (attempt + 1));
      } else {
        enterSimulator("WebSocket unavailable; switched to demo", last(state.bars)?.close);
      }
    };
  } catch (err) {
    enterSimulator("WebSocket failed; simulation fallback", last(state.bars)?.close);
  }
}

async function pollHistory(generation) {
  if (generation !== state.generation || state.mode !== "LIVE" || state.abort) return;
  const controller = new AbortController();
  state.abort = controller;
  try {
    const newBars = sanitizeBars(await fetchHistory(controller.signal));
    if (generation !== state.generation || state.mode !== "LIVE") return;
    if (newBars.length >= 60 && last(newBars).time > last(state.bars).time) {
      const latest = last(state.bars).time;
      const merged = sanitizeBars([...state.bars, ...newBars.filter(b => b.time > latest)]);
      changeBars(merged, true);
    }
  } catch (err) {
    // Silent fail on poll
  } finally {
    if (state.abort === controller) state.abort = null;
  }
}

async function loadMarket(forceDemo = false) {
  const generation = ++state.generation;
  disposeConnections();
  state.bars = [];
  state.ind = null;
  state.structure = null;
  clearPriceLines();
  $("fvgOverlay").replaceChildren();

  $("assetTitle").textContent = ASSETS[state.asset].name;
  $("assetMeta").textContent = `${state.asset} · ${state.tf} · Loading`;
  $("lastPrice").textContent = "—";

  if (forceDemo || isDemoKey()) {
    enterSimulator("Demo ticks every second");
    return;
  }

  state.mode = "CONNECTING";
  setStatus(`${state.apiProvider.toUpperCase()} · loading history`);
  const controller = new AbortController();
  state.abort = controller;

  try {
    const incoming = sanitizeBars(await fetchHistory(controller.signal));
    if (generation !== state.generation) return;
    if (incoming.length < 215) throw new Error(`Only ${incoming.length} candles returned`);
    state.mode = "LIVE";
    changeBars(incoming, true);
    $("chartCaption").textContent = `${state.apiProvider.toUpperCase()} REST OHLC + WebSocket live stream`;
    setStatus(`${state.apiProvider.toUpperCase()} · connecting stream`);
    state.abort = null;
    startSocket(generation);
    state.pollTimer = setInterval(() => pollHistory(generation), 60000);
  } catch (err) {
    if (generation !== state.generation || err.name === "AbortError") return;
    enterSimulator(`Live data unavailable (${err.message}); demo fallback`);
  } finally {
    if (state.abort === controller) state.abort = null;
  }
}

// -------------------- Event Listeners --------------------
$("asset").addEventListener("change", e => {
  state.asset = e.target.value;
  savePersistedState();
  loadMarket();
});

$("timeframes").addEventListener("click", e => {
  const button = e.target.closest("button[data-tf]");
  if (!button || button.dataset.tf === state.tf) return;
  state.tf = button.dataset.tf;
  document.querySelectorAll(".tf").forEach(b => b.classList.toggle("active", b === button));
  savePersistedState();
  loadMarket();
});

$("toggles").addEventListener("change", e => {
  const k = e.target.dataset.line;
  if (!k) return;
  state.enabled[k] = e.target.checked;
  savePersistedState();
  applyVisibility();
  if (k === "sr") updateStructureVisuals();
});

$("resetSim").addEventListener("click", () => {
  ++state.generation;
  enterSimulator("Demo manually selected");
});

$("soundToggle").addEventListener("click", () => {
  state.soundEnabled = !state.soundEnabled;
  $("soundToggle").textContent = state.soundEnabled ? "🔔 Sound: On" : "🔕 Sound: Off";
  savePersistedState();
  if (state.soundEnabled) {
    playBeep("bull");
    notifyToast("Audio alerts enabled for signal flips & SL/TP triggers.");
  }
});

$("openSettings").addEventListener("click", () => {
  $("cfgProvider").value = state.apiProvider;
  $("cfgApiKey").value = state.apiKey;
  $("settingsModal").classList.add("open");
});

$("closeSettings").addEventListener("click", () => {
  $("settingsModal").classList.remove("open");
});

$("clearApiKey").addEventListener("click", () => {
  state.apiKey = "";
  $("cfgApiKey").value = "";
  savePersistedState();
  $("settingsModal").classList.remove("open");
  loadMarket(true);
  notifyToast("Switched to offline Simulator mode.");
});

$("saveSettings").addEventListener("click", () => {
  state.apiProvider = $("cfgProvider").value;
  state.apiKey = $("cfgApiKey").value.trim();
  savePersistedState();
  $("settingsModal").classList.remove("open");
  loadMarket();
  notifyToast("API configuration saved.");
});

$("calcBalance").addEventListener("input", () => {
  updatePositionCalculator(state.lastPlan);
  savePersistedState();
});

$("calcRiskPct").addEventListener("input", () => {
  updatePositionCalculator(state.lastPlan);
  savePersistedState();
});

$("btnBuy").addEventListener("click", () => openPaperPosition("LONG"));
$("btnSell").addEventListener("click", () => openPaperPosition("SHORT"));

$("btnUseCalcSize").addEventListener("click", () => {
  if (valid(state.recommendedUnits) && state.recommendedUnits > 0) {
    $("orderSize").value = state.recommendedUnits;
    notifyToast(`Order size set to ${state.recommendedUnits} from Risk Calculator.`);
  }
});

$("btnResetPaper").addEventListener("click", () => {
  if (!confirm("Reset paper account to $10,000 and clear all open positions + history?")) return;
  state.paper.balance = 10000;
  state.paper.positions = [];
  state.paper.history = [];
  savePersistedState();
  renderPaperTrading();
  renderTradeHistory();
  notifyToast("Paper trading account reset to $10,000.");
});

$("positionsBody").addEventListener("click", e => {
  const btn = e.target.closest("button[data-close-id]");
  if (!btn) return;
  closePaperPosition(Number(btn.dataset.closeId));
});

$("useAutoSlTp").addEventListener("change", toggleManualInputs);

// Keyboard shortcuts
document.addEventListener("keydown", e => {
  // Ignore when typing in inputs
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;

  if (e.key === "Escape") {
    $("settingsModal").classList.remove("open");
    return;
  }

  if (e.key === "b" || e.key === "B") {
    e.preventDefault();
    openPaperPosition("LONG");
  } else if (e.key === "s" || e.key === "S") {
    e.preventDefault();
    openPaperPosition("SHORT");
  }
});

// Clock
setInterval(() => {
  $("clock").textContent = new Date().toISOString().slice(11, 19) + " UTC";
}, 1000);
$("clock").textContent = new Date().toISOString().slice(11, 19) + " UTC";

window.addEventListener("beforeunload", disposeConnections);

// Initialize
loadPersistedState();
syncControlsFromState();
initChart();
loadMarket();
toggleManualInputs();
renderTradeHistory();
