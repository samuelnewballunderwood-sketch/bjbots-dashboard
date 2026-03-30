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
  16801943: { name:'BTC Long Futures Bot',    capital:350, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'futures', symbol:'BTCUSDT', maxAllocationPct:15 },
  16801248: { name:'BTC Hedge Bot',           capital:250, direction:'short', strategy:'dca',    venue:'3commas', marketType:'futures', symbol:'BTCUSDT', maxAllocationPct:15 },
  16801317: { name:'BTC Break Out Bot',       capital:100, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', maxAllocationPct:8  },
  16801290: { name:'USDT Stable Coin Engine', capital:100, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', maxAllocationPct:8  },
  194116:   { name:'BTC Binance Signal Bot',  capital:100, direction:'long',  strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', maxAllocationPct:5  },
  194115:   { name:'ETH Binance Signal Bot',  capital:100, direction:'long',  strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'ETHUSDT', maxAllocationPct:5  },
  16805646: { name:'Long MA Cross 30m',       capital:100, direction:'long',  strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', maxAllocationPct:5  },
  16805638: { name:'Short RSI/BB (ETH)',      capital:100, direction:'short', strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'ETHUSDT', maxAllocationPct:5  },
  16805637: { name:'Short RSI/BB (BTC)',      capital:100, direction:'short', strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT', maxAllocationPct:5  },
  'eth-grid-trades':     { name:'ETH/USDT Spot Grid',   capital:400, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'ETHUSDT', roi:0.83,  scoreType:'spot-grid',    maxAllocationPct:18 },
  'btc-dca-trades':      { name:'BTC/USDT Spot DCA',    capital:300, direction:'long', strategy:'dca',  venue:'binance', marketType:'spot',    symbol:'BTCUSDT', roi:2.54,  scoreType:'spot-dca',     maxAllocationPct:15 },
  'bnb-grid-trades':     { name:'BNB/USDT Spot Grid',   capital:300, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'BNBUSDT', roi:0.39,  scoreType:'spot-grid',    maxAllocationPct:12 },
  'sol-grid-trades':     { name:'SOL/USDT Spot Grid',   capital:220, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'SOLUSDT', roi:1.83,  scoreType:'spot-grid',    maxAllocationPct:10 },
  'xrp-grid-trades':     { name:'XRP/USDT Spot Grid',   capital:249, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'XRPUSDT', roi:-0.32, scoreType:'spot-grid',    maxAllocationPct:10 },
  'ethusdt-perp-trades': { name:'ETHUSDT Futures Grid', capital:700, direction:'long', strategy:'grid', venue:'binance', marketType:'futures', symbol:'ETHUSDT', roi:1.51,  scoreType:'futures-grid', maxAllocationPct:25 },
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
    prices.forEach(p => { PRICE_MAP[p.symbol] = parseFloat(p.price); });
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
    });
  });

  // Binance native: derive from locked spot assets + futures margin
  // Each bot owns the locked portion of its trading pair
  const SYMBOL_TO_BOT = {
    'ETHUSDT': 'eth-grid-trades',
    'BTCUSDT': 'btc-dca-trades',
    'BNBUSDT': 'bnb-grid-trades',
    'SOLUSDT': 'sol-grid-trades',
    'XRPUSDT': 'xrp-grid-trades',
  };
  // For Binance native bots, use actual locked wallet balances as source of truth
  // Per-bot capital is estimated from which asset each bot trades
  // Total bnCapital = spotLocked (what wallets actually show in bot orders)
  const ASSET_TO_BOT = {
    'BTC': 'btc-dca-trades',
    'ETH': 'eth-grid-trades',
    'SOL': 'sol-grid-trades',
    'XRP': 'xrp-grid-trades',
    'BNB': 'bnb-grid-trades',
  };
  // Map locked assets to their bots
  const assetToBotCapital = {};
  spot.breakdown.forEach(a => {
    if (a.lockedUsd > 0 && ASSET_TO_BOT[a.asset]) {
      assetToBotCapital[ASSET_TO_BOT[a.asset]] = a.lockedUsd;
    }
  });
  // Also assign locked USDT proportionally to bots that trade USDT pairs
  // USDT locked ($433) is split across grid bot USDT order reserves
  const lockedUSDT = spot.breakdown.find(a => a.asset === 'USDT');
  const lockedUsdtVal = lockedUSDT ? lockedUSDT.lockedUsd : 0;

  let bnCapital = 0;
  const bnBotBreakdown = [];
  (bnBots || []).forEach(b => {
    const meta = BOT_META[b.id];
    if (!meta) return;
    let capital = 0;
    let capitalSource = 'estimated';
    if (meta.marketType === 'futures') {
      // Futures grid — can't split from pooled margin, use proportion of futures wallet
      // ETHUSDT futures grid is the only futures native bot
      capital = futuresTotal * 0.60; // ~60% of futures is this bot (best estimate)
      capitalSource = 'futures-estimate';
    } else {
      // Use actual locked balance for this bot's base asset
      const liveCap = assetToBotCapital[b.id];
      if (liveCap !== undefined) {
        capital = liveCap;
        capitalSource = 'live-locked';
      } else {
        // No locked balance — bot may be idle or USDT-only
        // Use a portion of locked USDT if bot has trades
        capital = b.trades > 0 ? Math.min(meta.capital, lockedUsdtVal * 0.3) : 0;
        capitalSource = 'usdt-estimate';
      }
    }
    const roi = meta.roi || 0;
    const realised  = Math.round((roi / 100) * (meta.capital || capital) * 100) / 100;
    const floating  = 0;
    const trueValue = capital + realised;
    bnCapital += capital;
    bnBotBreakdown.push({
      id: b.id, name: meta.name,
      capital, capitalSource, realised, floating, trueValue,
      strategy: meta.strategy,
      direction: meta.direction,
      trades: b.trades,
    });
  });
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
  // Realised: from completed trades (3Commas profit + Binance grid profit)
  // Floating: open position PnL (futures unrealized + 3Commas open deals)
  const bnRealised     = bnBotBreakdown.reduce((s, b) => s + (b.realised || 0), 0);
  const tcRealised     = tcBotBreakdown.reduce((s, b) => s + (b.realised || 0), 0);
  const totalRealised  = Math.round((bnRealised + tcRealised) * 100) / 100;
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

function computeTargetState({ regime, volatility, riskState }) {
  // Start from base profile
  const base = { ...BASE_PROFILES.default };
  const adjustments = [];

  // Regime adjustments
  if (regime === 'Bear') {
    base.longPct  -= 10;  // less long in bear
    base.shortPct += 5;   // more hedge in bear
    base.gridPct  -= 10;  // grids suffer in trending markets
    base.dcaPct   += 5;
    adjustments.push('Bear market: long -10%, hedge +5%, grid -10%, DCA +5%');
  } else if (regime === 'Bull') {
    base.longPct  += 10;  // allow more long in bull
    base.shortPct -= 5;   // less hedge needed
    base.gridPct  += 5;   // grids work in ranging bull
    adjustments.push('Bull market: long +10%, hedge -5%, grid +5%');
  } else {
    adjustments.push('Sideways market: base targets apply');
  }

  // Volatility adjustments
  if (volatility === 'High') {
    base.gridPct   -= 10; // high vol hurts grids
    base.dcaPct    += 5;  // DCA benefits from vol
    base.shortPct  += 5;  // more defensive
    adjustments.push('High volatility: grid -10%, DCA +5%, hedge +5%');
  } else if (volatility === 'Low') {
    base.gridPct   += 5;  // low vol good for grids
    adjustments.push('Low volatility: grid +5%');
  }

  // Risk state adjustments (applied on top)
  if (riskState === 'HIGH_RISK') {
    base.longPct   = Math.min(base.longPct, 60);
    base.shortPct  = Math.max(base.shortPct, 25);
    base.gridPct   = Math.min(base.gridPct, 35);
    adjustments.push('HIGH_RISK state: long capped 60%, hedge floored 25%, grid capped 35%');
  } else if (riskState === 'OVEREXPOSED') {
    base.longPct   = Math.min(base.longPct, 70);
    base.shortPct  = Math.max(base.shortPct, 20);
    adjustments.push('OVEREXPOSED state: long capped 70%, hedge floored 20%');
  }

  // Clamp all to sensible ranges
  base.longPct   = Math.min(85, Math.max(45, base.longPct));
  base.shortPct  = Math.min(35, Math.max(10, base.shortPct));
  base.gridPct   = Math.min(60, Math.max(20, base.gridPct));
  base.dcaPct    = Math.min(50, Math.max(15, base.dcaPct));
  base.signalPct = Math.min(20, Math.max(5,  base.signalPct));

  return { targets: base, adjustments, basedOn: { regime, volatility, riskState } };
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
                        executable, objective, targetDimension, portfolio, targets }) {
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

  // Build enriched bot list
  const allBots = Object.entries(BOT_META).map(([id, meta]) => {
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
    return { id, ...meta, score, trades, roi, effUsd, marketFit, currentPct, stratPct };
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

  // A. Score < 50 → reduce capital (worst bots first)
  allBots.filter(b => b.score < RC.scoreThresholds.reduce && b.capital > RC.minimumMoveUsd * 2)
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
        objective:'bot_efficiency', confidence:Math.round(85-bot.score*0.3),
      }));
    });

  // B. Idle bots — zero trades, capital allocated
  allBots.filter(b => b.trades === 0 && b.capital >= RC.minimumMoveUsd*2 && b.score >= RC.scoreThresholds.reduce)
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
        objective:'idle_capital', confidence:80,
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
        objective:'bot_efficiency', confidence:68,
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
function decisionEngine({ bots, tcBots, floatingPnl, portfolio, market, botScores, dataReliable=true, dataIntegrity={} }) {
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

  // Extreme long bias (critical threshold)
  if (longPct > 85) {
    const hedgeCap = Math.round(totalAllocated * (targets.shortPct/100));
    const gap      = Math.max(0, hedgeCap - portfolio.shortCapital);
    required.push(makeDecision({
      actionType:'increase', category:'required',
      text:'Increase hedge by $' + gap + ' — portfolio ' + longPct + '% long (critical)',
      reason:'Extreme long bias. Target hedge: ' + targets.shortPct + '% ($' + hedgeCap + '). Current: $' + portfolio.shortCapital + '.',
      amount:gap, amountPct:Math.round((gap/totalAllocated)*100), targetBotIds:[16801248],
      urgency:'critical', timeframe:'immediate',
      expectedImpact:'Reduces catastrophic downside exposure',
      costOfInaction:inactionCost(gap,'critical'),
      objective:'hedge_exposure', confidence:90,
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
    const list = await env.ALPHA_LOGS.list({ prefix:'log:', limit:100 });
    const entries = await Promise.all(list.keys.map(k => env.ALPHA_LOGS.get(k.name,'json')));
    return entries.filter(Boolean).reverse();
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
  const res=await fetch('https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT"]');
  const data=await res.json(); const prices={};
  data.forEach(p=>prices[p.symbol]=parseFloat(p.price)); return json(prices);
}

async function getSpotWalletData(env) {
  const ts=Date.now(),q=`timestamp=${ts}&recvWindow=10000`;
  const sig=await hmacSign(env.BINANCE_SECRET,q);
  const res=await fetch(`https://api.binance.com/api/v3/account?${q}&signature=${sig}`,{headers:{'X-MBX-APIKEY':env.BINANCE_API_KEY}});
  const data=await res.json(); if(data.msg) throw new Error(data.msg);
  const usdt=data.balances.find(b=>b.asset==='USDT');
  const usdtBal=usdt?parseFloat(usdt.free)+parseFloat(usdt.locked):0;
  const nonZero=data.balances.filter(b=>parseFloat(b.free)+parseFloat(b.locked)>0);
  return {usdtBalance:usdtBal,assetCount:nonZero.length,balances:nonZero.map(b=>({asset:b.asset,free:parseFloat(b.free),locked:parseFloat(b.locked)}))};
}
async function getSpotWallet(env) {
  return json(await getSpotWalletData(env));
}

async function getFuturesWallet(env) {
  const ts=Date.now(),q=`timestamp=${ts}&recvWindow=10000`;
  const sig=await hmacSign(env.BINANCE_SECRET,q);
  const res=await fetch(`https://fapi.binance.com/fapi/v2/account?${q}&signature=${sig}`,{headers:{'X-MBX-APIKEY':env.BINANCE_API_KEY}});
  const data=await res.json(); if(data.msg) throw new Error(data.msg);
  return json({marginBalance:parseFloat(data.totalMarginBalance||0),walletBalance:parseFloat(data.totalWalletBalance||0),unrealizedPnl:parseFloat(data.totalUnrealizedProfit||0),availableBalance:parseFloat(data.availableBalance||0)});
}

async function getCommasBots() {
  const res=await fetch('https://tc-proxy-h2pp.onrender.com/bots');
  const raw=await res.text(); let data;
  try{data=JSON.parse(raw);}catch(e){throw new Error('Parse error: '+raw.slice(0,200));}
  if(data.error) throw new Error(data.error); return json(data);
}

async function getBinanceBots(env) {
  try {
    const ts=Date.now();
    async function spotTrades(sym){
      const q=`symbol=${sym}&limit=1000&timestamp=${ts}&recvWindow=10000`;
      const sig=await hmacSign(env.BINANCE_SECRET,q);
      const r=await fetch(`https://api.binance.com/api/v3/myTrades?${q}&signature=${sig}`,{headers:{'X-MBX-APIKEY':env.BINANCE_API_KEY}});
      const d=await r.json(); return Array.isArray(d)?d.length:0;
    }
    async function futuresTrades(sym){
      const q=`symbol=${sym}&limit=1000&timestamp=${ts}&recvWindow=10000`;
      const sig=await hmacSign(env.BINANCE_SECRET,q);
      const r=await fetch(`https://fapi.binance.com/fapi/v1/userTrades?${q}&signature=${sig}`,{headers:{'X-MBX-APIKEY':env.BINANCE_API_KEY}});
      const d=await r.json(); return Array.isArray(d)?d.length:0;
    }
    async function get24h(){
      const r=await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT","BNBUSDT"]');
      const d=await r.json(); const c={};
      d.forEach(t=>{c[t.symbol]={change:parseFloat(t.priceChangePercent),volume:parseFloat(t.quoteVolume),high:parseFloat(t.highPrice),low:parseFloat(t.lowPrice)};});
      return c;
    }
    const [eth,btc,bnb,sol,xrp,ethF,ch]=await Promise.all([
      spotTrades('ETHUSDT'),spotTrades('BTCUSDT'),spotTrades('BNBUSDT'),
      spotTrades('SOLUSDT'),spotTrades('XRPUSDT'),futuresTrades('ETHUSDT'),get24h()
    ]);
    const bots=[
      {symbol:'ETHUSDT',        type:'spot-grid',    trades:eth,  id:'eth-grid-trades',     change24h:ch['ETHUSDT']?.change||0},
      {symbol:'BTCUSDT',        type:'spot-dca',     trades:btc,  id:'btc-dca-trades',      change24h:ch['BTCUSDT']?.change||0},
      {symbol:'BNBUSDT',        type:'spot-grid',    trades:bnb,  id:'bnb-grid-trades',     change24h:ch['BNBUSDT']?.change||0},
      {symbol:'SOLUSDT',        type:'spot-grid',    trades:sol,  id:'sol-grid-trades',     change24h:ch['SOLUSDT']?.change||0},
      {symbol:'XRPUSDT',        type:'spot-grid',    trades:xrp,  id:'xrp-grid-trades',     change24h:ch['XRPUSDT']?.change||0},
      {symbol:'ETHUSDT-FUTURES',type:'futures-grid', trades:ethF, id:'ethusdt-perp-trades', change24h:ch['ETHUSDT']?.change||0},
    ];
    const btcCh=ch['BTCUSDT']?.change||0, v=Math.abs(btcCh);
    return json({bots,totalTrades:bots.reduce((s,b)=>s+b.trades,0),
      market:{regime:btcCh>2?'Bull':btcCh<-2?'Bear':'Sideways',volatility:v>4?'High':v>1.5?'Medium':'Low',btcChange24h:btcCh,changes:ch}});
  } catch(e){return json({error:e.message,bots:[],totalTrades:0});}
}

async function getBinanceBotsData(env){return (await getBinanceBots(env)).json();}
async function getFuturesWalletData(env){return (await getFuturesWallet(env)).json();}

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
    const dir = b.direction || 'long';
    const meta = BOT_META[b.id];
    const sym = meta?.symbol || 'BTCUSDT';
    tot += cap;
    if (dir === 'short') sht += cap; else lng += cap;
    bySt[b.strategy || 'dca'] = (bySt[b.strategy || 'dca'] || 0) + cap;
    byVn['3commas'] = (byVn['3commas'] || 0) + cap;
    bySy[sym] = (bySy[sym] || 0) + cap;
  });

  // Binance native bots
  const bnSource = bnBreakdown.length > 0 ? bnBreakdown : bnBots.map(b => {
    const meta = BOT_META[b.id]; if (!meta) return null;
    return { id: b.id, capital: meta.capital || 0, direction: meta.direction || 'long', strategy: meta.strategy || 'grid' };
  }).filter(Boolean);
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

// ── ALGO BOT ENDPOINTS ───────────────────────────────────────
// Returns actual invested capital per bot from Binance
// Requires Read permission on API key
async function getAlgoSpotBots(env) {
  try {
    const ts  = Date.now();
    const q   = `timestamp=${ts}&recvWindow=10000`;
    const sig = await hmacSign(env.BINANCE_SECRET, q);
    const res = await fetch(
      `https://api.binance.com/sapi/v1/algo/spot/openOrders?${q}&signature=${sig}`,
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
      `https://api.binance.com/sapi/v1/algo/futures/openOrders?${q}&signature=${sig}`,
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
      getSpotWalletData(env),
      getFuturesWalletData(env),
      fetch('https://tc-proxy-h2pp.onrender.com/bots').then(r=>r.json()).catch(()=>({bots:[]})),
      getBinanceBotsData(env),
      fetch('https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"]').then(r=>r.json()).catch(()=>[]),
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
    const [tcData,bnData,futData,spotData,pricesData]=await Promise.all([
      fetch('https://tc-proxy-h2pp.onrender.com/bots').then(r=>r.json()),
      getBinanceBotsData(env),getFuturesWalletData(env),
      getSpotWalletData(env),
      fetch('https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"]').then(r=>r.json()).catch(()=>[]),
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
    const market=bnData.market||{regime:'Unknown',volatility:'Unknown',btcChange24h:0};
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
    const result=decisionEngine({bots:bnData.bots||[],tcBots:tcData.bots||[],floatingPnl:futData.unrealizedPnl||0,portfolio,market,botScores,dataReliable,dataIntegrity});
    return json({...result,scores:botScores,efficiency:botEff,dataIntegrity,dataWarning:result.dataWarning,reconciliation:recon});
  }catch(e){
    return json({error:e.message,decisions:[],requiredActions:[],suggestedActions:[],riskState:'UNKNOWN',riskScore:0,portfolioGaps:[],targetState:{}},500);
  }
}

async function botAction(env,botId,action){
  const url=`https://tc-proxy-h2pp.onrender.com/bot/${botId}/${action}`;
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
      if(path==='/'||path==='/index.html') return await serveHTML();
      return new Response('Not found',{status:404});
    }catch(e){return json({error:e.message},500);}
  }
};
