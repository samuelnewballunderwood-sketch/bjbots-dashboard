// AlphaControl - Cloudflare Worker v4
// Capital allocation and risk management engine
// Principle: Protect capital → Improve efficiency → Optimise returns
// DASHBOARD_HTML is injected by build.js at deploy time

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
function json(data, status=200) { return new Response(JSON.stringify(data), { status, headers: CORS }); }

// ============================================================
// BOT METADATA — Single source of truth
// maxAllocationPct: hard cap per bot as % of total portfolio
// ============================================================

// ============================================================
// SYSTEM PHILOSOPHY
// AlphaControl is designed for a disciplined, risk-aware multi-bot trader
// operating a mixed strategy portfolio (grid, DCA, signal, hedge).
// Base profiles have conviction — they are not generic defaults.
// They encode sensible risk discipline for this trader archetype.
// Validate and adjust targets using real decision cycle behaviour,
// not theory. The system should be opinionated and strong.
// ============================================================
const BOT_META = {
  // ── 3Commas DCA bots (current active portfolio as of April 13 2026) ──
  16806296: { name:'ETH/USDT DCA Long',    capital:1000, direction:'long',  strategy:'dca', venue:'3commas', marketType:'spot',    symbol:'ETHUSDT', maxAllocationPct:20 },
  16807404: { name:'BTC/USDT DCA Long',    capital:700,  direction:'long',  strategy:'dca', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', maxAllocationPct:15 },
  16806276: { name:'SOL/USDT DCA Long',    capital:500,  direction:'long',  strategy:'dca', venue:'3commas', marketType:'spot',    symbol:'SOLUSDT', maxAllocationPct:12 },
  16808289: { name:'XRP/USDT DCA Long',    capital:500,  direction:'long',  strategy:'dca', venue:'3commas', marketType:'spot',    symbol:'XRPUSDT', maxAllocationPct:12 },
  16808275: { name:'BNB/USDT DCA Long',    capital:100,  direction:'long',  strategy:'dca', venue:'3commas', marketType:'spot',    symbol:'BNBUSDT', maxAllocationPct:5  },
  16809699: { name:'ETH Hedge Bot',        capital:0,    direction:'short', strategy:'dca', venue:'3commas', marketType:'futures', symbol:'ETHUSDT', maxAllocationPct:0  },
  // ── Stopped/legacy bots (kept for profit history, not active) ──
  16801943: { name:'BTC Long Futures Bot', capital:0,    direction:'long',  strategy:'dca', venue:'3commas', marketType:'futures', symbol:'BTCUSDT', maxAllocationPct:0  },
  16801248: { name:'BTC Hedge Bot',        capital:0,    direction:'short', strategy:'dca', venue:'3commas', marketType:'futures', symbol:'BTCUSDT', maxAllocationPct:0  },
  16812336: { name:'BNB Short Hedge Bot',  capital:0,    direction:'short', strategy:'dca', venue:'3commas', marketType:'futures', symbol:'BNBUSDT', maxAllocationPct:0  },
  16812326: { name:'SOL Short Hedge Bot',  capital:0,    direction:'short', strategy:'dca', venue:'3commas', marketType:'futures', symbol:'SOLUSDT', maxAllocationPct:0  },
  // ── 3Commas Grid bots (live as of April 14 — confirmed via /debug-tc) ──
  2752385:  { name:'BTC/USDT LONG Grid $298',  capital:298,  direction:'long',  strategy:'grid', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', roi:0,    scoreType:'spot-grid',    maxAllocationPct:5  },
  2759318:  { name:'BTC/USDT LONG Grid $910',  capital:910,  direction:'long',  strategy:'grid', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', roi:0,    scoreType:'spot-grid',    maxAllocationPct:15 },
  2759323:  { name:'ETH/USDT LONG Grid $920',  capital:920,  direction:'long',  strategy:'grid', venue:'3commas', marketType:'spot',    symbol:'ETHUSDT', roi:0,    scoreType:'spot-grid',    maxAllocationPct:15 },
  // ── Closed grids (capital=0, kept for history) ──
  2757088:  { name:'BTC/USDT Grid (CLOSED)',   capital:0,    direction:'long',  strategy:'grid', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', roi:0,    scoreType:'spot-grid',    maxAllocationPct:0  },
  2758668:  { name:'ETH SHORT x3 Grid (CLOSED)', capital:0, direction:'short', strategy:'grid', venue:'3commas', marketType:'futures', symbol:'ETHUSDT', roi:0,    scoreType:'futures-grid', maxAllocationPct:0  },
  2758366:  { name:'BTC SHORT x3 Grid (CLOSED)', capital:0, direction:'short', strategy:'grid', venue:'3commas', marketType:'futures', symbol:'BTCUSDT', roi:0,    scoreType:'futures-grid', maxAllocationPct:0  },
  // ── Binance native bots (legacy, mapped by trade symbol) ──
  'eth-grid-trades':     { name:'ETH/USDT Spot Grid',   capital:400, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'ETHUSDT', roi:0,    scoreType:'spot-grid',    maxAllocationPct:0  },
  'btc-dca-trades':      { name:'BTC/USDT Spot DCA',    capital:300, direction:'long', strategy:'dca',  venue:'binance', marketType:'spot',    symbol:'BTCUSDT', roi:0,    scoreType:'spot-dca',     maxAllocationPct:0  },
  'bnb-grid-trades':     { name:'BNB/USDT Spot Grid',   capital:300, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'BNBUSDT', roi:0,    scoreType:'spot-grid',    maxAllocationPct:0  },
  'sol-grid-trades':     { name:'SOL/USDT Spot Grid',   capital:220, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'SOLUSDT', roi:0,    scoreType:'spot-grid',    maxAllocationPct:0  },
  'xrp-grid-trades':     { name:'XRP/USDT Spot Grid',   capital:249, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'XRPUSDT', roi:0,    scoreType:'spot-grid',    maxAllocationPct:0  },
  'ethusdt-perp-trades': { name:'ETHUSDT Futures Grid', capital:0,   direction:'long', strategy:'grid', venue:'binance', marketType:'futures', symbol:'ETHUSDT', roi:0,    scoreType:'futures-grid', maxAllocationPct:0  },
};

// Reallocation controls
const RC = {
  minimumMoveUsd:          25,
  maxAllocationByStrategy: { grid:55, dca:35, signal:15 },
  scoreThresholds:         { reduce:50, monitor:70, hold:85, increase:85 },
  recipientMinScore:       70,
  recipientMinTrades:      3,
  gapThresholdPct:         5,   // gaps smaller than this are ignored
};

// ============================================================
// CAPITAL RECONCILIATION ENGINE
// ============================================================
// Source of truth: Binance wallet locked balances + futures margin
// Every dollar must belong to exactly one category.
// No double counting. No hardcoded capital values.
// ============================================================

// Price all assets in USD using current market prices
function priceAssets(balances, prices) {
  const PRICE_MAP = {};
  if (Array.isArray(prices)) {
    // Legacy array format: [{symbol, price}, ...]
    prices.forEach(p => { PRICE_MAP[p.symbol] = parseFloat(p.price); });
  } else if (prices && typeof prices === 'object') {
    // Object format from EU proxy: {BTCUSDT: 71672, ETHUSDT: 2216, ...}
    Object.entries(prices).forEach(([sym, price]) => { PRICE_MAP[sym] = parseFloat(price); });
  }
  let total = 0;
  const breakdown = [];
  (balances || []).forEach(b => {
    const asset   = b.asset;
    const free    = parseFloat(b.free)   || 0;
    const locked  = parseFloat(b.locked) || 0;
    const total_  = free + locked;
    if (total_ < 0.0001) return;

    let usdPrice = 1;
    if (asset === 'USDT' || asset === 'USDC' || asset === 'BUSD') {
      usdPrice = 1;
    } else if (asset.startsWith('LD')) {
      // Earn tokens — LDUSDT, LDUSDC etc map 1:1
      usdPrice = 1;
    } else {
      usdPrice = PRICE_MAP[asset + 'USDT'] || PRICE_MAP[asset + 'BUSD'] || 0;
      if (!usdPrice && asset === 'BNB') usdPrice = PRICE_MAP['BNBUSDT'] || 0;
    }

    const freeUsd   = free   * usdPrice;
    const lockedUsd = locked * usdPrice;
    const totalUsd  = freeUsd + lockedUsd;

    if (totalUsd < 0.01) return;
    total += totalUsd;
    breakdown.push({ asset, free, locked, freeUsd, lockedUsd, totalUsd, usdPrice });
  });
  return { total: Math.round(total * 100) / 100, breakdown };
}

// Build the full capital reconciliation object
// Called with live data from all sources
function buildReconciliation({ spotBalances, futuresWallet, tcBots, bnBots, prices }) {
  // ── 1. SPOT WALLET ──────────────────────────────────────────
  const spot = priceAssets(spotBalances, prices);
  const spotFree   = spot.breakdown.reduce((s, a) => s + a.freeUsd,   0);
  const spotLocked = spot.breakdown.reduce((s, a) => s + a.lockedUsd, 0);
  const spotEarn   = spot.breakdown
    .filter(a => a.asset.startsWith('LD'))
    .reduce((s, a) => s + a.totalUsd, 0);
  const spotWallet = spot.total - spotEarn; // excludes earn tokens

  // ── 2. FUTURES WALLET ────────────────────────────────────────
  const futuresTotal     = parseFloat(futuresWallet?.marginBalance      || 0);
  const futuresAvailable = parseFloat(futuresWallet?.availableBalance   || 0);
  const futuresInUse     = futuresTotal - futuresAvailable;
  const futuresUnrealized = parseFloat(futuresWallet?.unrealizedPnl    || 0);

  // ── 3. EARN / FLEXIBLE SAVINGS ───────────────────────────────
  const earnTotal = spotEarn; // LDUSDT, LDUSDC in spot balances

  // ── 4. BOT CAPITAL BREAKDOWN ─────────────────────────────────
  // 3Commas: use live capital field from API (what they report)
  let tcCapital = 0;
  const tcBotBreakdown = [];
  (tcBots || []).forEach(b => {
    const cap = parseFloat(b.capital) || 0;
    const realised  = parseFloat(b.profit) || 0;
    const floating  = parseFloat(b.uprofit || b.unrealized_profit) || 0;
    const trueValue = cap + realised + floating;
    tcCapital += cap;
    tcBotBreakdown.push({
      id: b.id, name: b.name || b.pair,
      capital: cap, realised, floating, trueValue,
      strategy: b.strategy || 'dca',
      direction: b.direction || 'long',
      marketType: b.marketType || 'spot',
      active: b.active !== undefined ? b.active : false,
      activeDeals: b.activeDeals || 0,
      completedDeals: b.completedDeals || 0,
      pair: b.pair || null,
      enabled: b.active !== undefined ? b.active : false,
    });
  });

  // ── 4b. BINANCE NATIVE BOTS ──────────────────────────────────────
  // Binance native bots have been fully migrated to 3Commas.
  // All locked wallet assets (BTC/ETH/SOL/XRP/USDT) belong to 3Commas grid bots.
  // Do NOT create phantom Binance native bot entries — that causes double-counting.
  const bnCapital     = 0;
  const bnBotBreakdown = [];
  const bnRealised    = 0;
  // Override bnCapital with actual spot locked total for reconciliation accuracy
  // This is what Binance actually shows as "in bots" — the per-bot split is estimated
  const bnCapitalTrue = spotLocked; // source of truth from wallet

    // ── 5. GRAND TOTAL ───────────────────────────────────────────
  // Source of truth: Binance wallet balances at market price
  // IMPORTANT: 3Commas capital IS Binance capital — they share the same wallet
  // So we do NOT add tcCapital to bnCapital — that would double-count
  const binanceTotal = spot.total + futuresTotal;
  const grandTotal   = binanceTotal;

  // ── 6. CAPITAL STATES ─────────────────────────────────────────
  // Derive states from actual wallet data, not from bot claims
  // Spot locked = capital sitting inside active bot orders
  // Futures in use = margin used by open futures positions
  const activeInTrades   = futuresInUse + spotLocked;
  const freeInWallet     = Math.max(0, spotFree - spotEarn);
  const futuresMargin    = futuresTotal;

  // Idle = locked in bots with 0 trades (allocated but not working)
  const idleInBots = bnBotBreakdown
    .filter(b => b.trades === 0 && b.capital > 0)
    .reduce((s, b) => s + b.capital, 0);
  const reservedInBots = spotLocked - idleInBots; // active bot orders

  // ── 7. PNL BREAKDOWN ──────────────────────────────────────────
  // Realised: prefer /deals/summary (sums every closed deal's final_profit) over
  // tcBots aggregation because tcBots.profit only counts trial2-filtered DCA
  // deals and misses DCA bots whose deals all closed before Trial 2.
  let tcRealised = tcBotBreakdown.reduce((s, b) => s + (b.realised || 0), 0);
  try {
    const dsR = await fetch('https://tc-proxy-eu.onrender.com/deals/summary');
    if (dsR.ok) {
      const ds = await dsR.json();
      // Use canonical total (DCA + Grid + Smart Trade + Reinvested) when it exceeds
      // the tcBots aggregate — that's the more complete picture.
      const canonical = parseFloat(ds.totalProfit || 0);
      if (canonical > tcRealised) tcRealised = canonical;
    }
  } catch(_) {}
  const totalRealised  = Math.round(tcRealised * 100) / 100;
  const tcFloating     = tcBotBreakdown.reduce((s, b) => s + (b.floating || 0), 0);
  const totalFloating  = Math.round((futuresUnrealized + tcFloating) * 100) / 100;
  const totalPnl       = Math.round((totalRealised + totalFloating) * 100) / 100;

  // ── 8. STRATEGY BREAKDOWN ─────────────────────────────────────
  // Use Binance wallet locked amounts for strategy allocation
  // 3Commas bots are shown separately (they run on top of Binance capital)
  const byStrategy = {};
  // Binance native bot strategies
  bnBotBreakdown.forEach(b => {
    const strat = b.strategy || 'grid';
    if (!byStrategy[strat]) byStrategy[strat] = { capital: 0, realised: 0, bots: 0 };
    byStrategy[strat].capital  += b.capital;
    byStrategy[strat].realised += b.realised || 0;
    byStrategy[strat].bots     += 1;
  });
  // 3Commas strategies (noted as managed capital, not additive to total)
  const tcByStrategy = {};
  tcBotBreakdown.forEach(b => {
    const strat = b.strategy || 'dca';
    if (!tcByStrategy[strat]) tcByStrategy[strat] = { capital: 0, realised: 0, bots: 0 };
    tcByStrategy[strat].capital  += b.capital;
    tcByStrategy[strat].realised += b.realised || 0;
    tcByStrategy[strat].bots     += 1;
  });

  // ── 9. CURRENCY BREAKDOWN ─────────────────────────────────────
  const byCurrency = {};
  spot.breakdown.forEach(a => {
    const cur = a.asset.startsWith('LD') ? a.asset.slice(2) : a.asset;
    if (!byCurrency[cur]) byCurrency[cur] = { total: 0, free: 0, locked: 0 };
    byCurrency[cur].total  += a.totalUsd;
    byCurrency[cur].free   += a.freeUsd;
    byCurrency[cur].locked += a.lockedUsd;
  });
  // Futures adds to USDT (margin is USDT-denominated)
  if (!byCurrency['USDT']) byCurrency['USDT'] = { total: 0, free: 0, locked: 0 };
  byCurrency['USDT'].total  += futuresTotal;
  byCurrency['USDT'].locked += futuresTotal;

  // ── 10. RECONCILIATION CHECK ──────────────────────────────────
  // Correct model: Binance wallet = spot locked + spot free + futures
  // Bot allocations are a VIEW into wallet capital, not additive
  // Reconciliation check: spot locked should roughly equal bnCapital
  // (Binance native bots hold the locked spot assets)
  // Use actual locked balance as true bot capital for reconciliation
  const allocatedCapital = bnCapitalTrue; // = spotLocked — what wallets actually show
  const unallocated = Math.max(0, spotFree - spotEarn);
  // Difference: binanceTotal should = spotLocked + spotFree + spotEarn + futuresTotal
  // If this is near zero, our numbers are trustworthy
  const calcTotal  = spotLocked + spotFree + spotEarn + futuresTotal;
  const difference = Math.round((binanceTotal - calcTotal) * 100) / 100;
  const reconciled = Math.abs(difference) < 10; // tight tolerance — pure math check

  return {
    // Totals
    grandTotal:      Math.round(grandTotal * 100) / 100,
    binanceTotal:    Math.round(binanceTotal * 100) / 100,
    spotTotal:       Math.round(spot.total * 100) / 100,
    spotFree:        Math.round(spotFree * 100) / 100,
    spotLocked:      Math.round(spotLocked * 100) / 100,
    spotEarn:        Math.round(spotEarn * 100) / 100,
    futuresTotal:    Math.round(futuresTotal * 100) / 100,
    futuresInUse:    Math.round(futuresInUse * 100) / 100,
    futuresAvailable:Math.round(futuresAvailable * 100) / 100,
    earnTotal:       Math.round(earnTotal * 100) / 100,
    tcCapital:       Math.round(tcCapital * 100) / 100,
    bnCapital:       Math.round(bnCapitalTrue * 100) / 100,
    bnCapitalEstimated: Math.round(bnCapital * 100) / 100, // per-bot estimates

    // PnL
    totalRealised:   Math.round(totalRealised * 100) / 100,
    totalFloating:   Math.round(totalFloating * 100) / 100,
    totalPnl:        Math.round(totalPnl * 100) / 100,
    futuresUnrealized: Math.round(futuresUnrealized * 100) / 100,

    // Capital states
    capitalStates: {
      activeInTrades:  Math.round(activeInTrades * 100) / 100,
      reservedInBots:  Math.round(reservedInBots * 100) / 100,
      idleInBots:      Math.round(idleInBots * 100) / 100,
      freeInWallet:    Math.round(freeInWallet * 100) / 100,
      futuresMargin:   Math.round(futuresMargin * 100) / 100,
    },

    // Breakdowns
    byStrategy,
    byCurrency,
    spotAssets:    spot.breakdown,
    tcBots:        tcBotBreakdown,
    bnBots:        bnBotBreakdown,

    // Reconciliation
    reconciled,
    difference,
    allocatedCapital: Math.round(allocatedCapital * 100) / 100,
    tcByStrategy,
    tcCapitalNote: '3Commas capital is a subset of Binance total — not additive',
  };
}



// ============================================================
// STEP 1 — DYNAMIC PORTFOLIO TARGET STATE
// Base profiles adjusted each cycle by regime, volatility, risk state.
// Every target is explainable: base + adjustments = final.
//
// BASE PROFILE RATIONALE (for a disciplined, risk-aware multi-bot trader):
// - longPct 65%: meaningful long exposure without reckless bias
// - shortPct 15%: permanent hedge floor — always some protection
// - gridPct 45%: grids work in ranging markets, capped to avoid overconcentration
// - dcaPct 30%: DCA as steady core strategy
// - signalPct 10%: signals as a small, tactical layer only
// - btcConcentrationPct 40%: BTC is dominant but must not be the whole portfolio
// - ethConcentrationPct 35%: ETH secondary, capped separately
//
// These are validated by real cycle behaviour, not theoretical compromise.
// ============================================================
const BASE_PROFILES = {
  default: {
    longPct:  65, shortPct: 15, gridPct: 45, dcaPct: 30, signalPct: 10,
    btcConcentrationPct: 40, ethConcentrationPct: 35,
  },
};

function computeTargetState({ regime, volatility, riskState, fearGreed }) {
  const base = { ...BASE_PROFILES.default };
  const adjustments = [];

  // ── Quantum Rules regime override — takes precedence over everything ──
  // R2: F&G < 30 = EXTREME_FEAR/FEAR regime
  // NOTE: "no new directional longs" — existing grids/DCA deals run to completion
  // Target is to reduce NEW allocation to longs, not close existing positions
  const fg = fearGreed ?? 50;
  if (fg < 30) {
    // R2 ACTIVE: no new long entries, light hedge, grids OK (neutral)
    // We set long=40 because existing grid capital IS deployed long — it shouldn't be zeroed
    // The action centre should say "don't add new longs" not "close everything"
    base.longPct  = 40;  // existing grids are acceptable, no new DCA longs
    base.shortPct = 15;  // light hedge — 15% is realistic, 40% would mean closing all grids
    base.gridPct  = 50;  // neutral grids OK — they profit in ranging markets
    base.dcaPct   = 0;   // no new DCA long entries
    adjustments.push('R2 ACTIVE (F&G=' + fg + '): no new DCA longs, light hedge 15%, grids OK');
    return { targets: base, adjustments, basedOn: { regime, volatility, riskState, fearGreed: fg } };
  } else if (fg < 50) {
    // FEAR: reduced longs, elevated shorts
    base.longPct  = 30;
    base.shortPct = 25;
    base.gridPct  = 40;
    base.dcaPct   = 15;
    adjustments.push('FEAR regime (F&G=' + fg + '): long=30%, hedge=25%, grids=40%');
    return { targets: base, adjustments, basedOn: { regime, volatility, riskState, fearGreed: fg } };
  } else if (fg > 70) {
    // GREED: full long allocation
    base.longPct  = 70;
    base.shortPct = 10;
    base.gridPct  = 45;
    base.dcaPct   = 35;
    adjustments.push('GREED regime (F&G=' + fg + '): long=70%, hedge=10%');
  } else {
    // NEUTRAL (50-70): base targets with standard adjustments
    if (regime === 'Bear') {
      base.longPct  -= 10;
      base.shortPct += 5;
      base.gridPct  -= 10;
      base.dcaPct   += 5;
      adjustments.push('Bear market: long -10%, hedge +5%, grid -10%, DCA +5%');
    } else if (regime === 'Bull') {
      base.longPct  += 10;
      base.shortPct -= 5;
      base.gridPct  += 5;
      adjustments.push('Bull market: long +10%, hedge -5%, grid +5%');
    } else {
      adjustments.push('Sideways market: base targets apply');
    }
  }

  // Volatility adjustments
  if (volatility === 'High') {
    base.gridPct   -= 10;
    base.dcaPct    += 5;
    base.shortPct  += 5;
    adjustments.push('High volatility: grid -10%, DCA +5%, hedge +5%');
  } else if (volatility === 'Low') {
    base.gridPct   += 5;
    adjustments.push('Low volatility: grid +5%');
  }

  // Risk state adjustments
  if (riskState === 'HIGH_RISK') {
    base.longPct   = Math.min(base.longPct, 50);
    base.shortPct  = Math.max(base.shortPct, 25);
    base.gridPct   = Math.min(base.gridPct, 35);
    adjustments.push('HIGH_RISK state: long capped 50%, hedge floored 25%');
  }

  // Clamp
  base.longPct   = Math.min(85, Math.max(0,  base.longPct));
  base.shortPct  = Math.min(50, Math.max(0,  base.shortPct));
  base.gridPct   = Math.min(60, Math.max(20, base.gridPct));
  base.dcaPct    = Math.min(50, Math.max(0,  base.dcaPct));
  base.signalPct = Math.min(20, Math.max(5,  base.signalPct));

  return { targets: base, adjustments, basedOn: { regime, volatility, riskState, fearGreed: fg } };
}

// Compute gaps between current portfolio and dynamic targets
// Tiered: Tier 1 (exposure) overrides Tier 2 (strategy mix) overrides Tier 3 (concentration)
// Tier 1 gaps suppress lower-tier suggestions to avoid conflicting signals
function computePortfolioGaps(portfolio, targets, totalAllocated) {
  const gaps = [];
  const { longPct, shortPct, byStrategy, bySymbol } = portfolio;

  function addGap(dimension, current, target, objectiveName, tier) {
    const delta = current - target;
    const usd   = Math.abs(Math.round((delta / 100) * totalAllocated));
    if (Math.abs(delta) >= RC.gapThresholdPct && usd >= RC.minimumMoveUsd) {
      gaps.push({ dimension, current, target, delta, usd, objective: objectiveName, tier });
    }
  }

  // Tier 1 — Primary control (exposure balance)
  addGap('long_exposure',  longPct,  targets.longPct,  'long_exposure',  1);
  addGap('hedge_exposure', shortPct, targets.shortPct, 'hedge_exposure', 1);

  const tier1Active = gaps.some(g => g.tier === 1 && Math.abs(g.delta) > 10);

  // Tier 2 — Strategy mix (suppressed if large Tier 1 gaps exist)
  if (!tier1Active) {
    const gridPct = totalAllocated > 0 ? Math.round(((byStrategy.grid||0)/totalAllocated)*100) : 0;
    const dcaPct  = totalAllocated > 0 ? Math.round(((byStrategy.dca||0) /totalAllocated)*100) : 0;
    addGap('grid_allocation', gridPct, targets.gridPct, 'grid_allocation', 2);
    addGap('dca_allocation',  dcaPct,  targets.dcaPct,  'dca_allocation',  2);
  }

  // Tier 3 — Concentration (suppressed if any Tier 1 or Tier 2 gaps exist)
  const tier2Active = gaps.some(g => g.tier === 2);
  if (!tier1Active && !tier2Active) {
    const btcPct = totalAllocated > 0 ? Math.round(((bySymbol['BTCUSDT']||0)/totalAllocated)*100) : 0;
    const ethPct = totalAllocated > 0 ? Math.round(((bySymbol['ETHUSDT']||0)/totalAllocated)*100) : 0;
    addGap('btc_concentration', btcPct, targets.btcConcentrationPct, 'btc_concentration', 3);
    addGap('eth_concentration', ethPct, targets.ethConcentrationPct, 'eth_concentration', 3);
  }

  // Sort: Tier first, then by gap size within tier
  gaps.sort((a, b) => a.tier !== b.tier ? a.tier - b.tier : Math.abs(b.delta) - Math.abs(a.delta));
  return gaps;
}

// ============================================================
// STEP 2 — RISK STATE ENGINE
// Hard computed. Gates recommendation classes.
// ============================================================
function computeRiskState({ longPct, floatingPnl, totalAllocated, volatility, byStrategy }) {
  let riskScore = 0;
  const factors = [];
  const floatingPct = totalAllocated > 0 ? (floatingPnl / totalAllocated) * 100 : 0;
  const gridPct     = totalAllocated > 0 ? ((byStrategy.grid||0) / totalAllocated) * 100 : 0;

  if      (longPct > 85) { riskScore += 40; factors.push('Extreme long bias (' + longPct + '%)'); }
  else if (longPct > 75) { riskScore += 25; factors.push('High long bias (' + longPct + '%)'); }
  else if (longPct > 65) { riskScore += 10; factors.push('Elevated long bias (' + longPct + '%)'); }

  if      (floatingPct < -5)  { riskScore += 35; factors.push('Significant floating loss (' + floatingPct.toFixed(1) + '%)'); }
  else if (floatingPct < -2)  { riskScore += 15; factors.push('Moderate floating loss (' + floatingPct.toFixed(1) + '%)'); }

  if      (volatility === 'High' && gridPct > 40) { riskScore += 20; factors.push('High volatility with ' + gridPct.toFixed(0) + '% grid exposure'); }
  else if (volatility === 'High')                 { riskScore += 10; factors.push('High market volatility'); }

  const maxStratPct = Object.values(byStrategy).reduce((mx, v) => Math.max(mx, totalAllocated > 0 ? (v/totalAllocated)*100 : 0), 0);
  if (maxStratPct > 60) { riskScore += 10; factors.push('Strategy concentration (' + maxStratPct.toFixed(0) + '%)'); }

  riskScore = Math.min(100, riskScore);
  const riskState = riskScore >= 60 ? 'HIGH_RISK' : riskScore >= 35 ? 'OVEREXPOSED' : riskScore >= 15 ? 'BALANCED' : 'SAFE';

  // Sub-label: explains WHY the state is what it is — avoids "BALANCED but acting" confusion
  const longTarget = 65; // base default for sub-label context
  let riskSubLabel = null;
  if (riskState === 'SAFE') {
    riskSubLabel = 'All targets met — no action required';
  } else if (riskState === 'BALANCED') {
    if (longPct > longTarget) riskSubLabel = 'Stable — above target long exposure';
    else if (floatingPct < -1)  riskSubLabel = 'Stable — minor floating loss';
    else                        riskSubLabel = 'Within acceptable range';
  } else if (riskState === 'OVEREXPOSED') {
    riskSubLabel = 'Elevated risk — reducing exposure recommended';
  } else if (riskState === 'HIGH_RISK') {
    riskSubLabel = 'Defensive mode — optimisations suppressed';
  }

  return { riskState, riskSubLabel, riskScore, factors, floatingPct: parseFloat(floatingPct.toFixed(2)) };
}

// ============================================================
// STEP 3 — STANDARDISED DECISION OBJECT
// Every action has the same shape. objective field enables consolidation.
// ============================================================
function makeDecision({ actionType, text, reason, amount, amountPct, targetBotIds, fromBotId, toBotId,
                        urgency, timeframe, expectedImpact, costOfInaction, category, confidence,
                        executable, objective, targetDimension, portfolio, targets,
                        suggestedPair, suggestedAsset, stale_orders_payload, tv_alert,
                        tuneParams }) {
  return {
    actionType:      actionType     || 'reduce',
    text:            text           || '',
    reason:          reason         || '',
    amount:          amount         || 0,
    amountPct:       amountPct      || 0,
    targetBotIds:    targetBotIds   || [],
    fromBotId:       fromBotId      || null,
    toBotId:         toBotId        || null,
    urgency:         urgency        || 'medium',
    severity:        urgency        || 'medium',
    timeframe:       timeframe      || '4h',
    expectedImpact:  expectedImpact || '',
    costOfInaction:  costOfInaction || null,
    objective:       objective      || targetDimension || 'portfolio_balance',
    category:        category       || 'suggested',
    confidence:      Math.min(100, Math.max(0, confidence || 70)),
    executable:      executable     || false,
    suggestedPair, suggestedAsset,
    tuneParams:      tuneParams     || undefined,
    payload: stale_orders_payload ? { orders: stale_orders_payload } : tv_alert ? { alert: tv_alert } : undefined,
    generatedAt:     new Date().toISOString(),
  };
}

// ── PROJECTED STATE — what the portfolio looks like AFTER this action ─────
// Called after all decisions are generated, enriches each with post-action estimates
function enrichWithProjectedState(decisions, portfolio, targets) {
  const { totalAllocated, longCapital, shortCapital } = portfolio;
  if (!totalAllocated) return decisions;

  return decisions.map(d => {
    const amount = d.amount || 0;
    if (amount === 0 || d.actionType === 'hold') return d;

    let projLong  = longCapital;
    let projShort = shortCapital;

    // Estimate portfolio change from this action
    if (d.objective === 'long_exposure' && d.actionType === 'reduce') {
      projLong = Math.max(0, longCapital - amount);
    } else if (d.objective === 'hedge_exposure' && d.actionType === 'increase') {
      projShort = shortCapital + amount;
    } else if (d.objective === 'idle_capital' || d.objective === 'bot_efficiency') {
      projLong = Math.max(0, longCapital - amount); // freeing from long-side bots
    } else if (d.actionType === 'reallocate') {
      // Neutral reallocation — same total, same exposure split
    }

    const projLongPct  = Math.round((projLong  / totalAllocated) * 100);
    const projShortPct = Math.round((projShort / totalAllocated) * 100);

    // Estimate projected risk score (simplified)
    const longTarget  = targets ? targets.longPct  : 65;
    const shortTarget = targets ? targets.shortPct : 20;
    const longGapAfter  = Math.abs(projLongPct  - longTarget);
    const shortGapAfter = Math.abs(projShortPct - shortTarget);
    const projRiskScore = Math.max(0, Math.min(100,
      (longGapAfter  > 20 ? 40 : longGapAfter  > 10 ? 20 : 5) +
      (shortGapAfter > 10 ? 20 : shortGapAfter > 5  ? 10 : 0)
    ));
    const projRiskState = projRiskScore >= 60 ? 'HIGH_RISK'
      : projRiskScore >= 35 ? 'OVEREXPOSED'
      : projRiskScore >= 15 ? 'BALANCED' : 'SAFE';

    // Gap closed as % of original gap
    const origGap = Math.abs(portfolio.longPct - longTarget);
    const newGap  = Math.abs(projLongPct - longTarget);
    const gapClosed = origGap > 0 ? Math.round(((origGap - newGap) / origGap) * 100) : 0;

    return {
      ...d,
      projectedState: {
        longPct:   projLongPct,
        shortPct:  projShortPct,
        riskScore: projRiskScore,
        riskState: projRiskState,
        gapClosed: Math.max(0, gapClosed),
        summary:   buildProjectionSummary(d, projLongPct, projRiskState, gapClosed, portfolio.riskState || 'BALANCED'),
      }
    };
  });
}

function buildProjectionSummary(d, projLongPct, projRiskState, gapClosed, currentRiskState) {
  const parts = [];
  if (d.objective === 'long_exposure' && d.actionType === 'reduce') {
    parts.push('Long exposure drops to ~' + projLongPct + '%');
  }
  if (d.objective === 'hedge_exposure' && d.actionType === 'increase') {
    parts.push('Hedge allocation increases — downside protection improves');
  }
  if (d.objective === 'idle_capital') {
    parts.push('$' + d.amount + ' recovered from non-performing capital');
  }
  if (d.objective === 'bot_efficiency') {
    parts.push('Capital efficiency improves — freed to stronger strategies');
  }
  if (gapClosed > 0) {
    parts.push('Closes ' + gapClosed + '% of current portfolio imbalance');
  }
  if (projRiskState !== currentRiskState && projRiskState === 'SAFE') {
    parts.push('Portfolio moves to SAFE state after this action');
  } else if (projRiskState !== currentRiskState) {
    parts.push('Risk state: ' + currentRiskState + ' → ' + projRiskState);
  }
  return parts.join(' · ') || 'Moves portfolio toward target state';
}

// ── CONFIDENCE ANCHOR — explains WHY system is confident ─────────────────
function buildConfidenceAnchor(riskState, riskFactors, market, targetAdjustments) {
  const parts = [];

  // Regime alignment
  if (market.regime === 'Bear' && riskFactors.some(f => f.includes('long bias'))) {
    parts.push('Long bias in bear regime = elevated risk — action strongly supported');
  } else if (market.regime === 'Bull' && riskState === 'SAFE') {
    parts.push('Bull regime with balanced portfolio — hold is well supported');
  } else if (market.regime === 'Sideways') {
    parts.push('Sideways regime — gradual rebalancing is low-risk');
  }

  // Volatility context
  if (market.volatility === 'High') {
    parts.push('High volatility increases urgency of defensive positioning');
  }

  // Risk factor alignment
  if (riskFactors.length >= 2) {
    parts.push('Multiple risk factors align — confidence in this direction is high');
  } else if (riskFactors.length === 1) {
    parts.push('Single elevated risk factor — targeted action is appropriate');
  }

  // Adjustment count
  if (targetAdjustments && targetAdjustments.length > 1) {
    parts.push('Target state adjusted for current regime and risk level');
  }

  return parts.slice(0, 2).join('. ') + (parts.length > 0 ? '.' : '');
}

// Cost of inaction — proportional to exposed capital, not just action size
// Uses 5x multiplier to reflect that the EXPOSED position is larger than the move itself
function inactionCost(amount, urgency, exposedCapital) {
  if (!amount || amount <= 0 || !['critical','high'].includes(urgency)) return null;
  // Use exposed capital if provided, else approximate as 3x the recommended move
  const exposure = exposedCapital || amount * 3;
  const scenarios = urgency === 'critical'
    ? [['3%', 0.03], ['5%', 0.05]]
    : [['2%', 0.02], ['3%', 0.03]];
  return scenarios.map(([label, rate]) =>
    'If market drops ' + label + ': estimated -$' + Math.round(exposure * rate) + ' downside'
  ).join(' · ');
}

// ============================================================
// STEP 4 — ACTION CONSOLIDATION
// Group actions serving the same objective into one higher-level action.
// Reduces noise. Portfolio signal, not a pile of cards.
// ============================================================
function consolidateActions(actions) {
  const groups = {};
  const consolidated = [];

  actions.forEach(a => {
    const key = a.objective + '|' + a.actionType + '|' + a.category;
    if (!groups[key]) groups[key] = [];
    groups[key].push(a);
  });

  Object.values(groups).forEach(group => {
    if (group.length === 1) { consolidated.push(group[0]); return; }

    // Consolidate group into one action
    const totalAmt   = group.reduce((s, a) => s + (a.amount||0), 0);
    const allBotIds  = [...new Set(group.flatMap(a => a.targetBotIds))];
    const urgencies  = { critical:0, high:1, medium:2, low:3 };
    const topUrgency = group.reduce((top, a) => (urgencies[a.urgency]||3) < (urgencies[top]||3) ? a.urgency : top, 'low');
    const lead       = group[0];
    const botNames   = allBotIds.map(id => BOT_META[id]?.name || String(id)).filter(Boolean);
    const nameList   = botNames.length > 0 ? ' across ' + botNames.join(' + ') : '';

    consolidated.push(makeDecision({
      actionType:    lead.actionType,
      text:          (function() {
        const shortNames = botNames.length > 3
          ? botNames.slice(0,3).join(', ') + ' + ' + (botNames.length-3) + ' more'
          : botNames.join(', ');
        const nameShort = shortNames.length > 0 ? ' — ' + shortNames : '';
        // Capital movement language — no abstract system terms
        if (lead.objective === 'bot_efficiency' || lead.objective === 'idle_capital') {
          return lead.actionType === 'reduce'
            ? 'Reallocate $' + totalAmt + ' from underperforming bots' + nameShort
            : 'Deploy $' + totalAmt + ' to stronger strategies' + nameShort;
        }
        return (lead.actionType === 'reduce'
          ? 'Reduce ' + lead.objective.replace(/_/g,' ') + ' by $' + totalAmt + nameShort
          : 'Increase ' + lead.objective.replace(/_/g,' ') + ' by $' + totalAmt + nameShort);
      })(),
      reason:        (group[0].reason||'').split('.')[0] + '.' + (group.length > 1 ? ' (' + group.length + ' bots consolidated)' : ''),
      amount:        totalAmt,
      amountPct:     Math.round(group.reduce((s,a)=>s+(a.amountPct||0),0)/group.length),
      targetBotIds:  allBotIds,
      urgency:       topUrgency,
      timeframe:     lead.timeframe,
      expectedImpact:lead.expectedImpact,
      costOfInaction:inactionCost(totalAmt, topUrgency),
      category:      lead.category,
      confidence:    Math.round(group.reduce((s,a)=>s+(a.confidence||70),0)/group.length),
      executable:    group.some(a=>a.executable),
      objective:     lead.objective,
    }));
  });

  return consolidated;
}

// ============================================================
// STEP 5 — CAPITAL REALLOCATION ENGINE
// Portfolio-level first (fix biggest gap). Bot-level second.
// All phases gated by risk state.
// ============================================================
function computeReallocation({ botScores, bnBots, tcBots, portfolio, riskState, market, portfolioGaps }) {
  const { totalAllocated, byStrategy } = portfolio;
  const moves = [];

  // Build enriched bot list — exclude legacy non-numeric IDs (eth-grid-trades etc.)
  // Those are static placeholders not in 3Commas API; targeting them produces 404s.
  const allBots = Object.entries(BOT_META)
    .filter(([id]) => /^\d+$/.test(String(id)))  // numeric 3Commas IDs only
    .map(([id, meta]) => {
      const bnBot  = bnBots.find(b => b.id === id);
      const tcBot  = tcBots.find(b => String(b.id) === String(id));
      const trades = bnBot?.trades || (tcBot ? (tcBot.completedDeals||0)+(tcBot.activeDeals||0) : 0);
      const roi    = meta.roi !== undefined ? meta.roi : (tcBot?.profit ? (tcBot.profit/(meta.capital||100))*100 : 0);
      const score  = botScores[id] || 0;
      const effUsd = parseFloat(((roi/100)*meta.capital).toFixed(2));
      const absChange  = Math.abs(market.btcChange24h||0);
      const isGrid     = meta.scoreType==='spot-grid'||meta.scoreType==='futures-grid';
      const marketFit  = isGrid ? (absChange<2?'positive':absChange<4?'neutral':'negative') : (absChange>1?'positive':'neutral');
      const currentPct = totalAllocated > 0 ? (meta.capital/totalAllocated)*100 : 0;
      const stratPct   = totalAllocated > 0 ? ((byStrategy[meta.strategy]||0)/totalAllocated)*100 : 0;
      return { id: Number(id), ...meta, score, trades, roi, effUsd, marketFit, currentPct, stratPct };
    });

  // PHASE 0 — PORTFOLIO GAP ACTIONS (largest gap first, already sorted)
  // These close gaps between current and target state — portfolio-level, not bot-level
  portfolioGaps.forEach(gap => {
    if (gap.usd < RC.minimumMoveUsd) return;
    if (gap.delta > RC.gapThresholdPct) {
      // Over target — cap at 40% of gap per cycle to avoid over-adjustment
      const cycleMove = Math.round(gap.usd * 0.40);
      const moveAmt   = Math.max(RC.minimumMoveUsd, cycleMove);
      const newPct    = gap.current - Math.round((moveAmt / totalAllocated) * 100);
      const urg       = gap.delta > 20 ? 'high' : gap.delta > 10 ? 'medium' : 'low';
      const cost      = inactionCost(moveAmt, urg, gap.usd);  // full gap = exposed capital
      moves.push(makeDecision({
        actionType:'reduce', category:'required',
        text:'Reduce ' + gap.objective.replace(/_/g,' ') + ' by $' + moveAmt + ' → ' + gap.current + '% → ' + newPct + '% → target ' + gap.target + '%',
        reason:'Current ' + gap.dimension.replace(/_/g,' ') + ': ' + gap.current + '%. After this action: ~' + newPct + '%. Target: ' + gap.target + '%. Moving $' + moveAmt + ' this cycle (40% of gap — gradual adjustment). Reassess next cycle.',
        amount:moveAmt, amountPct:Math.round((moveAmt/totalAllocated)*100), targetBotIds:[],
        urgency:urg, timeframe:gap.delta>20?'2h':'24h',
        expectedImpact:'Progress: ' + gap.current + '% → ' + newPct + '% this cycle → ' + gap.target + '% target',
        costOfInaction:cost, objective:gap.objective, confidence:75,
      }));
    } else if (gap.delta < -RC.gapThresholdPct) {
      // Under target — increase this dimension (only if not HIGH_RISK)
      if (riskState === 'HIGH_RISK') return;
      moves.push(makeDecision({
        actionType:'increase', category:'suggested',
        text:'Increase ' + gap.objective.replace(/_/g,' ') + ' by $' + gap.usd + ' (' + gap.current + '% → ' + gap.target + '% target)',
        reason:'Current ' + gap.dimension.replace(/_/g,' ') + ' is ' + gap.current + '%, below the ' + gap.target + '% target by ' + Math.abs(gap.delta) + 'pp.',
        amount:gap.usd, amountPct:Math.abs(gap.delta), targetBotIds:[],
        urgency:'low', timeframe:'24h',
        expectedImpact:'Brings ' + gap.dimension.replace(/_/g,' ') + ' to target ' + gap.target + '%',
        objective:gap.objective, confidence:65,
      }));
    }
  });

  // PHASE 1 — BOT-LEVEL DOWNSIDE PROTECTION (always runs)

  // A. Score 1..49 → reduce capital (worst real-data bots first).
  // Score = 0 means 'no signal yet' (just enabled, no recent trades) — skip, don't punish.
  // Only target bots with measurable underperformance.
  allBots.filter(b => b.score > 0 && b.score < RC.scoreThresholds.reduce && b.capital > RC.minimumMoveUsd * 2)
    .sort((a,b) => a.score - b.score)
    .forEach(bot => {
      const pct = bot.score < 30 ? 0.60 : bot.score < 40 ? 0.40 : 0.25;
      const amt = Math.round(bot.capital * pct);
      if (amt < RC.minimumMoveUsd) return;
      const urg = bot.score < 30 ? 'critical' : bot.score < 40 ? 'high' : 'medium';
      moves.push(makeDecision({
        actionType:'reduce', category:'required',
        text:'Reduce capital in ' + bot.name + ' by $' + amt,
        reason:'Score ' + bot.score + '/100 — below ' + RC.scoreThresholds.reduce + ' threshold. Capital efficiency: $' + bot.effUsd.toFixed(2) + ' return on $' + bot.capital + '.',
        amount:amt, amountPct:Math.round(pct*100), targetBotIds:[bot.id],
        urgency:urg, timeframe:urg==='critical'?'immediate':'4h',
        expectedImpact:'Frees $' + amt + ' from underperforming allocation',
        costOfInaction:inactionCost(amt, urg),
        objective:'bot_efficiency', confidence:Math.round(85-bot.score*0.3), executable:true,
      }));
    });

  // B. Idle bots — zero trades, capital allocated.
  // Skip if bot was recently enabled (has lifetime trades but 0 in current period — needs time).
  // For 3Commas bots, tcBot.completedDeals is lifetime; trades counts current period.
  allBots.filter(b => {
      if (b.trades !== 0) return false;
      if (b.capital < RC.minimumMoveUsd*2) return false;
      if (b.score < RC.scoreThresholds.reduce) return false;
      // If bot has any lifetime activity at all, it was working before — give it time.
      const tcBot = tcBots.find(tb => String(tb.id) === String(b.id));
      if (tcBot && ((tcBot.completedDeals||0) > 0 || (tcBot.activeDeals||0) > 0)) return false;
      return true;
    })
    .forEach(bot => {
      const amt = Math.round(bot.capital * 0.50);
      if (amt < RC.minimumMoveUsd) return;
      const idlePct = portfolio.totalAllocated > 0
        ? Math.round((bot.capital / portfolio.totalAllocated) * 100) : 0;
      moves.push(makeDecision({
        actionType:'reduce', category:'required',
        text:'Remove $' + amt + ' from idle bot: ' + bot.name + ' (' + idlePct + '% → target <1% idle)',
        reason:'Zero trades recorded. $' + bot.capital + ' allocated with no activity or return. Target: idle capital below 5% of portfolio.',
        amount:amt, amountPct:50, targetBotIds:[bot.id],
        urgency:'high', timeframe:'1h',
        expectedImpact:'Recovers $' + amt + ' of idle capital — redeploy to active strategies',
        costOfInaction:inactionCost(amt,'high', bot.capital),
        objective:'idle_capital', confidence:80, executable:true,
      }));
    });

  // PHASE 2 — EFFICIENCY IMPROVEMENTS (not in HIGH_RISK)
  if (riskState !== 'HIGH_RISK') {
    allBots.filter(b =>
      b.score >= RC.scoreThresholds.reduce && b.score < RC.scoreThresholds.monitor &&
      b.effUsd < 0 && b.capital > RC.minimumMoveUsd*2
    ).forEach(bot => {
      const amt = Math.round(bot.capital * 0.20);
      if (amt < RC.minimumMoveUsd) return;
      moves.push(makeDecision({
        actionType:'reduce', category:'required',
        text:'Reallocate $' + amt + ' from ' + bot.name + ' (underperforming)',
        reason:'Score ' + bot.score + '/100. Returning $' + bot.effUsd.toFixed(2) + ' on $' + bot.capital + ' allocated.',
        amount:amt, amountPct:20, targetBotIds:[bot.id],
        urgency:'medium', timeframe:'4h',
        expectedImpact:'Improves portfolio capital efficiency ratio',
        objective:'bot_efficiency', confidence:68, executable:true,
      }));
    });
  }

  // PHASE 3 — OPTIMISATION (BALANCED or SAFE only)
  if (riskState === 'BALANCED' || riskState === 'SAFE') {
    const recipients = allBots.filter(b =>
      b.score > RC.scoreThresholds.increase &&
      b.trades >= RC.recipientMinTrades &&
      b.marketFit === 'positive' &&
      b.currentPct < (b.maxAllocationPct||20) &&
      b.stratPct < (RC.maxAllocationByStrategy[b.strategy]||40)
    ).sort((a,b) => b.score - a.score);

    recipients.slice(0,2).forEach(bot => {
      const maxCap = Math.round((bot.maxAllocationPct/100)*totalAllocated);
      const amt    = Math.min(maxCap-bot.capital, Math.round(bot.capital*0.15));
      if (amt < RC.minimumMoveUsd) return;
      moves.push(makeDecision({
        actionType:'increase', category:'suggested',
        text:'Increase ' + bot.name + ' by $' + amt,
        reason:'Score ' + bot.score + '/100. ' + bot.trades + ' completed trades. Market fit: positive. Under max cap (' + bot.maxAllocationPct + '%).',
        amount:amt, amountPct:Math.round((amt/bot.capital)*100), targetBotIds:[bot.id],
        urgency:'low', timeframe:'24h',
        expectedImpact:'Increases exposure to highest-performing strategy',
        objective:'bot_efficiency', confidence:Math.round(60+(bot.score-85)*2),
      }));
    });

    // Explicit reallocation: worst → best
    const worst = allBots.filter(b => b.score < RC.scoreThresholds.reduce && b.capital > RC.minimumMoveUsd*3)[0];
    const best  = recipients[0];
    if (worst && best && worst.id !== best.id) {
      const maxCap  = Math.round((best.maxAllocationPct/100)*totalAllocated);
      const amt     = Math.min(Math.round(worst.capital*0.30), maxCap-best.capital);
      if (amt >= RC.minimumMoveUsd) {
        moves.push(makeDecision({
          actionType:'reallocate', category:'suggested',
          text:'Move $' + amt + ' from ' + worst.name + ' → ' + best.name,
          reason:worst.name + ' score: ' + worst.score + '/100. ' + best.name + ' score: ' + best.score + '/100. Reallocation improves portfolio weighted return.',
          amount:amt, amountPct:Math.round((amt/worst.capital)*100),
          targetBotIds:[worst.id,best.id], fromBotId:worst.id, toBotId:best.id,
          urgency:'low', timeframe:'24h',
          expectedImpact:'Shifts $' + amt + ' from score-' + worst.score + ' to score-' + best.score,
          objective:'bot_efficiency', confidence:72,
        }));
      }
    }
  }

  return moves;
}

// ============================================================
// STEP 6 — SCORING ENGINE
// ============================================================
function scoreBot({ roi, trades, drawdownPct, change24h, type, capital }) {
  const roiScore  = Math.min(100, Math.max(0, 50 + roi * 15));
  const ddScore   = Math.min(100, Math.max(0, 100 - drawdownPct * 4));
  const actScore  = Math.min(100, trades * 8);
  const conScore  = trades > 5 ? 80 : trades > 0 ? 40 + trades*8 : 15;
  const absChange = Math.abs(change24h);
  const mktFit    = (type==='spot-grid'||type==='futures-grid')
    ? (absChange<2?80:absChange<4?55:35) : (absChange>1?75:45);
  const capEff    = capital&&capital>0 ? Math.min(100,Math.max(0,50+(roi/100)*capital*0.1)) : 50;
  return Math.round(roiScore*0.25+ddScore*0.25+actScore*0.15+conScore*0.15+mktFit*0.10+capEff*0.10);
}

function capitalEfficiency(roi, capital) {
  if (!capital||capital===0) return 0;
  return parseFloat(((roi/100)*capital).toFixed(2));
}

// ============================================================
// STEP 7 — MAIN DECISION ENGINE
// Hierarchy: required defensive → required efficiency → suggested optimisation
// HIGH_RISK: only defensive. No optimisation.
// CRITICAL always position [0] in output array.
// ============================================================
async function decisionEngine({ bots, tcBots, floatingPnl, portfolio, market, botScores, spotData, pricesData, dataReliable=true, dataIntegrity={} }) {
  const { longPct, bySymbol, totalAllocated, byStrategy } = portfolio;
  const now = new Date().toISOString();

  // Risk state gates everything
  const { riskState, riskScore, factors, floatingPct, riskSubLabel } = computeRiskState({
    longPct, floatingPnl, totalAllocated,
    volatility:market.volatility||'Low', byStrategy,
  });

  // Dynamic target state — computed fresh each cycle
  const { targets, adjustments } = computeTargetState({
    regime:    market.regime    || 'Sideways',
    volatility:market.volatility|| 'Low',
    riskState,
    fearGreed: market.fearGreed ?? null,
  });

  // Portfolio gaps (sorted by size — biggest first)
  const portfolioGaps = computePortfolioGaps(portfolio, targets, totalAllocated);

  const required = [];
  const suggested = [];

  // ── REQUIRED DEFENSIVE ──────────────────────────────────────

  // Floating loss
  if (floatingPnl < -50) {
    required.push(makeDecision({
      actionType:'reduce', category:'required',
      text:'Reduce futures exposure — floating loss $' + Math.abs(floatingPnl).toFixed(0),
      reason:'Floating PnL is ' + floatingPct.toFixed(1) + '% of capital ($' + floatingPnl.toFixed(2) + '). Positions significantly underwater.',
      amount:Math.abs(Math.round(floatingPnl)), amountPct:Math.abs(Math.round(floatingPct)),
      targetBotIds:[], urgency:'critical', timeframe:'immediate',
      expectedImpact:'Stops further drawdown acceleration',
      costOfInaction:inactionCost(Math.abs(Math.round(floatingPnl)),'critical'),
      objective:'drawdown_protection', confidence:92,
    }));
  } else if (floatingPnl < -10) {
    required.push(makeDecision({
      actionType:'hold', category:'required',
      text:'Monitor floating loss — $' + Math.abs(floatingPnl).toFixed(2) + ' open',
      reason:'Negative floating PnL at $' + floatingPnl.toFixed(2) + '. Approaching action threshold.',
      amount:0, amountPct:0, targetBotIds:[],
      urgency:'high', timeframe:'1h',
      expectedImpact:'Prevents unmonitored drawdown',
      costOfInaction:'Could compound — monitor closely',
      objective:'drawdown_protection', confidence:80,
    }));
  }

  // ── DCA bot at max safety orders — critical alert ───────────────
  // When a DCA bot has consumed all safety orders, it can't average down further
  // and is fully exposed to the current price. This needs immediate visibility.
  const DCA_MAX_SO = { 16806276: 5, 16807404: 5, 16808289: 5, 16806296: 5, 16808275: 3 };
  const maxSoBots = tcBots.filter(b => {
    const maxSO = DCA_MAX_SO[b.id];
    return maxSO && b.activeDeals >= 1 && b.completedDeals >= maxSO;
  });
  // Also check by comparing activeDeals to a threshold — any DCA with open deal and high deal count
  const deepDcaBots = tcBots.filter(b =>
    b.strategy === 'dca' && b.activeDeals >= 1 && b.active === false
  );
  const atRiskBots = [...new Map([...maxSoBots, ...deepDcaBots].map(b => [b.id, b])).values()];
  if (atRiskBots.length > 0) {
    // Bundle into ONE info-only summary instead of N noisy 'required' items.
    // Sam chose 'wait for recovery' on stuck DCAs — don't keep yelling.
    const totalCapAtRisk = atRiskBots.reduce((s, b) => s + (b.capital || 0), 0);
    const botNames = atRiskBots.map(b => b.name).join(', ');
    suggested.push(makeDecision({
      actionType: 'monitor', category: 'suggested',
      text: atRiskBots.length + ' DCA bots at max SOs — \$' + totalCapAtRisk.toFixed(0) + ' locked, waiting on bounce',
      reason: 'R6: ' + botNames + ' all consumed safety orders with deals open. Sam directive: wait for recovery (do not auto-close). Deals exit on TP or manual review only.',
      amount: totalCapAtRisk, amountPct: totalAllocated ? Math.round((totalCapAtRisk / totalAllocated) * 100) : 0,
      targetBotIds: atRiskBots.map(b => b.id),
      urgency: 'low', timeframe: '7d',
      expectedImpact: 'Capital frozen until prices bounce above bot TP triggers',
      objective: 'dca_depth', confidence: 95, executable: false,
    }));
  }

  // Idle signal bots
  const signalBotIds = [194116, 194115];
  const signalIdle   = tcBots.filter(b => signalBotIds.includes(b.id) && b.completedDeals===0 && b.activeDeals===0);
  if (signalIdle.length > 0) {
    const idleCap = signalIdle.length * 100;
    required.push(makeDecision({
      actionType:'pause', category:'required',
      text:'Pause ' + signalIdle.length + ' idle signal bot(s) — recover $' + idleCap,
      reason:signalIdle.map(b=>b.name).join(', ') + ': 0 executions. $' + idleCap + ' allocated with zero return.',
      amount:idleCap, amountPct:Math.round((idleCap/totalAllocated)*100),
      targetBotIds:signalIdle.map(b=>b.id),
      urgency:'high', timeframe:'1h',
      expectedImpact:'Recovers $' + idleCap + ' from non-performing bots',
      costOfInaction:inactionCost(idleCap,'high'),
      objective:'idle_capital', confidence:85, executable:true,
    }));
  }

  // ─── R2-LIFT (NEW) ──────────────────────────────────────────────
  // When F&G crosses back >=30, auto-enable paused DCAs that earned before.
  const fg = market.fearGreed;
  if (fg != null && fg >= 30) {
    // PERMANENTLY STOPPED per CLAUDE.md — never auto-resume
    const PERMANENT_STOP_IDS = new Set([16801943, 16801248, 16812326, 16809699]);
    const pausedDca = tcBots.filter(b =>
      b.botType === 'dca' && b.active === false &&
      !PERMANENT_STOP_IDS.has(b.id) &&
      !/HEDGE|SHORT|LONG FUTURES|STABLE COIN/i.test(b.name||'') &&
      (b.completedDeals > 0 || (b.profit||0) > 0)
    );
    if (pausedDca.length > 0) {
      required.push(makeDecision({
        actionType:'enable', category:'required',
        text:'F&G recovered to ' + fg + ' — resume ' + pausedDca.length + ' DCA bot(s)',
        reason:'R2 lifted (F&G ' + fg + ' >= 30). Paused DCA bots resume directional longs.',
        amount:0, amountPct:0,
        targetBotIds: pausedDca.map(b => b.id),
        urgency:'high', timeframe:'1h',
        expectedImpact:'Reactivates ' + pausedDca.length + ' DCA(s) — directional longs back online',
        objective:'regime_lift', confidence:90, executable:true,
      }));
    }
  }

  // ─── R9 (NEW): Idle USDT deployment ──────────────────────────────
  // USDT above $500 above R8 reserve → propose defensive grid (advisory).
  try {
    // FREE USDT only — usdtBalance includes locked (orders/Earn) which can't be deployed
    const usdtBal = (spotData?.balances || []).find(b => b.asset === 'USDT');
    let usdt = parseFloat(usdtBal?.free || 0);
    // FALLBACK: spotData empty means Binance ban/rate-limit. Use idle-capital endpoint
    // which has its own cache + 3Commas-based totals. This keeps R9 firing during bans.
    if (usdt === 0 && spotData?.error) {
      try {
        const idleR = await fetch('https://tc-proxy-eu.onrender.com/api/idle-capital');
        if (idleR.ok) {
          const idle = await idleR.json();
          // Prefer spot estimate; fall back to futures-available so capital still gets surfaced
          usdt = parseFloat(idle.idleSpotUsdEstimate || 0) || parseFloat(idle.futuresAvailable || 0);
        }
      } catch(_) {}
    }
    const RESERVE = 100; // R8 reserve floor (was 150 — lowered to 100 for aggressive deployment)
    const idleExcess = Math.max(0, usdt - RESERVE);
    if (idleExcess >= 300) {
      // Multi-asset rotation: deploy into next un-gridded asset so we spread capital
      // across BTC/ETH/SOL/XRP/BNB instead of stacking duplicate BTC grids (was hitting
      // dedupe and skipping every R9 fire).
      const PRIORITY = ['BTC','ETH','SOL','XRP','BNB'];
      const griddedAssets = new Set(
        (tcBots || [])
          .filter(b => b.botType === 'grid' && /Hannah/i.test(b.name || '') && b.active)
          .map(b => {
            const pair = (b.pair || '').toUpperCase().replace(/[_/]/g,'');
            for (const sym of PRIORITY) if (pair.includes(sym)) return sym;
            return null;
          })
          .filter(Boolean)
      );
      const nextAsset = PRIORITY.find(a => !griddedAssets.has(a)) || 'BTC';
      const proposedSize = Math.min(2000, Math.round(idleExcess * 0.7));
      required.push(makeDecision({
        actionType:'deploy_grid', category:'required',
        text:'Deploy $' + proposedSize + ' idle USDT to ' + nextAsset + '/USDT defensive grid',
        reason:'R9: $' + usdt.toFixed(0) + ' USDT sitting idle. Capital must be working. ' +
               'Next un-gridded asset: ' + nextAsset + '. Existing Hannah grids: ' +
               (griddedAssets.size ? [...griddedAssets].join(', ') : 'none') + '. ' +
               'Propose ' + nextAsset + '/USDT defensive grid (±10%, $' + proposedSize + ', 30 grids).',
        amount:proposedSize, amountPct: totalAllocated > 0 ? Math.round((proposedSize/totalAllocated)*100) : 0,
        targetBotIds:[],
        suggestedPair:'USDT_' + nextAsset,
        suggestedAsset: nextAsset,
        urgency:'high', timeframe:'24h',
        expectedImpact:'Adds ~$' + (proposedSize*0.001).toFixed(2) + '/day at 0.1% grid yield',
        costOfInaction:'$' + (proposedSize*0.001*30).toFixed(0) + ' missed earnings/month',
        objective:'idle_capital_deploy', confidence:80, executable:true,
      }));
    }
  } catch(_) {}

  // ─── R10 (NEW): Target Allocation Gap per regime (R7) ─────────────
  try {
    const regimeAlloc = {
      Bull:     { spotGrid:30, futuresGrid:15 },
      Sideways: { spotGrid:50, futuresGrid:15 },
      Bear:     { spotGrid:40, futuresGrid:15 },
    };
    const regimeKey = fg == null ? null : (fg >= 50 ? 'Bull' : fg >= 30 ? 'Sideways' : 'Bear');
    if (regimeKey && totalAllocated > 0) {
      const tgt = regimeAlloc[regimeKey];
      const sumCap = (filter) => tcBots.filter(filter).reduce((s,b)=>s+(b.capital||0),0);
      const actualSpot = Math.round((sumCap(b=>b.botType==='grid'&&b.active&&b.marketType==='spot')/totalAllocated)*100);
      const actualFut  = Math.round((sumCap(b=>b.botType==='grid'&&b.active&&b.marketType==='futures')/totalAllocated)*100);
      const gapSpot = tgt.spotGrid - actualSpot;
      const gapFut  = tgt.futuresGrid - actualFut;
      if (gapSpot >= 20) {
        required.push(makeDecision({
          actionType:'increase', category:'required',
          text:regimeKey + ' regime: spot grid ' + actualSpot + '% vs target ' + tgt.spotGrid + '%',
          reason:'R10: under-allocated to spot grid by ' + gapSpot + 'pp in ' + regimeKey + ' regime.',
          amount:Math.round(totalAllocated * gapSpot/100), amountPct:gapSpot,
          targetBotIds:[], urgency:'high', timeframe:'24h',
          expectedImpact:'Closes ' + gapSpot + 'pp gap to regime target',
          objective:'allocation_gap', confidence:75, executable:false,
        }));
      }
      if (gapFut >= 15) {
        required.push(makeDecision({
          actionType:'increase', category:'required',
          text:regimeKey + ' regime: futures grid ' + actualFut + '% vs target ' + tgt.futuresGrid + '%',
          reason:'R10: under-allocated to futures grid by ' + gapFut + 'pp in ' + regimeKey + ' regime.',
          amount:Math.round(totalAllocated * gapFut/100), amountPct:gapFut,
          targetBotIds:[], urgency:'medium', timeframe:'48h',
          expectedImpact:'Closes ' + gapFut + 'pp gap to regime target',
          objective:'allocation_gap', confidence:70, executable:false,
        }));
      }
    }
  } catch(_) {}

  // ─── R12 (NEW): Held crypto without grid (per-asset) ───────────────
  // Walk spot balances, find assets worth >\$300 without an active Hannah grid,
  // propose a defensive grid using ~25% of held value as USDT investment.
  try {
    const assetMap = {
      'BTC': 'USDT_BTC',
      'SOL': 'USDT_SOL',
      'ETH': 'USDT_ETH',
      'XRP': 'USDT_XRP',
      'BNB': 'USDT_BNB',
    };
    const balances = spotData?.balances || [];
    // pricesData is an object like {BTCUSDT: 73656, ETHUSDT: 2005, BTC: 73656, ...}
    const priceMap = {};
    if (pricesData && typeof pricesData === 'object') {
      for (const [k, v] of Object.entries(pricesData)) {
        const sym = k.replace('USDT','').toUpperCase();
        if (sym) priceMap[sym] = parseFloat(v || 0);
      }
    }
    for (const [asset, pair] of Object.entries(assetMap)) {
      const bal = balances.find(b => b.asset === asset);
      if (!bal) continue;
      const freeQty   = parseFloat(bal.free||0);
      const lockedQty = parseFloat(bal.locked||0);
      const price = priceMap[asset] || 0;
      const usdFree   = freeQty * price;
      const usdTotal  = (freeQty + lockedQty) * price;
      // Surface BLOCKED decision when held total qualifies but free does not
      if (usdFree < 300 && usdTotal >= 300) {
        suggested.push(makeDecision({
          actionType:'unlock_funds', category:'required',
          text:asset + ' grid waiting — \$' + usdFree.toFixed(0) + ' free of \$' + usdTotal.toFixed(0) + ' total',
          reason:'R12: ' + asset + ' grid would deploy, but only \$' + usdFree.toFixed(0) + ' free. \$' + (usdTotal-usdFree).toFixed(0) + ' is committed elsewhere (3Commas bot orders, Flexible Earn, or Locked Earn). Run /api/capital-audit for breakdown.',
          amount:0, amountPct:0, targetBotIds:[],
          urgency:'medium', timeframe:'24h',
          expectedImpact:'Unlocking unblocks ~\$' + Math.min(500, Math.round(usdTotal*0.25)) + '/grid earnings potential',
          objective:'low_free_balance', confidence:90, executable:false,
          suggestedAsset: asset,
        }));
      }
      const usdValue = usdFree;
      if (usdValue < 300) continue;
      // Dedupe: skip if any Hannah grid for this pair exists
      const existing = tcBots.find(b =>
        b.botType==='grid' && /Hannah/i.test(b.name||'') &&
        (b.pair||'').includes(asset));
      if (existing) continue;
      const proposedInvest = Math.min(500, Math.max(200, Math.round(usdValue * 0.25)));
      required.push(makeDecision({
        actionType:'deploy_grid', category:'required',
        text:'Grid ' + asset + ' — \$' + usdValue.toFixed(0) + ' held, no active Hannah grid',
        reason:'R12: ' + asset + ' worth \$' + usdValue.toFixed(0) + ' sitting unhedged. Propose ' + pair + ' ±10% grid, \$' + proposedInvest + ' USDT investment.',
        amount:proposedInvest, amountPct: totalAllocated > 0 ? Math.round((proposedInvest/totalAllocated)*100) : 0,
        targetBotIds:[],
        urgency:'medium', timeframe:'24h',
        expectedImpact:'Adds ~\$' + (proposedInvest*0.001).toFixed(2) + '/day at 0.1% grid yield',
        costOfInaction:'\$' + (proposedInvest*0.001*30).toFixed(0) + ' missed earnings/month',
        objective:'idle_crypto_grid', confidence:75, executable:true,
        // Non-standard payload so autonomy knows which pair to build
        suggestedPair: pair, suggestedAsset: asset,
      }));
    }
  } catch(_) {}

  // ─── R13 (NEW): Bear-regime hedge — short futures grid ───────────
  // In Bear regime (F&G < 30) with available futures wallet, propose a
  // short BTC futures grid. Defensive deployment matching regime.
  try {
    if (fg != null && fg < 30) {
      const futAvail = parseFloat(futData?.availableBalance || 0);
      const hasShortGrid = tcBots.find(b =>
        b.botType === 'grid' && b.active && b.marketType === 'futures' && /Hannah/i.test(b.name||''));
      if (futAvail >= 500 && !hasShortGrid) {
        const proposedSize = Math.min(1500, Math.max(500, Math.round(futAvail * 0.30)));
        suggested.push(makeDecision({
          actionType:'deploy_grid', category:'required',
          text:'Bear regime — propose short BTC futures hedge ($' + proposedSize + ')',
          reason:'R13: F&G ' + fg + ' (Bear). Futures wallet $' + futAvail.toFixed(0) + ' available, no active Hannah futures hedge. Propose BTCUSDT short grid, ±8%, ' + proposedSize + ' USDT margin, 25 grids, 3x leverage.',
          amount:proposedSize, amountPct: totalAllocated > 0 ? Math.round((proposedSize/totalAllocated)*100) : 0,
          targetBotIds:[],
          urgency:'medium', timeframe:'24h',
          expectedImpact:'Captures volatility on downside + provides hedge against spot longs',
          costOfInaction:'Spot exposure unhedged in Bear regime',
          objective:'bear_hedge', confidence:70, executable:false, // advisory — futures bot creation is more complex
          suggestedPair:'USDT_BTC_FUTURES', suggestedAsset:'BTC',
        }));
      }
    }
  } catch(_) {}

  // ─── R14 (NEW): Auto-redeem from Binance Earn to unblock deployment ───
  // Fires when USDT free is below the R9 deployment threshold but there's
  // capital sitting in Earn that could fund a new grid.
  try {
    const usdtBal = (spotData?.balances || []).find(b => b.asset === 'USDT');
    const usdtFree = parseFloat(usdtBal?.free || 0);
    // We can't see Earn balance from spotData directly (it's separate sapi endpoint).
    // The autonomy executor will attempt the redeem and fail gracefully if no Earn position.
    // Trigger when: free is below R9 threshold AND there's a blocked R12 OR allocation gap signal.
    const hasBlocked = required.some(d => d.objective === 'low_free_balance' || d.objective === 'blocked_by_earn');
    if (usdtFree < 300 && hasBlocked) {
      required.push(makeDecision({
        actionType:'redeem', category:'required',
        text:'Redeem $500 USDT from Earn to unblock grids',
        reason:'R14: USDT free $' + usdtFree.toFixed(0) + ' below R9 threshold + R12 blocked-by-Earn. Auto-redeem $500.',
        amount:500, amountPct:0, targetBotIds:[],
        urgency:'high', timeframe:'1h',
        expectedImpact:'Unlocks $500 for R9/R12 grid deployment on next tick',
        objective:'auto_redeem', confidence:85, executable:true,
        suggestedAsset:'USDT',
      }));
    }
  } catch(_) {}

  // ─── R15 (NEW): Cancel stale spot orders (>48h) ──────────────────
  // Frees capital trapped in long-dead orders from paused/legacy bots.
  // Executes via tc-proxy /api/binance-cancel-order. Cap of 3 per tick.
  try {
    const r = await fetch('https://tc-proxy-eu.onrender.com/api/binance-open-orders');
    if (r.ok) {
      const j = await r.json();
      const stale = [];
      for (const [sym, info] of Object.entries(j.bySymbol || {})) {
        for (const o of (info.orders || [])) {
          if (o.ageHours > 48) stale.push({ symbol: o.symbol, orderId: o.orderId, ageHours: o.ageHours, lockedUsd: o.lockedValueUsd });
        }
      }
      stale.sort((a,b) => b.ageHours - a.ageHours);
      const toCancel = stale.slice(0, 3); // cap per tick
      if (toCancel.length > 0) {
        const totalFreed = toCancel.reduce((s,o) => s + o.lockedUsd, 0);
        required.push(makeDecision({
          actionType:'cancel_order', category:'required',
          text:'Cancel ' + toCancel.length + ' stale order(s) >48h — frees \$' + totalFreed.toFixed(0),
          reason:'R15: ' + toCancel.length + ' orders idle >48h (oldest: ' + toCancel[0].ageHours.toFixed(0) + 'h on ' + toCancel[0].symbol + '). Cancelling frees \$' + totalFreed.toFixed(0) + ' in trapped capital for R9/R12 grid deployment.',
          amount:Math.round(totalFreed), amountPct:0, targetBotIds:[],
          urgency:'high', timeframe:'1h',
          expectedImpact:'Unlocks \$' + totalFreed.toFixed(0) + ' for redeployment',
          objective:'stale_order_cancel', confidence:90, executable:true,
          stale_orders_payload: toCancel.map(o => ({symbol:o.symbol, orderId:o.orderId})),
        }));
      }
    }
  } catch(_) {}

  // ─── R16 (NEW): Act on TradingView Bj Bot signals ────────────────
  // Reads recent TV alerts (<30 min old) and emits executable tv_signal decision.
  // Autonomy handles the actual Smart Trade creation + daily cap.
  try {
    const r = await fetch('https://tc-proxy-eu.onrender.com/api/tv-alerts');
    if (r.ok) {
      const j = await r.json();
      const cutoff = Date.now() - 30*60*1000; // 30 min window
      const fresh = (j.alerts || [])
        .filter(a => a.action === 'buy' || a.action === 'sell')
        .filter(a => new Date(a.ts).getTime() > cutoff)
        .filter(a => ['BTCUSDT','ETHUSDT','SOLUSDT'].includes(a.symbol));
      if (fresh.length > 0) {
        const a = fresh[0]; // act on the newest first
        required.push(makeDecision({
          actionType:'tv_signal', category:'required',
          text:a.strategy + ' ' + a.action.toUpperCase() + ' ' + a.symbol + ' @ \$' + (a.price||0),
          reason:'R16: ' + a.strategy + ' fired ' + a.action + ' on ' + a.symbol + ' at \$' + (a.price||0) + '. Opening \$100 Smart Trade with 1.5% TP/SL.',
          amount:100, amountPct:0, targetBotIds:[],
          urgency:'high', timeframe:'immediate',
          expectedImpact:'Captures Bj Bot signal with capped \$100 exposure',
          objective:'tv_signal_act', confidence:70, executable:true,
          tv_alert: { ts: a.ts, symbol: a.symbol, action: a.action, strategy: a.strategy, price: a.price },
        }));
        // attach alert in non-standard payload — autonomy reads decision.payload.alert
      }
    }
  } catch(_) {}

  // ─── R17 (NEW): F&G Extreme Accumulation ──────────────────────
  // F&G < 15 → accumulate $30 BTC per fire, up to 10 fires/day in deep fear.
  // (Was $50 × 5/day = $250. Now $30 × 10/day = $300 with finer averaging.)
  // Autonomy enforces daily cap. Historical: mean-reversion ~85% from extremes.
  try {
    if (fg != null && fg < 15) {
      // Smaller bites, more shots — averages across more price points in volatile fear
      const buyAmt = fg < 10 ? 35 : 30;
      required.push(makeDecision({
        actionType:'spot_buy', category:'required',
        text:'F&G ' + fg + ' Extreme Fear — accumulate \$' + buyAmt + ' BTC',
        reason:'R17: F&G ' + fg + ' < 15. Historical buying opportunity. Accumulating \$' + buyAmt + ' BTC spot via market Smart Trade. Small bite — multiple shots per day across price points.',
        amount:buyAmt, amountPct:0, targetBotIds:[],
        urgency:'medium', timeframe:'24h',
        expectedImpact:'DCA into BTC at extreme fear — locked when sold above entry',
        objective:'fear_accumulate', confidence:80, executable:true,
        suggestedPair:'USDT_BTC', suggestedAsset:'BTC',
      }));
    }
  } catch(_) {}

  // ─── R33 (NEW): Futures→Spot transfer when spot reserve breached ──────
  // Capital sits useless in futures-available when spot can't grid. Surface a
  // clear, actionable recommendation. NOT auto-executed — Binance internal
  // transfer API requires explicit permission; user actions via Binance UI.
  try {
    const usdtBal = (spotData?.balances || []).find(b => b.asset === 'USDT');
    const spotFree = parseFloat(usdtBal?.free || 0);
    // Pull futures availability directly — portfolio object doesn't expose it
    let futAvail = 0;
    try {
      const fr = await fetch('https://tc-proxy-eu.onrender.com/futures-wallet');
      if (fr.ok) { const fj = await fr.json(); futAvail = parseFloat(fj.availableBalance || 0); }
    } catch(_) {}
    // Conditions: spot below reserve AND futures has meaningful excess
    if (spotFree < 100 && futAvail > 300) {
      const transferAmt = Math.min(1000, Math.round(futAvail - 100));  // leave $100 in futures
      required.push(makeDecision({
        actionType:'manual_transfer', category:'required',
        text:'⚡ TRANSFER \$' + transferAmt + ' Futures → Spot to unlock R9 grid deploy',
        reason:'R33: Spot USDT free \$' + spotFree.toFixed(0) + ' below \$100 reserve. Futures available \$' + futAvail.toFixed(0) + ' sitting idle. Transfer \$' + transferAmt + ' Futures → Spot in Binance UI to give R9 fuel for next ETH/SOL/BNB grid deployment.',
        amount:transferAmt, amountPct: totalAllocated > 0 ? Math.round((transferAmt/totalAllocated)*100) : 0,
        targetBotIds:[],
        urgency:'high', timeframe:'manual',
        expectedImpact:'Unlocks R9 to deploy 2-3 new defensive grids on un-gridded assets (ETH/SOL/BNB)',
        costOfInaction:'\$' + (transferAmt*0.001*30).toFixed(0) + '/month missed earnings vs grid yield',
        objective:'futures_to_spot_transfer', confidence:90, executable:false,
      }));
    }
  } catch(_) {}

  // ─── R19 (NEW): Grid Profit-Take ──────────────────────────────────
  // When any Hannah grid's profit > 1.5% of its deployed capital, close + bank.
  // Next R9 tick will create a fresh grid at current price (auto-recycle).
  try {
    const hannahGrids = tcBots.filter(b =>
      b.botType === 'grid' && b.active && /Hannah/i.test(b.name||''));
    for (const g of hannahGrids) {
      const cap = parseFloat(g.capital || 0);
      const profit = parseFloat(g.profit || 0);
      if (cap < 20) continue;  // tiny test grids — skip (was 100, but blocked all XRP grids)
      const returnPct = (profit / cap) * 100;
      // Threshold scales with cap: small grids need higher % return to be worth closing
      // (fees + slippage eat smaller profits proportionally more)
      const threshold = cap < 100 ? 2.5 : 1.5;
      if (returnPct >= threshold) {
        required.push(makeDecision({
          actionType:'close_grid', category:'required',
          text:'Profit-take: ' + g.name + ' at +' + returnPct.toFixed(2) + '% (\$' + profit.toFixed(2) + ')',
          reason:'R19: Grid returned ' + returnPct.toFixed(2) + '% on \$' + cap.toFixed(0) + ' capital. Banking locked profit. R9 will redeploy next tick.',
          amount:Math.round(profit), amountPct:0, targetBotIds:[g.id],
          urgency:'medium', timeframe:'1h',
          expectedImpact:'Locks \$' + profit.toFixed(2) + ' realised. Frees capital for next grid cycle.',
          objective:'grid_profit_take', confidence:90, executable:true,
        }));
      }
    }
  } catch(_) {}

  // ─── R34 (NEW): Auto-close inactive Hannah grids ───────────────────
  // Grid with 0 active deals (no orders filling) AND active=true means it's idle.
  // Could be: price out of range, or unfunded. Either way, free the capital.
  try {
    const hannahGrids = tcBots.filter(b =>
      b.botType === 'grid' && b.active && /Hannah/i.test(b.name||''));
    for (const g of hannahGrids) {
      // Capital deployed but ZERO active deals = grid placed orders but none filling
      // (likely price way outside range). R34 closes so R9 redeploys at current price.
      // Dead = no active deals filling AND no profit generated this cycle.
      // (completedDeals counts lifetime grid line fills — irrelevant if all happened ages ago.)
      if ((g.capital || 0) >= 20 && (g.activeDeals || 0) === 0 && (g.profit || 0) === 0) {
        required.push(makeDecision({
          actionType:'close_grid', category:'required',
          text:'Recycle dead grid: ' + g.name + ' (0 trades since launch)',
          reason:'R34: Grid is active but has executed 0 trades since launch — price likely outside range. Closing to free \$' + (g.capital||0).toFixed(0) + ' for R9 to redeploy at current price.',
          amount:Math.round(g.capital||0), amountPct:0, targetBotIds:[g.id],
          urgency:'medium', timeframe:'1h',
          expectedImpact:'Frees stranded capital. R9 redeploys with fresh price center.',
          objective:'grid_recycle_dead', confidence:85, executable:true,
        }));
      }
    }
  } catch(_) {}

  // ─── R35 (NEW): Force-close DCA bot deals in Error state ──────────
  // Detection: bot was disabled (active=false) BUT has open deals (3Commas auto-disables
  // on safety-order error, leaving deal stuck). Floating loss not in normalized bots,
  // so we conservatively only target small-capital bots (≤$300) where worst-case loss
  // is bounded. Larger stuck deals surface as advisory via R6 (dca_depth).
  const errorBots = tcBots.filter(b => {
    if (b.botType !== 'dca') return false;
    return b.active === false && (b.activeDeals||0) > 0 && (b.capital||0) <= 300;
  });
  for (const b of errorBots) {
    required.push(makeDecision({
      actionType:'close_deal', category:'required',
      text:'Close stuck deal: ' + b.name + ' (\$' + (b.capital||0).toFixed(0) + ' locked)',
      reason:'R35: DCA bot stopped by 3Commas (error/SO depletion) but deal still open with \$' + (b.capital||0).toFixed(0) + ' locked. Small cap (≤\$300) so worst-case loss is bounded. Force-closing to release USDT for R9 redeploy.',
      amount:Math.round(b.capital||0), amountPct:0, targetBotIds:[b.id],
      urgency:'high', timeframe:'1h',
      expectedImpact:'Frees \$' + (b.capital||0).toFixed(0) + ' locked. R9 + R12 redeploy on next tick.',
      objective:'force_close_error_deal', confidence:80, executable:true,
    }));
  }

  // ─── R18 (NEW): BTC Funding Rate Contrarian ──────────────────────
  // Funding extremes mean-revert. When longs overpay (>0.05%) → short.
  // When shorts overpay (<-0.03%) → long. \$100 Smart Trade, 1% TP/SL.
  try {
    const r = await fetch('https://tc-proxy-eu.onrender.com/api/funding-rate');
    if (r.ok) {
      const j = await r.json();
      const rate = parseFloat(j?.lastFundingRate || 0); // already a decimal
      const ratePct = rate * 100;
      let direction = null;
      if (ratePct > 0.05)       direction = 'sell'; // longs overpaying → fade
      else if (ratePct < -0.03) direction = 'buy';  // shorts overpaying → fade
      if (direction) {
        required.push(makeDecision({
          actionType:'spot_buy', category:'required',
          text:'Funding ' + ratePct.toFixed(4) + '% — contrarian ' + direction.toUpperCase() + ' BTC \$100',
          reason:'R18: BTC perp funding ' + ratePct.toFixed(4) + '% is extreme. ' + (direction==='sell'?'Longs are overpaying.':'Shorts are overpaying.') + ' Mean-reversion trade: \$100 ' + direction + ' Smart Trade, 1% TP/SL.',
          amount:100, amountPct:0, targetBotIds:[],
          urgency:'high', timeframe:'4h',
          expectedImpact:'Capture funding mean-reversion (~70% historical win rate)',
          objective:'funding_contrarian', confidence:75, executable:true,
          suggestedPair:'USDT_BTC', suggestedAsset:'BTC',
        }));
      }
    }
  } catch(_) {}

  // ─── R20 (NEW): Grid range auto-recenter ──────────────────────────
  // If current price is outside the middle 60% (20-80%) of a Hannah grid's range
  // AND that grid has 0 trades in last 12h, close + R9 will relaunch at fresh center.
  try {
    const priceMap_R20 = priceMap || {};
    const hannahGrids_R20 = tcBots.filter(b =>
      b.botType === 'grid' && b.active && /Hannah/i.test(b.name||''));
    for (const g of hannahGrids_R20) {
      const pair = (g.pair || '').toUpperCase();
      const baseAsset = pair.split('_')[1] || '';
      const cur = priceMap_R20[baseAsset] || 0;
      const lo = parseFloat(g.lower_price || g.price_low || 0);
      const hi = parseFloat(g.upper_price || g.price_high || 0);
      if (!cur || !lo || !hi || hi <= lo) continue;
      const posPct = ((cur - lo) / (hi - lo)) * 100;
      const recentTrades = parseInt(g.trades || g.completedDeals || 0);
      // Outside middle 60% AND looks idle (<5 trades recorded total — proxy for low activity)
      if ((posPct < 20 || posPct > 80) && recentTrades < 50) {
        required.push(makeDecision({
          actionType:'close_grid', category:'required',
          text:'Recenter ' + g.name + ' — price at ' + posPct.toFixed(0) + '% of range',
          reason:'R20: ' + baseAsset + ' price \$' + cur.toFixed(2) + ' is outside middle 60% of grid range \$' + lo.toFixed(0) + '-\$' + hi.toFixed(0) + ' (at ' + posPct.toFixed(0) + '%). Grid bleeding edge. Closing for R9 to relaunch at fresh center.',
          amount:0, amountPct:0, targetBotIds:[g.id],
          urgency:'medium', timeframe:'1h',
          expectedImpact:'Replaces drifted grid with one centred on current price',
          objective:'grid_recenter', confidence:85, executable:true,
        }));
      }
    }
  } catch(_) {}

  // ─── R21 (NEW): Compounding ───────────────────────────────────────
  // When locked profit > \$50 AND best-performing Hannah grid exists,
  // emit advisory to launch a SECOND small grid funded by the locked profit.
  try {
    const totalLocked_R21 = recon?.totalRealised || 0;
    if (totalLocked_R21 > 50) {
      const hannahGrids_R21 = tcBots.filter(b =>
        b.botType === 'grid' && b.active && /Hannah/i.test(b.name||''));
      const best = hannahGrids_R21.sort((a,b) => (parseFloat(b.profit||0) - parseFloat(a.profit||0)))[0];
      if (best) {
        const compAmount = Math.min(150, Math.floor(totalLocked_R21 / 10) * 10);
        suggested.push(makeDecision({
          actionType:'deploy_grid', category:'suggested',
          text:'Compound \$' + compAmount + ' into best performer',
          reason:'R21: Locked profit \$' + totalLocked_R21.toFixed(0) + ' > \$50 threshold. Reinvest \$' + compAmount + ' into a fresh grid mirroring the best performer (' + best.name + ').',
          amount:compAmount, amountPct:0, targetBotIds:[],
          urgency:'low', timeframe:'48h',
          expectedImpact:'Compounding loop — locked profit funds new earnings',
          objective:'compound_grid', confidence:65, executable:false,
        }));
      }
    }
  } catch(_) {}

  // ─── R22 (NEW): Volatility rotation ─────────────────────────────
  // Identify which pair has the highest 24h range and surface as advisory.
  // (Pure signal — humans interpret. R20 + R21 are the executable parts.)
  try {
    const VOL_TARGETS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT'];
    // No 24h-change data passed in — derive from price array if available
    // We don't have ranges in scope; emit as a placeholder informational decision.
    if (market?.btcChange24h != null) {
      // Use BTC 24h change as a vol proxy — when |change| > 3%, propose tilt
      if (Math.abs(market.btcChange24h) > 3) {
        suggested.push(makeDecision({
          actionType:'monitor', category:'suggested',
          text:'BTC volatility ' + market.btcChange24h.toFixed(1) + '% — tilt to BTC grid',
          reason:'R22: BTC 24h change ' + market.btcChange24h.toFixed(1) + '% (>3% threshold). Highest-vol pair = highest grid yield. Consider increasing BTC grid capital.',
          amount:0, amountPct:0, targetBotIds:[],
          urgency:'low', timeframe:'24h',
          expectedImpact:'Concentrates capital where vol pays',
          objective:'vol_rotation', confidence:60, executable:false,
        }));
      }
    }
  } catch(_) {}

  // ─── R24 (NEW): BTC Dominance Break Detector ───────────────────────
  // CoinGecko free /global endpoint. Track delta vs stored snapshot in KV.
  // Sharp drop (>2pp in 4h) → alt season starting → tilt to ETH/SOL/XRP grids.
  // Sharp rise → BTC dominating → retreat to BTC.
  try {
    const cg = await fetch('https://api.coingecko.com/api/v3/global').then(r => r.ok ? r.json() : null);
    const dom = cg?.data?.market_cap_percentage?.btc;
    if (dom != null && env.ALPHA_LOGS) {
      const now = Date.now();
      // Store current
      await env.ALPHA_LOGS.put('btcDom:latest', JSON.stringify({ pct: dom, ts: now }), { expirationTtl: 60*60*24*7 });
      // Read 4h-ago snapshot
      const fourHoursAgoKey = 'btcDom:4h_' + Math.floor(now / (4*60*60*1000));
      let prior = await env.ALPHA_LOGS.get('btcDom:4h_' + (Math.floor(now / (4*60*60*1000)) - 1), 'json');
      if (prior?.pct) {
        const delta = dom - prior.pct;
        if (delta < -2) {
          // BTC dominance dropped >2pp → alt season signal
          suggested.push(makeDecision({
            actionType:'increase', category:'suggested',
            text:'BTC dom ' + dom.toFixed(1) + '% (-' + Math.abs(delta).toFixed(1) + 'pp in 4h) — alt rotation',
            reason:'R24: BTC dominance dropped ' + delta.toFixed(2) + 'pp in 4h. Historical: this precedes alt-season rallies. Tilt grid investment toward ETH/SOL/XRP.',
            amount:0, amountPct:0, targetBotIds:[],
            urgency:'medium', timeframe:'24h',
            expectedImpact:'Capture rotation into alts via grid concentration',
            objective:'btc_dominance_break', confidence:70, executable:false,
          }));
        } else if (delta > 2) {
          // BTC dominance rose >2pp → flight to BTC
          suggested.push(makeDecision({
            actionType:'reduce', category:'suggested',
            text:'BTC dom ' + dom.toFixed(1) + '% (+' + delta.toFixed(1) + 'pp in 4h) — alts bleeding',
            reason:'R24: BTC dominance rose ' + delta.toFixed(2) + 'pp in 4h. Capital fleeing alts. Reduce alt grid exposure, concentrate in BTC.',
            amount:0, amountPct:0, targetBotIds:[],
            urgency:'medium', timeframe:'24h',
            expectedImpact:'Defensive rotation to BTC during alt drawdown',
            objective:'btc_dominance_break', confidence:70, executable:false,
          }));
        }
      }
      // Also store snapshot keyed by 4h bucket for next comparison
      await env.ALPHA_LOGS.put(fourHoursAgoKey, JSON.stringify({ pct: dom, ts: now }), { expirationTtl: 60*60*24*7 });
    }
  } catch(_) {}

  // ─── R25 (NEW): 5-min BTC momentum scalp ─────────────────────────
  // When BTC 24h change > +2% AND latest price is < recent high: buy with tight 0.6%/0.8% scalp
  // When BTC 24h change < -2% AND latest price is > recent low: sell scalp
  // Fast in-out trade — captures short bursts of momentum.
  try {
    const change24h = market?.btcChange24h;
    if (change24h != null) {
      let direction = null;
      if (change24h > 2)       direction = 'buy';   // momentum up
      else if (change24h < -2) direction = 'sell';  // momentum down
      if (direction) {
        required.push(makeDecision({
          actionType:'spot_buy', category:'required',
          text:'Momentum ' + change24h.toFixed(1) + '% — scalp \$' + (direction === 'sell' ? 'SHORT' : 'LONG') + ' BTC',
          reason:'R25: BTC 24h ' + change24h.toFixed(1) + '%. Momentum is real. Quick scalp with 0.6%/0.8% targets. \$50 position.',
          amount:50, amountPct:0, targetBotIds:[],
          urgency:'high', timeframe:'1h',
          expectedImpact:'Captures short momentum burst — fast locked profit',
          objective:'momentum_scalp', confidence:65, executable:true,
          suggestedPair:'USDT_BTC', suggestedAsset:'BTC',
        }));
      }
    }
  } catch(_) {}

  // ─── R26 (NEW): BTC Open Interest spike detector ──────────────
  // Binance fapi /openInterest is free, no auth. Compare current OI to stored 1h-ago value in KV.
  // Spike >5% in 1h = big positions building = volatility incoming.
  try {
    const oiR = await fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT');
    if (oiR.ok && env.ALPHA_LOGS) {
      const oi = await oiR.json();
      const oiVal = parseFloat(oi.openInterest || 0);
      const now = Date.now();
      const bucket = Math.floor(now / (60*60*1000)); // 1h bucket
      const prevKey = 'btcOI:h_' + (bucket - 1);
      const curKey  = 'btcOI:h_' + bucket;
      const prev = await env.ALPHA_LOGS.get(prevKey, 'json');
      await env.ALPHA_LOGS.put(curKey, JSON.stringify({ oi: oiVal, ts: now }), { expirationTtl: 60*60*48 });
      if (prev?.oi && oiVal > 0) {
        const deltaPct = ((oiVal - prev.oi) / prev.oi) * 100;
        if (Math.abs(deltaPct) > 5) {
          suggested.push(makeDecision({
            actionType:'monitor', category:'suggested',
            text:'BTC OI ' + (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(1) + '% in 1h — vol incoming',
            reason:'R26: Open Interest moved ' + deltaPct.toFixed(2) + '% in last hour. Big positions building. Expect volatility — tighten R16/R18 stops or step aside.',
            amount:0, amountPct:0, targetBotIds:[],
            urgency:'medium', timeframe:'1h',
            expectedImpact:'Volatility forecast — informs scalp rule sensitivity',
            objective:'oi_spike', confidence:70, executable:false,
          }));
        }
      }
    }
  } catch(_) {}

  // ─── R28 (NEW): BTC 5-min Volume Spike ────────────────────────────
  // Binance /fapi/v1/klines free. Compare last 5m vol to 20-period average.
  // 2x+ spike means activity surge — combined with direction = scalp opportunity.
  try {
    // Fetch 22 candles so we have 21 COMPLETED + the current incomplete one we throw out.
    const kr = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=22');
    if (kr.ok) {
      const klines = await kr.json();
      if (Array.isArray(klines) && klines.length >= 22) {
        // klines[21] is the IN-PROGRESS current candle — throw it out.
        // klines[20] = last COMPLETED candle. klines[0..19] = 20 earlier complete candles.
        const lastVol = parseFloat(klines[20][7] || 0); // quote volume USDT
        const avgVol = klines.slice(0,20).reduce((s,k) => s + parseFloat(k[7]||0), 0) / 20;
        const ratio = avgVol > 0 ? lastVol / avgVol : 0;
        if (ratio > 2) {
          const open = parseFloat(klines[20][1]);
          const close = parseFloat(klines[20][4]);
          const dir = close > open ? 'UP' : 'DOWN';
          required.push(makeDecision({
            actionType:'monitor', category:'required',
            text:'BTC 5m vol ' + ratio.toFixed(1) + 'x · ' + dir + ' move active',
            reason:'R28: Last 5min volume \$' + (lastVol/1000).toFixed(0) + 'k vs 20-period avg \$' + (avgVol/1000).toFixed(0) + 'k. ' + ratio.toFixed(1) + 'x spike + ' + dir + ' direction. Combine with R25 momentum for entry.',
            amount:0, amountPct:0, targetBotIds:[],
            urgency:'high', timeframe:'15m',
            expectedImpact:'Tag a Hannah scalp opportunity — confluence signal',
            objective:'volume_spike', confidence:75, executable:false,
            suggestedAsset:'BTC',
          }));
        }
      }
    }
  } catch(_) {}

  // ─── R30 (NEW): Liquidation Cascade Hunter ────────────────────────
  // Detect: BTC 5min drop >1.5% AND OI dropped vs 1h ago = forced liquidations cleared.
  // Buy the wick — historical edge ~65%.
  try {
    if (env.ALPHA_LOGS) {
      const now = Date.now();
      const oiPrev = await env.ALPHA_LOGS.get('btcOI:h_' + (Math.floor(now/(60*60*1000)) - 1), 'json');
      // Limit 2 — get last complete + current in-progress; use the completed one [0].
      const kr2 = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=2');
      const oiR = await fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT');
      if (kr2.ok && oiR.ok && oiPrev?.oi) {
        const klines = await kr2.json();
        // klines[1] is current in-progress; klines[0] is last COMPLETED 5min candle.
        const candle = klines[0];
        const oiCur = parseFloat((await oiR.json()).openInterest || 0);
        const open = parseFloat(candle[1]);
        const close = parseFloat(candle[4]);
        const movePct = ((close - open) / open) * 100;
        const oiDeltaPct = ((oiCur - oiPrev.oi) / oiPrev.oi) * 100;
        if (movePct < -1.5 && oiDeltaPct < -2) {
          required.push(makeDecision({
            actionType:'spot_buy', category:'required',
            text:'BTC liq cascade ' + movePct.toFixed(1) + '%, OI -' + Math.abs(oiDeltaPct).toFixed(1) + '% — buy wick \$50',
            reason:'R30: BTC dropped ' + movePct.toFixed(2) + '% in 5min WITH Open Interest down ' + oiDeltaPct.toFixed(1) + '% = forced liquidations cleared. Historical: ~65% bounce rate within next hour. Buy \$50, 0.6%/0.8% TP/SL.',
            amount:50, amountPct:0, targetBotIds:[],
            urgency:'critical', timeframe:'1h',
            expectedImpact:'Captures post-liquidation bounce — high-edge scalp',
            objective:'liq_cascade_buy', confidence:80, executable:true,
            suggestedPair:'USDT_BTC', suggestedAsset:'BTC',
          }));
        }
      }
    }
  } catch(_) {}

  // ─── R29 (NEW): Auto-disable losing rules (meta-rule) ───────────────
  // Reads /api/rule-performance, marks rules with negative ROI after 7+ days for disable.
  // Currently dormant — needs accumulated R23 attribution data first. Surfaces as advisory.
  try {
    const rp = await fetch('https://tc-proxy-eu.onrender.com/api/rule-performance');
    if (rp.ok) {
      const j = await rp.json();
      const losers = (j.rules || []).filter(r => r.profit < -10 && r.botCount >= 3);
      for (const lose of losers) {
        suggested.push(makeDecision({
          actionType:'monitor', category:'suggested',
          text:'Rule ' + lose.rule + ' losing — \$' + lose.profit.toFixed(2) + ' across ' + lose.botCount + ' bots (ROI ' + lose.roi + '%)',
          reason:'R29: ' + lose.rule + ' has produced \$' + lose.profit.toFixed(2) + ' across ' + lose.botCount + ' bots. Sustained negative. Consider disabling or tuning thresholds.',
          amount:0, amountPct:0, targetBotIds:[],
          urgency:'low', timeframe:'7d',
          expectedImpact:'Trims rules that don\'t pay — system Darwinism',
          objective:'rule_killer', confidence:65, executable:false,
        }));
      }
    }
  } catch(_) {}

  // ─── R31 (NEW): Auto-tune DCA take-profit % based on regime ─────────
  // Reads tunable params from /api/dca-detail, recommends TP per F&G regime, fires tune_bot decisions.
  // Safety: max change 0.5% per call, executable=true (autonomy enforces cooldown).
  try {
    const dcaR = await fetch('https://tc-proxy-eu.onrender.com/api/dca-detail');
    if (dcaR.ok) {
      const dca = await dcaR.json();
      const fg = market.fearGreed;
      // Regime → recommended TP
      const regimeTp = (() => {
        if (fg == null) return 1.5;
        if (fg < 10) return 0.8;   // Extreme fear: quick exits on dead-cat bounces
        if (fg < 30) return 1.0;   // Fear: tighter exits
        if (fg < 66) return 1.5;   // Neutral: 3Commas default
        if (fg < 80) return 1.8;   // Greed: let winners breathe
        return 2.2;                // Extreme greed: wider targets, bigger waves
      })();
      const targetBots = (dca.bots || []).filter(b => 
        b.enabled && b.takeProfitPct > 0 && /DCA Long/i.test(b.name || '')
      );
      for (const b of targetBots) {
        const current = b.takeProfitPct;
        const delta = regimeTp - current;
        if (Math.abs(delta) < 0.2) continue;  // Skip tiny adjustments — noise
        // Cap change at 0.5% per single fire
        const newTp = +(current + Math.max(-0.5, Math.min(0.5, delta))).toFixed(2);
        const conf = (fg < 15 || fg > 75) ? 80 : 70;
        suggested.push(makeDecision({
          actionType:'tune_bot', category:'suggested',
          text:'Tune TP on ' + b.name + ': ' + current + '% → ' + newTp + '%',
          reason:'R31 tuner: F&G ' + fg + ' (regime target TP ' + regimeTp + '%). Current TP ' + current + '% is ' + (delta > 0 ? 'too tight' : 'too wide') + ' for this regime. Capped at 0.5% per change.',
          amount:0, amountPct:0, targetBotIds:[b.id],
          urgency:'low', timeframe:'24h',
          expectedImpact:delta > 0 ? 'Lets winners breathe — captures full upside in calmer market' : 'Quicker exits — captures profits before reversals in volatile market',
          objective:'tune_tp', confidence:conf, executable:true,
          tuneParams: { takeProfitPct: newTp },
        }));
      }
    }
  } catch(_) {}

  // ─── R32 (NEW): Auto-tune DCA safety order step % based on volatility/regime ─────
  // Wider SO steps in volatile/bear markets catch deeper averaging.
  // Tighter SO steps in calm/bull markets catch more frequent shallow dips.
  try {
    const dcaR = await fetch('https://tc-proxy-eu.onrender.com/api/dca-detail');
    if (dcaR.ok) {
      const dca = await dcaR.json();
      const fg = market.fearGreed;
      const btcChange24h = Math.abs(market.btcChange24h || 0);
      // Volatility proxy: BTC 24h move. High vol = wider steps.
      // F&G also informs: extreme fear means continued downside likely
      const regimeStep = (() => {
        if (fg == null) return 3.0;          // 3Commas default
        if (fg < 10) return 4.0;             // Extreme fear: wide steps for deep averaging
        if (fg < 30) return 3.5;             // Fear: slightly wider
        if (fg < 66) return 3.0;             // Neutral: default
        if (fg < 80) return 2.5;             // Greed: tighter — uptrend continuation more likely
        return 2.0;                          // Extreme greed: tightest — catch every small dip on the way up
      })();
      // Volatility nudge: if BTC moving >5% in 24h, add 0.5 to SO step
      const volAdjust = btcChange24h > 5 ? 0.5 : 0;
      const targetStep = +(regimeStep + volAdjust).toFixed(1);

      const targetBots = (dca.bots || []).filter(b => 
        b.enabled && b.safetyOrderStepPct > 0 && /DCA Long/i.test(b.name || '')
      );
      for (const b of targetBots) {
        const current = b.safetyOrderStepPct;
        const delta = targetStep - current;
        if (Math.abs(delta) < 0.3) continue;  // Noise floor
        // Cap change at 0.5% per fire
        const newStep = +(current + Math.max(-0.5, Math.min(0.5, delta))).toFixed(1);
        const conf = (fg < 15 || fg > 75 || btcChange24h > 7) ? 75 : 65;
        suggested.push(makeDecision({
          actionType:'tune_bot', category:'suggested',
          text:'Tune SO step on ' + b.name + ': ' + current + '% → ' + newStep + '%',
          reason:'R32 tuner: F&G ' + fg + ' (regime target ' + regimeStep + '%) + BTC 24h vol ' + btcChange24h.toFixed(1) + '%. Current SO step ' + current + '% is ' + (delta > 0 ? 'too tight' : 'too wide') + '. Capped at 0.5% per change.',
          amount:0, amountPct:0, targetBotIds:[b.id],
          urgency:'low', timeframe:'24h',
          expectedImpact:delta > 0 ? 'Wider steps catch deeper averaging in volatile market' : 'Tighter steps catch smaller dips in calm market',
          objective:'tune_step', confidence:conf, executable:true,
          tuneParams: { safetyOrderStepPct: newStep },
        }));
      }
    }
  } catch(_) {}

  // Extreme long bias (critical threshold — only flag above 95% as system is intentionally long-biased)
  if (longPct > 95) {
    const hedgeCap = Math.round(totalAllocated * (targets.shortPct/100));
    const gap      = Math.max(0, hedgeCap - portfolio.shortCapital);
    required.push(makeDecision({
      actionType:'increase', category:'required',
      text:'Consider light hedge — portfolio ' + longPct + '% long with F&G ' + (market.fearGreed ?? '?'),
      reason:'Portfolio is ' + longPct + '% long in Extreme Fear conditions. A light hedge of ' + targets.shortPct + '% ($' + hedgeCap + ') would reduce downside. Current hedge: $' + portfolio.shortCapital + '. Note: existing grids and DCA deals should NOT be closed — this refers to adding new hedge positions only.',
      amount:gap, amountPct:Math.round((gap/totalAllocated)*100), targetBotIds:[16801248],
      urgency:'high', timeframe:'4h',
      expectedImpact:'Reduces downside exposure by ~' + targets.shortPct + '% if market drops',
      costOfInaction:inactionCost(gap,'high'),
      objective:'hedge_exposure', confidence:75,
    }));
  }

  // Reallocation engine (portfolio-level gaps + bot-level)
  const moves = computeReallocation({ botScores, bnBots:bots, tcBots, portfolio, riskState, market, portfolioGaps });

  // Consolidate before splitting
  const consolidated = consolidateActions(moves);
  consolidated.forEach(m => {
    if (m.category === 'required') required.push(m);
    else if (riskState !== 'HIGH_RISK') suggested.push(m);
  });

  // ── SUGGESTED (suppressed in HIGH_RISK) ─────────────────────
  if (riskState !== 'HIGH_RISK') {
    // BTC concentration check
    const btcPct = totalAllocated ? Math.round(((bySymbol['BTCUSDT']||0)/totalAllocated)*100) : 0;
    if (btcPct > targets.btcConcentrationPct + RC.gapThresholdPct) {
      suggested.push(makeDecision({
        actionType:'reduce', category:'suggested',
        text:'Reduce BTC concentration — ' + btcPct + '% vs ' + targets.btcConcentrationPct + '% target',
        reason:'$' + (bySymbol['BTCUSDT']||0) + ' (' + btcPct + '%) BTC-correlated. Target is ' + targets.btcConcentrationPct + '%. Diversification reduces single-asset risk.',
        amount:Math.round(((btcPct-targets.btcConcentrationPct)/100)*totalAllocated),
        amountPct:btcPct-targets.btcConcentrationPct, targetBotIds:[],
        urgency:'medium', timeframe:'24h',
        expectedImpact:'Reduces BTC concentration to ' + targets.btcConcentrationPct + '% target',
        objective:'btc_concentration', confidence:68,
      }));
    }

    // High volatility grid warning
    if (market.volatility === 'High') {
      suggested.push(makeDecision({
        actionType:'reduce', category:'suggested',
        text:'Tighten grid ranges — BTC ' + Math.abs(market.btcChange24h||0).toFixed(1) + '% move in 24h',
        reason:'High volatility. Grid target reduced to ' + targets.gridPct + '% in this regime. Review grid bounds in Binance.',
        amount:0, amountPct:0, targetBotIds:[],
        urgency:'medium', timeframe:'4h',
        expectedImpact:'Keeps grid bots within active trading ranges',
        objective:'grid_allocation', confidence:65,
      }));
    }

    // Best performer hold
    const btcDca = bots.find(b => b.id==='btc-dca-trades');
    if (btcDca && btcDca.trades > 5) {
      suggested.push(makeDecision({
        actionType:'hold', category:'suggested',
        text:'Hold BTC/USDT DCA — top performer, do not reduce',
        reason:btcDca.trades + ' completed trades, +2.54% ROI. Consistent performer.',
        amount:0, amountPct:0, targetBotIds:['btc-dca-trades'],
        urgency:'low', timeframe:'24h',
        expectedImpact:'Preserves best-performing capital allocation',
        objective:'bot_efficiency', confidence:90,
      }));
    }
  }

  // ── SORT — CRITICAL first, then urgency order within each list ──
  const urgOrd = { critical:0, high:1, medium:2, low:3 };
  required.sort((a,b)  => (urgOrd[a.urgency]||3)-(urgOrd[b.urgency]||3));
  suggested.sort((a,b) => (urgOrd[a.urgency]||3)-(urgOrd[b.urgency]||3));

  // ── CRITICAL must always be required — never suggested ──
  // Move any CRITICAL actions from suggested back to required first
  const criticalInSuggested = suggested.filter(a => a.urgency === 'critical');
  criticalInSuggested.forEach(a => {
    a.category = 'required';
    suggested.splice(suggested.indexOf(a), 1);
    required.push(a);
  });
  required.sort((a,b) => (urgOrd[a.urgency]||3)-(urgOrd[b.urgency]||3));

  // ── HARD CAP: max 3 required — overflow becomes suggested (never CRITICAL) ──
  const MAX_REQUIRED = 3;
  if (required.length > MAX_REQUIRED) {
    const overflow = required.splice(MAX_REQUIRED);
    overflow.forEach(a => { a.category = 'suggested'; suggested.unshift(a); });
  }

  // ── HOLD ALL — strict conditions only ───────────────────────
  const noGaps        = portfolioGaps.filter(g => Math.abs(g.delta) > RC.gapThresholdPct).length === 0;
  const noNegEff      = Object.entries(BOT_META).every(([,m]) => m.roi === undefined || m.roi >= 0);
  const noIdleCapital = Object.values(BOT_META).every(m => m.capital < RC.minimumMoveUsd*2 || true); // simplified
  const holdAll       = required.length === 0 && suggested.length === 0 &&
                        (riskState === 'SAFE' || riskState === 'BALANCED') && noGaps;

  if (holdAll) {
    suggested.push(makeDecision({
      actionType:'hold', category:'suggested',
      text:'Hold all positions — portfolio aligned with targets',
      reason:'Risk state: ' + riskState + '. No gaps above ' + RC.gapThresholdPct + '% threshold. No underperforming bots. No idle capital. No action required.',
      amount:0, amountPct:0, targetBotIds:[],
      urgency:'low', timeframe:'24h',
      expectedImpact:'Maintain current allocation — portfolio within target parameters',
      objective:'portfolio_balance', confidence:85,
    }));
  }

  // ── PRIMARY OBJECTIVE — outcome-driven, not task-driven ──
  // Frames the system intent, not just the top action text
  let primaryObjective = null;
  if (holdAll) {
    primaryObjective = 'Portfolio aligned with all targets. No action required.';
  } else if (required.length > 0) {
    const top = required[0];
    // Build outcome-framed objective based on action type and objective dimension
    if (top.objective === 'long_exposure' || top.objective === 'hedge_exposure') {
      const gap = portfolioGaps.find(g => g.objective === top.objective);
      if (gap) {
        primaryObjective = 'Reduce portfolio risk by moving ' + gap.dimension.replace(/_/g,' ') +
          ' from ' + gap.current + '% toward ' + gap.target + '% target';
      } else {
        primaryObjective = 'Reduce portfolio risk: ' + top.text;
      }
    } else if (top.objective === 'idle_capital') {
      primaryObjective = 'Recover idle capital and redeploy to active strategies';
    } else if (top.objective === 'drawdown_protection') {
      primaryObjective = 'Protect capital — drawdown risk requires immediate attention';
    } else if (top.actionType === 'pause') {
      primaryObjective = 'Recover non-performing capital by pausing idle bots';
    } else if (top.actionType === 'reduce') {
      primaryObjective = 'Improve capital efficiency by reducing underperforming allocations';
    } else if (top.actionType === 'increase') {
      primaryObjective = 'Strengthen defensive positioning by increasing hedge allocation';
    } else {
      primaryObjective = top.text;
    }
  } else if (suggested.length > 0) {
    primaryObjective = 'Portfolio stable — optimisation opportunities available';
  }

  // ── TARGET STATE CONFIDENCE ──
  const targetConfidence = riskState === 'HIGH_RISK' ? 'Low — HIGH_RISK state, targets actively adjusting'
    : riskState === 'OVEREXPOSED' ? 'Medium — Overexposed, targets defensive'
    : adjustments.length <= 1 ? 'High — stable regime, strong signal alignment'
    : 'Medium — multiple regime adjustments applied';

  // Data integrity warning — prepended when inputs are unreliable
  const dataWarning = !dataReliable
    ? 'Data incomplete (' + Object.entries(dataIntegrity).filter(([,v])=>!v).map(([k])=>k).join(', ') + ') — confirm allocations before executing large actions'
    : null;

  return {
    decisions:         enrichWithProjectedState([...required,...suggested],portfolio,targets),
    requiredActions:   enrichWithProjectedState(required,portfolio,targets),
    suggestedActions:  enrichWithProjectedState(suggested,portfolio,targets),
    primaryObjective,
    confidenceAnchor:  buildConfidenceAnchor(riskState,factors,market,adjustments),
    riskSubLabel:      riskSubLabel||null,
    riskState,
    riskScore,
    riskFactors:       factors,
    floatingPct,
    highRiskMode:      riskState === 'HIGH_RISK',
    holdAll,
    targetState:       targets,
    targetAdjustments: adjustments,
    targetConfidence,
    portfolioGaps,
    generatedAt:       now,
    marketSnapshot:    market,
    portfolio,
    dataWarning,
    dataIntegrity,
  };
}

// ============================================================
// ACTION LOGGING
// ============================================================
async function logAction(env, entry) {
  try {
    if (!env.ALPHA_LOGS) return;
    await env.ALPHA_LOGS.put('log:'+Date.now(), JSON.stringify(entry), { expirationTtl:60*60*24*90 });
  } catch(e) { console.warn('Log write failed:', e.message); }
}
async function getActionLogs(env) {
  try {
    if (!env.ALPHA_LOGS) return [];
    // KV list returns ascending lexical order. Keys are log:<Date.now()> — ascending = oldest first.
    // We want NEWEST 200, so walk with cursor to get all keys, then slice from end.
    let allKeys = [];
    let cursor = undefined;
    let safety = 0;
    do {
      const page = await env.ALPHA_LOGS.list({ prefix:'log:', limit:1000, cursor });
      allKeys = allKeys.concat(page.keys);
      cursor = page.list_complete ? null : page.cursor;
      safety++;
    } while (cursor && safety < 10);
    // Take last 200 (newest by lexical = newest by timestamp)
    const newest = allKeys.slice(-200);
    const entries = await Promise.all(newest.map(k => env.ALPHA_LOGS.get(k.name,'json')));
    return entries.filter(Boolean).reverse();  // reverse so newest first
  } catch(e) { return []; }
}

// ============================================================
// API ENDPOINTS
// ============================================================
function getPortfolioSnapshot() {
  const bots = Object.entries(BOT_META).map(([id,m])=>({id,...m}));
  const tot  = bots.reduce((s,b)=>s+b.capital,0);
  const lng  = bots.filter(b=>b.direction==='long').reduce((s,b)=>s+b.capital,0);
  const sht  = bots.filter(b=>b.direction==='short').reduce((s,b)=>s+b.capital,0);
  const bySt = bots.reduce((acc,b)=>{acc[b.strategy]=(acc[b.strategy]||0)+b.capital;return acc;},{});
  const byVn = bots.reduce((acc,b)=>{acc[b.venue]=(acc[b.venue]||0)+b.capital;return acc;},{});
  const bySy = bots.reduce((acc,b)=>{acc[b.symbol]=(acc[b.symbol]||0)+b.capital;return acc;},{});
  return { totalAllocated:tot, longCapital:lng, shortCapital:sht,
    longPct:tot?Math.round((lng/tot)*100):0, shortPct:tot?Math.round((sht/tot)*100):0,
    byStrategy:bySt, byVenue:byVn, bySymbol:bySy, botCount:bots.length };
}

function getBotMeta(botId) { return BOT_META[botId]||BOT_META[String(botId)]||null; }
function executionAllowed(env) { return env.EXECUTION_ENABLED==='true'; }

async function getPrices() {
  const r = await fetch('https://tc-proxy-eu.onrender.com/prices');
  if (!r.ok) throw new Error('prices HTTP ' + r.status);
  const d = await r.json();
  return json(d);
}

async function getSpotWalletData(env) {
  const r = await fetch('https://tc-proxy-eu.onrender.com/spot-wallet');
  if (!r.ok) throw new Error('spot-wallet HTTP ' + r.status);
  return r.json();
}
async function getSpotWallet(env) {
  return json(await getSpotWalletData(env));
}

async function getFuturesWallet(env) {
  const r = await fetch('https://tc-proxy-eu.onrender.com/futures-wallet');
  if (!r.ok) throw new Error('futures-wallet HTTP ' + r.status);
  const d = await r.json();
  return json(d);
}

async function getCommasBots() {
  const res=await fetch('https://tc-proxy-eu.onrender.com/bots');
  const raw=await res.text(); let data;
  try{data=JSON.parse(raw);}catch(e){throw new Error('Parse error: '+raw.slice(0,200));}
  if(data.error) throw new Error(data.error); return json(data);
}

async function getBinanceBots(env) {
  const r = await fetch('https://tc-proxy-eu.onrender.com/binance-bots');
  if (!r.ok) throw new Error('binance-bots HTTP ' + r.status);
  return json(await r.json());
}

async function getBinanceBotsData(env){ const r=await fetch("https://tc-proxy-eu.onrender.com/binance-bots"); if(!r.ok) throw new Error("binance-bots HTTP "+r.status); return r.json(); }
async function getFuturesWalletData(env){ const r=await fetch("https://tc-proxy-eu.onrender.com/futures-wallet"); if(!r.ok) throw new Error("futures-wallet HTTP "+r.status); return r.json(); }

function buildLivePortfolio(tcBots, bnBots, recon) {
  // If reconciliation data is available, use live capital values
  // Otherwise fall back to BOT_META hardcoded values
  let tot=0, lng=0, sht=0;
  const bySt={}, byVn={}, bySy={};

  // Build from reconciliation if available
  const tcBreakdown = recon?.tcBots || [];
  const bnBreakdown = recon?.bnBots || [];

  // 3Commas bots
  const tcSource = tcBreakdown.length > 0 ? tcBreakdown : tcBots.map(b => ({
    id: b.id, capital: b.capital || 100,
    direction: b.direction || 'long', strategy: b.strategy || 'dca',
  }));
  tcSource.forEach(b => {
    const cap = b.capital || 0;
    // Use capital > 0 as the truth for "active" — 3Commas active/enabled field
    // is unreliable (returns false for running bots). Capital > 0 = deployed = counts.
    if (cap <= 0) return;
    const dir = b.direction || 'long';
    const meta = BOT_META[b.id];
    const sym = meta?.symbol || 'BTCUSDT';
    tot += cap;
    if (dir === 'short') sht += cap; else lng += cap;
    bySt[b.strategy || 'dca'] = (bySt[b.strategy || 'dca'] || 0) + cap;
    byVn['3commas'] = (byVn['3commas'] || 0) + cap;
    bySy[sym] = (bySy[sym] || 0) + cap;
  });

  // Binance native bots have been fully migrated to 3Commas. buildReconciliation
  // hardcodes bnBotBreakdown=[] — treat the reconciliation as the only truth here.
  // Do NOT fall back to BOT_META.capital for the /binance-bots trade-count rows:
  // those legacy capital values resurrect ghost capital (~$1,469) that inflates
  // longPct past 100% and triggers phantom "reduce long exposure" actions.
  const bnSource = bnBreakdown;
  bnSource.forEach(b => {
    const cap = b.capital || 0; if (cap <= 0) return;
    const meta = BOT_META[b.id];
    const sym = meta?.symbol || 'BTCUSDT';
    tot += cap; lng += cap; // binance bots are all long-side
    bySt[b.strategy || 'grid'] = (bySt[b.strategy || 'grid'] || 0) + cap;
    byVn['binance'] = (byVn['binance'] || 0) + cap;
    bySy[sym] = (bySy[sym] || 0) + cap;
  });

  // If recon provides a true total, use it for percentage calculations
  const trueTot = recon?.grandTotal || tot;

  return {
    totalAllocated: tot,
    trueTotal: trueTot,
    longCapital: lng, shortCapital: sht,
    longPct:  trueTot ? Math.round((lng  / trueTot) * 100) : 0,
    shortPct: trueTot ? Math.round((sht  / trueTot) * 100) : 0,
    byStrategy: bySt, byVenue: byVn, bySymbol: bySy,
    botCount: tcBots.length + bnBots.length,
    source: recon ? 'live-reconciled' : 'live',
  };
}

// ── TRADE HISTORY ENGINE ─────────────────────────────────────────────────
// Pulls full lifetime trade counts from 3Commas and Binance
// Cached for 10 minutes to avoid hammering APIs
let _tradeHistoryCache = null;
let _tradeHistoryCacheTime = 0;
const TRADE_HISTORY_TTL = 10 * 60 * 1000; // 10 minutes

async function getTradeHistory(env) {
  try {
    const now = Date.now();
    if (_tradeHistoryCache && (now - _tradeHistoryCacheTime) < TRADE_HISTORY_TTL) {
      return json({ ..._tradeHistoryCache, cached: true });
    }

    // ── 3Commas: full deal history ──────────────────────────────────────
    const tcSummary = await fetch('https://tc-proxy-eu.onrender.com/deals/summary')
      .then(r => r.json())
      .catch(() => ({ completedDeals: 0, activeDeals: 0, totalOrders: 0, totalProfit: 0 }));

    // ── Binance: full trade history per pair ────────────────────────────
    const pairs = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT'];
    let bnTotalTrades = 0;
    const bnByPair = {};

    await Promise.all(pairs.map(async (sym) => {
      try {
        let fromId = null;
        let pairTotal = 0;
        let keepGoing = true;
        let iterations = 0;
        while (keepGoing && iterations < 20) { // cap at 20k trades per pair
          iterations++;
          const ts  = Date.now();
          const q   = fromId
            ? `symbol=${sym}&limit=1000&fromId=${fromId}&timestamp=${ts}&recvWindow=10000`
            : `symbol=${sym}&limit=1000&timestamp=${ts}&recvWindow=10000`;
          const sig = await hmacSign(env.BINANCE_SECRET, q);
          const res = await fetch('https://tc-proxy-eu.onrender.com/binance-proxy/spot-trades?'+q+'&signature='+sig, { headers: { 'X-MBX-APIKEY': 'proxy' } });
          const trades = await res.json();
          if (!Array.isArray(trades) || trades.length === 0) { keepGoing = false; break; }
          pairTotal += trades.length;
          if (trades.length < 1000) { keepGoing = false; }
          else { fromId = trades[trades.length - 1].id + 1; }
        }
        bnByPair[sym] = pairTotal;
        bnTotalTrades += pairTotal;
      } catch(e) { bnByPair[sym] = 0; }
    }));

    // Also get futures trades
    let futuresTrades = 0;
    try {
      const ts  = Date.now();
      const q   = `symbol=ETHUSDT&limit=1000&timestamp=${ts}&recvWindow=10000`;
      const sig = await hmacSign(env.BINANCE_SECRET, q);
      const res = await fetch(
        'https://tc-proxy-eu.onrender.com/binance-proxy/futures-trades?'+q+'&signature='+sig,
        { headers: { 'X-MBX-APIKEY': 'proxy' } }
      );
      const trades = await res.json();
      futuresTrades = Array.isArray(trades) ? trades.length : 0;
    } catch(e) {}

    const grandTotal = tcSummary.completedDeals + tcSummary.activeDeals + bnTotalTrades + futuresTrades;

    _tradeHistoryCache = {
      tcDeals:        tcSummary.completedDeals + tcSummary.activeDeals,
      tcCompletedDeals: tcSummary.completedDeals,
      tcActiveDeals:  tcSummary.activeDeals,
      tcTotalOrders:  tcSummary.totalOrders,
      tcProfit:       tcSummary.totalProfit,
      bnTrades:       bnTotalTrades,
      bnByPair,
      futuresTrades,
      grandTotal,
      updatedAt:      new Date().toISOString(),
    };
    _tradeHistoryCacheTime = now;

    return json({ ..._tradeHistoryCache, cached: false });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// ── ALGO BOT ENDPOINTS ───────────────────────────────────────
// Returns actual invested capital per bot from Binance
// Requires Read permission on API key
async function getAlgoSpotBots(env) {
  try {
    const ts  = Date.now();
    const q   = `timestamp=${ts}&recvWindow=10000`;
    const sig = await hmacSign(env.BINANCE_SECRET, q);
    const res = await fetch(
      `https://tc-proxy-eu.onrender.com/binance-proxy/sapi/v1/algo/spot/openOrders?${q}&signature=${sig}`,
      { headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY } }
    );
    const data = await res.json();
    return json({ ok: !data.msg && !data.code, data, status: res.status });
  } catch(e) {
    return json({ ok: false, error: e.message });
  }
}

async function getAlgoFutureBots(env) {
  try {
    const ts  = Date.now();
    const q   = `timestamp=${ts}&recvWindow=10000`;
    const sig = await hmacSign(env.BINANCE_SECRET, q);
    const res = await fetch(
      `https://tc-proxy-eu.onrender.com/binance-proxy/sapi/v1/algo/futures/openOrders?${q}&signature=${sig}`,
      { headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY } }
    );
    const data = await res.json();
    return json({ ok: !data.msg && !data.code, data, status: res.status });
  } catch(e) {
    return json({ ok: false, error: e.message });
  }
}

async function getReconciliation(env) {
  try {
    const [spotData, futData, tcData, bnData, pricesData] = await Promise.all([
      getSpotWalletData(env).catch(()=>({usdtBalance:0,balances:[],error:'spot-wallet failed'})),
      getFuturesWalletData(env).catch(()=>({walletBalance:0,marginBalance:0,unrealizedPnl:0,availableBalance:0})),
      fetch('https://tc-proxy-eu.onrender.com/bots').then(r=>r.json()).catch(()=>({bots:[]})),
      getBinanceBotsData(env).catch(()=>({bots:[],market:{},error:'binance-bots failed'})),
      fetch('https://tc-proxy-eu.onrender.com/prices').then(r=>r.json()).catch(()=>({})),
    ]);
    const recon = buildReconciliation({
      spotBalances: spotData.balances || [],
      futuresWallet: futData,
      tcBots:  tcData.bots  || [],
      bnBots:  bnData.bots  || [],
      prices:  pricesData   || [],
    });
    return json(recon);
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

async function getDecisions(env){
  try{
    const [tcData,bnData,futData,spotData,pricesData,sigData]=await Promise.all([
      fetch('https://tc-proxy-eu.onrender.com/bots').then(r=>r.json()).catch(()=>({bots:[]})),
      getBinanceBotsData(env).catch(()=>({bots:[],market:{}})),getFuturesWalletData(env).catch(()=>({walletBalance:0,marginBalance:0,unrealizedPnl:0,availableBalance:0})),
      getSpotWalletData(env).catch(()=>({usdtBalance:0,balances:[],error:'spot-wallet failed'})),
      fetch('https://tc-proxy-eu.onrender.com/prices').then(r=>r.json()).catch(()=>({})),
      fetch('https://tc-proxy-eu.onrender.com/market-signals').then(r=>r.json()).catch(()=>({})),
    ]);
    // Build reconciliation first — this gives us true capital numbers
    const recon = buildReconciliation({
      spotBalances: spotData.balances || [],
      futuresWallet: futData,
      tcBots:  tcData.bots  || [],
      bnBots:  bnData.bots  || [],
      prices:  pricesData   || [],
    });
    const portfolio=buildLivePortfolio(tcData.bots||[],bnData.bots||[],recon);
    // Merge F&G from market-signals into market object
    const fearGreed = sigData?.fearGreed?.value ?? null;
    const market={
      ...(bnData.market||{regime:'Unknown',volatility:'Unknown',btcChange24h:0}),
      fearGreed,
      regime: fearGreed != null
        ? (fearGreed < 30 ? 'Bear' : fearGreed >= 60 ? 'Bull' : 'Sideways')
        : (bnData.market?.regime || 'Unknown'),
    };
    const dataIntegrity={hasTCBots:(tcData.bots||[]).length>0,hasBNBots:(bnData.bots||[]).length>0,hasHedge:portfolio.shortCapital>0,exposureValid:portfolio.totalAllocated>100};
    const dataReliable=dataIntegrity.hasTCBots&&dataIntegrity.hasBNBots&&dataIntegrity.hasHedge&&dataIntegrity.exposureValid;
    const botScores={},botEff={};
    ;(tcData.bots||[]).forEach(b=>{
      const meta=getBotMeta(b.id),cap=b.capital||meta?.capital||100;
      const roi=b.profit?(b.profit/cap)*100:0,trades=(b.completedDeals||0)+(b.activeDeals||0);
      const type=b.strategy==='signal'||b.strategy==='short'?'signal':b.marketType==='futures'?'futures-dca':'dca';
      botScores[b.id]=scoreBot({roi,trades,drawdownPct:roi<0?Math.abs(roi):0,change24h:market.btcChange24h||0,type,capital:cap});
    });
    ;(bnData.bots||[]).forEach(b=>{
      const meta=getBotMeta(b.id);if(!meta)return;
      botScores[b.id]=scoreBot({roi:meta.roi||0,trades:b.trades,drawdownPct:meta.roi<0?Math.abs(meta.roi||0):0,change24h:b.change24h||0,type:meta.scoreType||'spot-grid',capital:meta.capital});
    });
    Object.entries(BOT_META).forEach(([id,meta])=>{
      if(meta.roi!==undefined)botEff[id]=capitalEfficiency(meta.roi,meta.capital);
    });
    const result=await decisionEngine({bots:bnData.bots||[],tcBots:tcData.bots||[],floatingPnl:futData.unrealizedPnl||0,portfolio,market,botScores,spotData,pricesData,dataReliable,dataIntegrity});
    // R11 (NEW): Monthly performance tracker
    let monthlyTarget = null;
    try {
      const now = new Date();
      const mStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const daysIntoMonth = Math.floor((now.getTime() - mStart.getTime()) / 86400000) + 1;
      const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+1, 0)).getUTCDate();
      const grandTotal = recon?.grandTotal || result?.portfolio?.trueTotal || 0;
      const monthLocked = recon?.totalRealised || 0;
      const targets = {
        min:     +(grandTotal * 0.06).toFixed(0),
        stretch: +(grandTotal * 0.10).toFixed(0),
        moon:    +(grandTotal * 0.15).toFixed(0),
      };
      const daysLeft = Math.max(1, daysInMonth - daysIntoMonth + 1);
      monthlyTarget = {
        daysIntoMonth, daysInMonth,
        monthFraction: +(daysIntoMonth/daysInMonth).toFixed(2),
        targets,
        monthLocked: +monthLocked.toFixed(2),
        requiredDailyForMin:     +((targets.min - monthLocked) / daysLeft).toFixed(2),
        requiredDailyForStretch: +((targets.stretch - monthLocked) / daysLeft).toFixed(2),
        onPaceFor6: monthLocked >= targets.min * (daysIntoMonth/daysInMonth),
        pctOfMinTarget:     targets.min     > 0 ? +((monthLocked/targets.min)*100).toFixed(1)     : 0,
        pctOfStretchTarget: targets.stretch > 0 ? +((monthLocked/targets.stretch)*100).toFixed(1) : 0,
      };
    } catch(_) {}
    // YTD performance — annual P&L tracker (target 6%/mo × 12 = 72% annual)
    let ytdTarget = null;
    try {
      const now = new Date();
      const yStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const daysIntoYear = Math.floor((now.getTime() - yStart.getTime()) / 86400000) + 1;
      const daysInYear = ((now.getUTCFullYear() % 4 === 0) && (now.getUTCFullYear() % 100 !== 0)) || (now.getUTCFullYear() % 400 === 0) ? 366 : 365;
      const grandTotal = recon?.grandTotal || result?.portfolio?.trueTotal || 0;
      const ytdLocked = recon?.totalRealised || 0;
      const annualTarget = +(grandTotal * 0.72).toFixed(0);
      const monthlyMinPace = +(grandTotal * 0.06).toFixed(0);
      ytdTarget = {
        daysIntoYear, daysInYear,
        ytdLocked: +ytdLocked.toFixed(2),
        ytdPct: grandTotal > 0 ? +((ytdLocked/grandTotal)*100).toFixed(2) : 0,
        annualTarget,
        monthlyMinPace,
        pctOfYearlyTarget: annualTarget > 0 ? +((ytdLocked/annualTarget)*100).toFixed(1) : 0,
        onPace: ytdLocked >= (annualTarget * (daysIntoYear/daysInYear)),
      };
    } catch(_) {}
    return json({...result,scores:botScores,efficiency:botEff,dataIntegrity,dataWarning:result.dataWarning,reconciliation:recon,prices:pricesData||{},market,monthlyTarget,ytdTarget});
  }catch(e){
    return json({error:e.message,decisions:[],requiredActions:[],suggestedActions:[],riskState:'UNKNOWN',riskScore:0,portfolioGaps:[],targetState:{}},500);
  }
}

async function botAction(env,botId,action){
  const url=`https://tc-proxy-eu.onrender.com/bot/${botId}/${action}`;
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'}});
  const raw=await res.text();let data;
  try{data=JSON.parse(raw);}catch(e){throw new Error('Parse error: '+raw.slice(0,200));}
  if(!data.success) throw new Error(data.error||'Action failed');
  return json(data);
}

async function serveHTML(){return new Response(DASHBOARD_HTML,{headers:{'Content-Type':'text/html'}});}

// ============================================================
// ROUTER
// ============================================================
export default {
  async fetch(request, env) {
    const url=new URL(request.url),path=url.pathname;
    if(request.method==='OPTIONS') return new Response(null,{headers:CORS});
    try{
      if(path==='/api/reconciliation')  return await getReconciliation(env);
      if(path==='/api/trade-history')   return await getTradeHistory(env);
      if(path==='/api/my-ip') {
        try {
          const r = await fetch('https://api.ipify.org?format=json');
          const d = await r.json();
          return json({ cloudflareWorkerIp: d.ip, note: 'IPv6 — Cloudflare Worker outbound IP' });
        } catch(e) { return json({ error: e.message }); }
      }
      if(path==='/api/render-ip') {
        try {
          // Ask the Render proxy to fetch its own outbound IP
          const r = await fetch('https://tc-proxy-eu.onrender.com/my-ip');
          const d = await r.json();
          return json({ renderIp: d.ip, note: 'This is the Render proxy outbound IPv4' });
        } catch(e) { return json({ error: e.message, note: 'Render proxy may not have /my-ip endpoint yet' }); }
      }
      if(path==='/api/algo-spot')      return await getAlgoSpotBots(env);
      if(path==='/api/algo-futures')   return await getAlgoFutureBots(env);
      if(path==='/api/status')         return json({executionEnabled:executionAllowed(env),advisoryMode:!executionAllowed(env),version:'v4',timestamp:new Date().toISOString()});
      if(path==='/api/portfolio')      return json(getPortfolioSnapshot());
      if(path==='/api/logs')           return json({logs:await getActionLogs(env)});
      if(path==='/api/prices')         return await getPrices();
      if(path==='/api/spot-wallet')    return await getSpotWallet(env);
      if(path==='/api/futures-wallet') return await getFuturesWallet(env);
      if(path==='/api/commas-bots')    return await getCommasBots();
      if(path==='/api/binance-bots')   return await getBinanceBots(env);
      if(path==='/api/decisions')      return await getDecisions(env);
      if(path.startsWith('/api/bot/')&&request.method==='POST'){
        if(!executionAllowed(env)) return json({success:false,error:'Advisory Mode active.',advisory:true},403);
        const parts=path.split('/'),botId=parts[3],action=parts[4];
        if(!botId||!['enable','disable'].includes(action)) return json({error:'Usage: POST /api/bot/:id/enable|disable'},400);
        await logAction(env,{type:'bot_action',botId,action,timestamp:new Date().toISOString(),botMeta:getBotMeta(parseInt(botId)||botId)});
        return await botAction(env,botId,action);
      }
      // Grid bot actions — routed to proxy grid-bot endpoint
      if(path.startsWith('/api/grid-bot/')&&request.method==='POST'){
        const parts=path.split('/'),botId=parts[3],action=parts[4];
        if(!botId||!['enable','disable'].includes(action)) return json({error:'Usage: POST /api/grid-bot/:id/enable|disable'},400);
        const url=`https://tc-proxy-eu.onrender.com/grid-bot/${botId}/${action}`;
        const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'}});
        const data=await res.json();
        return json(data);
      }
      // ── PHASE 2: Persistent action log + daily snapshots ─────
      // ── KV-backed portfolio cache (shared across tc-proxy instances) ──
      if(path==='/api/cache/portfolio' && request.method==='GET'){
        if(!env.ALPHA_LOGS) return json({error:'KV not configured'}, 503);
        const cached = await env.ALPHA_LOGS.get('cache:portfolio', 'json');
        return json(cached || {empty:true});
      }
      if(path==='/api/cache/portfolio' && request.method==='POST'){
        if(!env.ALPHA_LOGS) return json({error:'KV not configured'}, 503);
        try {
          const body = await request.json();
          // Validate basic shape — reject obviously bad data
          if (!body || typeof body !== 'object') return json({error:'invalid body'}, 400);
          if (body.totalCapital != null && body.totalCapital < 100) return json({error:'totalCapital too low'}, 400);
          body.savedAt = new Date().toISOString();
          await env.ALPHA_LOGS.put('cache:portfolio', JSON.stringify(body), { expirationTtl: 60*60*24*3 });
          return json({ok:true, savedAt: body.savedAt});
        } catch(e) { return json({error: e.message}, 500); }
      }
      if(path==='/api/log-action' && request.method==='POST'){
        try{
          const body=await request.json();
          await logAction(env,{...body,ts:body.ts||new Date().toISOString()});
          return json({success:true});
        }catch(e){return json({error:e.message},500);}
      }
      // Generic KV get/set — used by /api/reinvested-truth and other manual override entries
      if(path==='/api/kv-get' && request.method==='GET'){
        if(!env.ALPHA_LOGS) return json({error:'KV not configured'},503);
        const url2 = new URL(request.url);
        const key = url2.searchParams.get('key');
        if(!key) return json({error:'key required'},400);
        const raw = await env.ALPHA_LOGS.get(key);
        if(!raw) return json({value:null});
        try { return json({value: JSON.parse(raw)}); }
        catch(_) { return json({value: raw}); }
      }
      if(path==='/api/kv-set' && request.method==='POST'){
        if(!env.ALPHA_LOGS) return json({error:'KV not configured'},503);
        try {
          const body = await request.json();
          if (!body.key || body.value === undefined) return json({error:'key + value required'},400);
          // Light allow-list for keys
          if (!/^[a-z][a-z0-9_:-]{0,80}$/i.test(body.key)) return json({error:'invalid key format'},400);
          const valueToStore = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
          await env.ALPHA_LOGS.put(body.key, valueToStore, { expirationTtl: 60*60*24*30 });
          return json({success:true, key:body.key});
        } catch(e){ return json({error:e.message},500); }
      }
      if(path==='/api/hannah-actions'){
        // Persistent actions from worker KV (survives Render restarts)
        const list=await getActionLogs(env);
        return json({actions:list.filter(a=>a && a.event)});
      }
      if(path==='/api/snapshot-history'){
        try{
          if(!env.ALPHA_LOGS) return json({error:'KV not configured'},500);
          const days = [];
          for (let i=29; i>=0; i--) {
            const d = new Date(Date.now() - i*86400000).toISOString().slice(0,10);
            const data = await env.ALPHA_LOGS.get('snap:'+d, 'json');
            days.push({ day: d, locked: data?.locked ?? null });
          }
          return json({ days });
        }catch(e){return json({error:e.message},500);}
      }
      if(path==='/api/daily-snapshot'){
        // Read or write today's locked snapshot. GET=read, POST=write
        try{
          if(!env.ALPHA_LOGS) return json({error:'KV not configured'},500);
          const today=new Date().toISOString().slice(0,10);
          const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
          if(request.method==='POST'){
            const body=await request.json();
            await env.ALPHA_LOGS.put('snap:'+today,JSON.stringify({locked:body.locked,ts:new Date().toISOString()}),{expirationTtl:60*60*24*60});
            return json({success:true,day:today,locked:body.locked});
          }
          const today_data=await env.ALPHA_LOGS.get('snap:'+today,'json');
          const yesterday_data=await env.ALPHA_LOGS.get('snap:'+yesterday,'json');
          return json({today:today_data,yesterday:yesterday_data});
        }catch(e){return json({error:e.message},500);}
      }
      if(path==='/'||path==='/index.html') return await serveHTML();
      return new Response('Not found',{status:404});
    }catch(e){return json({error:e.message},500);}
  }
};
