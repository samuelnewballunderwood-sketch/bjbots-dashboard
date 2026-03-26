// AlphaControl - Cloudflare Worker v3
// Complete rebuild with BOT_META engine, portfolio snapshot, advisory mode, action logging
// Always asks for user confirmation before any bot action - never auto-executes

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
function json(data, status=200) { return new Response(JSON.stringify(data), { status, headers: CORS }); }

// ============================================================
// BOT METADATA — Single source of truth (ChatGPT improvement #1)
// Update this when portfolio changes — everything derives from here
// ============================================================
const BOT_META = {
  // 3Commas bots (keyed by numeric ID)
  16801943: { name:'BTC Long Futures Bot',  capital:350, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'futures', symbol:'BTCUSDT' },
  16801248: { name:'BTC Hedge Bot',          capital:250, direction:'short', strategy:'dca',    venue:'3commas', marketType:'futures', symbol:'BTCUSDT' },
  16801317: { name:'BTC Break Out Bot',      capital:100, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'spot',    symbol:'BTCUSDT' },
  16801290: { name:'USDT Stable Coin Engine',capital:100, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'spot',    symbol:'BTCUSDT' },
  194116:   { name:'BTC Binance Signal Bot', capital:100, direction:'long',  strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT' },
  194115:   { name:'ETH Binance Signal Bot', capital:100, direction:'long',  strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'ETHUSDT' },
  // Binance native bots (keyed by trade ID)
  'eth-grid-trades':    { name:'ETH/USDT Spot Grid',   capital:400, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'ETHUSDT',         roi:0.83,  scoreType:'spot-grid'     },
  'btc-dca-trades':     { name:'BTC/USDT Spot DCA',    capital:300, direction:'long', strategy:'dca',  venue:'binance', marketType:'spot',    symbol:'BTCUSDT',         roi:2.54,  scoreType:'spot-dca'      },
  'bnb-grid-trades':    { name:'BNB/USDT Spot Grid',   capital:300, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'BNBUSDT',         roi:0.39,  scoreType:'spot-grid'     },
  'sol-grid-trades':    { name:'SOL/USDT Spot Grid',   capital:220, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'SOLUSDT',         roi:1.83,  scoreType:'spot-grid'     },
  'xrp-grid-trades':    { name:'XRP/USDT Spot Grid',   capital:249, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'XRPUSDT',         roi:-0.32, scoreType:'spot-grid'     },
  'ethusdt-perp-trades':{ name:'ETHUSDT Futures Grid', capital:700, direction:'long', strategy:'grid', venue:'binance', marketType:'futures', symbol:'ETHUSDT',         roi:1.51,  scoreType:'futures-grid'  },
};

// ============================================================
// PORTFOLIO SNAPSHOT ENGINE (ChatGPT improvement #2)
// Derives all exposure/allocation data from BOT_META dynamically
// ============================================================
function getPortfolioSnapshot() {
  const bots = Object.entries(BOT_META).map(([id, m]) => ({ id, ...m }));
  const totalAllocated = bots.reduce((s,b) => s + b.capital, 0);
  const longCapital    = bots.filter(b => b.direction==='long').reduce((s,b)  => s + b.capital, 0);
  const shortCapital   = bots.filter(b => b.direction==='short').reduce((s,b) => s + b.capital, 0);

  // By strategy
  const byStrategy = bots.reduce((acc,b) => {
    acc[b.strategy] = (acc[b.strategy]||0) + b.capital; return acc;
  }, {});

  // By venue
  const byVenue = bots.reduce((acc,b) => {
    acc[b.venue] = (acc[b.venue]||0) + b.capital; return acc;
  }, {});

  // Asset overlap detection (ChatGPT improvement — detect BTC concentration)
  const bySymbol = bots.reduce((acc,b) => {
    acc[b.symbol] = (acc[b.symbol]||0) + b.capital; return acc;
  }, {});

  return {
    totalAllocated,
    longCapital,
    shortCapital,
    longPct:  totalAllocated ? Math.round((longCapital/totalAllocated)*100) : 0,
    shortPct: totalAllocated ? Math.round((shortCapital/totalAllocated)*100) : 0,
    byStrategy,
    byVenue,
    bySymbol,
    botCount: bots.length,
  };
}

function getBotMeta(botId) {
  // Handle both numeric and string IDs
  return BOT_META[botId] || BOT_META[String(botId)] || null;
}

// ============================================================
// EXECUTION GUARD (ChatGPT improvement #3)
// Advisory mode — no bot is touched without explicit user confirmation
// AND EXECUTION_ENABLED=true in Cloudflare env vars
// ============================================================
function executionAllowed(env) {
  return env.EXECUTION_ENABLED === 'true';
}

// ============================================================
// SCORING ENGINE (Layer 2)
// ============================================================
function scoreBot({ roi, trades, drawdownPct, change24h, type }) {
  const roiScore   = Math.min(100, Math.max(0, 50 + roi * 15));
  const ddScore    = Math.min(100, Math.max(0, 100 - drawdownPct * 4));
  const actScore   = Math.min(100, trades * 8);
  const conScore   = trades > 5 ? 80 : trades > 0 ? 40 + trades*8 : 15;
  const absChange  = Math.abs(change24h);
  const marketFit  = (type==='spot-grid'||type==='futures-grid')
    ? (absChange < 2 ? 80 : absChange < 4 ? 55 : 35)
    : (absChange > 1 ? 75 : 45);
  return Math.round(roiScore*0.30 + ddScore*0.25 + actScore*0.15 + conScore*0.15 + marketFit*0.15);
}

// ============================================================
// DECISION ENGINE (Layer 2 — rules-based recommendation engine)
// Renamed from "AI" per ChatGPT suggestion — honest about what it is
// ============================================================
function decisionEngine({ bots, tcBots, floatingPnl, portfolio, market }) {
  const decisions = [];
  const now = new Date().toISOString();
  const { longPct, bySymbol, totalAllocated } = portfolio;

  // 1. Signal bots — check execution rate
  const signalBotIds = [194116, 194115];
  const signalBots   = tcBots.filter(b => signalBotIds.includes(b.id));
  const signalIdle   = signalBots.filter(b => b.completedDeals===0 && b.activeDeals===0);
  if (signalIdle.length > 0) {
    decisions.push({
      action:'PAUSE', type:'pause', severity:'high',
      text:'Pause Signal Bots',
      reason:`${signalIdle.length} signal bot(s) have 0 executions. Capital allocated but generating no return.`,
      confidence:85, executable:true, botIds:signalIdle.map(b=>b.id)
    });
  }

  // 2. XRP grid — negative ROI + low activity
  const xrp = bots.find(b => b.id==='xrp-grid-trades');
  if (xrp && xrp.trades < 3) {
    decisions.push({
      action:'REVIEW', type:'reduce', severity:'medium',
      text:'Review XRP/USDT Grid',
      reason:`Only ${xrp.trades} trade(s). Negative ROI detected. Grid range may not suit current market.`,
      confidence:72, executable:false
    });
  }

  // 3. Hedge scaling — long bias (using live portfolio data)
  if (longPct > 65) {
    decisions.push({
      action:'INCREASE', type:'increase', severity:'medium',
      text:'Scale Hedge Allocation',
      reason:`Portfolio is ${longPct}% long-biased${market.regime==='Bear'?' in a Bear market — heightened risk':''}. Consider scaling hedge bot to reduce directional exposure.`,
      confidence: longPct > 80 ? 88 : 74, executable:false,
      note:'Manual action — adjust hedge bot size in 3Commas'
    });
  }

  // 4. BTC concentration risk (ChatGPT improvement — asset overlap detection)
  const btcExposure = bySymbol['BTCUSDT'] || 0;
  const btcPct = totalAllocated ? Math.round((btcExposure/totalAllocated)*100) : 0;
  if (btcPct > 45) {
    decisions.push({
      action:'REVIEW', type:'reduce', severity:'medium',
      text:`High BTC Concentration (${btcPct}%)`,
      reason:`${btcPct}% of portfolio is BTC-correlated across multiple bots. Single-asset risk is elevated.`,
      confidence:70, executable:false
    });
  }

  // 5. Best performer — protect
  const btcDca = bots.find(b => b.id==='btc-dca-trades');
  if (btcDca && btcDca.trades > 5) {
    decisions.push({
      action:'HOLD', type:'hold', severity:'low',
      text:'Hold BTC/USDT DCA',
      reason:`Top performer with ${btcDca.trades} completed trades (+2.54% ROI). Do not disturb.`,
      confidence:90, executable:false
    });
  }

  // 6. Idle 3Commas DCA bots
  const idleTcBots = tcBots.filter(b =>
    !signalBotIds.includes(b.id) && b.id!==16801248 &&
    b.completedDeals===0 && b.activeDeals<=1
  );
  if (idleTcBots.length > 0) {
    decisions.push({
      action:'REVIEW', type:'reduce', severity:'low',
      text:`Review ${idleTcBots.length} Idle DCA Bot(s)`,
      reason:`${idleTcBots.map(b=>b.name).join(', ')}: 0 completed deals. Verify these are actually running in 3Commas.`,
      confidence:65, executable:false
    });
  }

  // 7. Floating loss warning
  if (floatingPnl < -10) {
    decisions.push({
      action:'ALERT', type:'pause', severity:'high',
      text:'Floating Loss Warning',
      reason:`Net floating PnL is $${floatingPnl.toFixed(2)}. Open futures positions underwater — monitor closely.`,
      confidence:82, executable:false
    });
  }

  // 8. Market regime warnings
  if (market.regime==='Bull' && market.volatility==='High') {
    decisions.push({
      action:'REVIEW', type:'reduce', severity:'medium',
      text:'High Volatility — Review Grid Ranges',
      reason:`BTC moved ${market.btcChange24h.toFixed(1)}% in 24h. High volatility may push grids outside their ranges.`,
      confidence:70, executable:false
    });
  }

  // Sort by severity: high → medium → low
  const order = { high:0, medium:1, low:2 };
  decisions.sort((a,b) => (order[a.severity]||2) - (order[b.severity]||2));

  return { decisions, generatedAt: now, marketSnapshot: market, portfolio };
}

// ============================================================
// ACTION LOGGING (ChatGPT improvement #4)
// Logs every recommendation AND execution to Cloudflare KV
// Provides audit trail — key for trust and future improvement
// ============================================================
async function logAction(env, entry) {
  try {
    if (!env.ALPHA_LOGS) return; // KV not configured yet — skip gracefully
    const key = 'log:' + Date.now();
    await env.ALPHA_LOGS.put(key, JSON.stringify(entry), { expirationTtl: 60*60*24*90 }); // 90 days
  } catch(e) {
    console.warn('Log write failed:', e.message);
  }
}

async function getActionLogs(env, limit=50) {
  try {
    if (!env.ALPHA_LOGS) return [];
    const list = await env.ALPHA_LOGS.list({ prefix:'log:', limit });
    const entries = await Promise.all(list.keys.map(k => env.ALPHA_LOGS.get(k.name, 'json')));
    return entries.filter(Boolean).reverse(); // newest first
  } catch(e) {
    return [];
  }
}

// ============================================================
// READ ENDPOINTS
// ============================================================
async function getPrices() {
  const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT"]');
  const data = await res.json();
  const prices = {};
  data.forEach(p => prices[p.symbol] = parseFloat(p.price));
  return json(prices);
}

async function getSpotWallet(env) {
  const ts=Date.now(), query=`timestamp=${ts}&recvWindow=10000`;
  const sig = await hmacSign(env.BINANCE_SECRET, query);
  const res = await fetch(`https://api.binance.com/api/v3/account?${query}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }
  });
  const data = await res.json();
  if (data.msg) throw new Error(data.msg);
  const usdt = data.balances.find(b=>b.asset==='USDT');
  const usdtBal = usdt ? parseFloat(usdt.free)+parseFloat(usdt.locked) : 0;
  const nonZero = data.balances.filter(b=>parseFloat(b.free)+parseFloat(b.locked)>0);
  return json({ usdtBalance:usdtBal, assetCount:nonZero.length,
    balances:nonZero.map(b=>({ asset:b.asset, free:parseFloat(b.free), locked:parseFloat(b.locked) })) });
}

async function getFuturesWallet(env) {
  const ts=Date.now(), query=`timestamp=${ts}&recvWindow=10000`;
  const sig = await hmacSign(env.BINANCE_SECRET, query);
  const res = await fetch(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }
  });
  const data = await res.json();
  if (data.msg) throw new Error(data.msg);
  return json({
    marginBalance:    parseFloat(data.totalMarginBalance    ||0),
    walletBalance:    parseFloat(data.totalWalletBalance    ||0),
    unrealizedPnl:    parseFloat(data.totalUnrealizedProfit ||0),
    availableBalance: parseFloat(data.availableBalance      ||0),
  });
}

async function getCommasBots() {
  const res = await fetch('https://tc-proxy-h2pp.onrender.com/bots');
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error('Parse error: '+raw.slice(0,200)); }
  if (data.error) throw new Error(data.error);
  return json(data);
}

async function getBinanceBots(env) {
  try {
    const ts = Date.now();
    async function spotTrades(symbol) {
      const q=`symbol=${symbol}&limit=1000&timestamp=${ts}&recvWindow=10000`;
      const sig=await hmacSign(env.BINANCE_SECRET,q);
      const r=await fetch(`https://api.binance.com/api/v3/myTrades?${q}&signature=${sig}`,{headers:{'X-MBX-APIKEY':env.BINANCE_API_KEY}});
      const d=await r.json(); return Array.isArray(d)?d.length:0;
    }
    async function futuresTrades(symbol) {
      const q=`symbol=${symbol}&limit=1000&timestamp=${ts}&recvWindow=10000`;
      const sig=await hmacSign(env.BINANCE_SECRET,q);
      const r=await fetch(`https://fapi.binance.com/fapi/v1/userTrades?${q}&signature=${sig}`,{headers:{'X-MBX-APIKEY':env.BINANCE_API_KEY}});
      const d=await r.json(); return Array.isArray(d)?d.length:0;
    }
    async function get24hChange() {
      const r=await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT","BNBUSDT"]');
      const d=await r.json(); const changes={};
      d.forEach(t=>{ changes[t.symbol]={ change:parseFloat(t.priceChangePercent), volume:parseFloat(t.quoteVolume), high:parseFloat(t.highPrice), low:parseFloat(t.lowPrice) }; });
      return changes;
    }
    const [ethSpot,btcSpot,bnbSpot,solSpot,xrpSpot,ethFutures,changes] = await Promise.all([
      spotTrades('ETHUSDT'),spotTrades('BTCUSDT'),spotTrades('BNBUSDT'),
      spotTrades('SOLUSDT'),spotTrades('XRPUSDT'),futuresTrades('ETHUSDT'),get24hChange()
    ]);
    const bots = [
      { symbol:'ETHUSDT',        type:'spot-grid',    trades:ethSpot,    id:'eth-grid-trades',    change24h:changes['ETHUSDT']?.change||0 },
      { symbol:'BTCUSDT',        type:'spot-dca',     trades:btcSpot,    id:'btc-dca-trades',     change24h:changes['BTCUSDT']?.change||0 },
      { symbol:'BNBUSDT',        type:'spot-grid',    trades:bnbSpot,    id:'bnb-grid-trades',    change24h:changes['BNBUSDT']?.change||0 },
      { symbol:'SOLUSDT',        type:'spot-grid',    trades:solSpot,    id:'sol-grid-trades',    change24h:changes['SOLUSDT']?.change||0 },
      { symbol:'XRPUSDT',        type:'spot-grid',    trades:xrpSpot,    id:'xrp-grid-trades',    change24h:changes['XRPUSDT']?.change||0 },
      { symbol:'ETHUSDT-FUTURES',type:'futures-grid', trades:ethFutures, id:'ethusdt-perp-trades', change24h:changes['ETHUSDT']?.change||0 },
    ];
    const btcChange = changes['BTCUSDT']?.change||0;
    const btcVol = Math.abs(btcChange);
    return json({
      bots, totalTrades: bots.reduce((s,b)=>s+b.trades,0),
      market: {
        regime:     btcChange>2?'Bull':btcChange<-2?'Bear':'Sideways',
        volatility: btcVol>4?'High':btcVol>1.5?'Medium':'Low',
        btcChange24h: btcChange, changes
      }
    });
  } catch(e) {
    return json({ error:e.message, bots:[], totalTrades:0 });
  }
}

// Internal versions that return data (not Response) for use in getDecisions
async function getBinanceBotsData(env) {
  const res=await getBinanceBots(env); return res.json();
}
async function getFuturesWalletData(env) {
  const res=await getFuturesWallet(env); return res.json();
}

// ============================================================
// DECISIONS ENDPOINT — server-side intelligence engine
// ============================================================
async function getDecisions(env) {
  try {
    const [tcData, bnData, futData] = await Promise.all([
      fetch('https://tc-proxy-h2pp.onrender.com/bots').then(r=>r.json()),
      getBinanceBotsData(env),
      getFuturesWalletData(env)
    ]);

    const portfolio = getPortfolioSnapshot(); // Dynamic — from BOT_META
    const result = decisionEngine({
      bots:        bnData.bots||[],
      tcBots:      tcData.bots||[],
      floatingPnl: futData.unrealizedPnl||0,
      portfolio,
      market: bnData.market||{ regime:'Unknown', volatility:'Unknown', btcChange24h:0 }
    });

    // Score all bots using BOT_META (dynamic, not hardcoded inline)
    const scores = {};
    const market = bnData.market||{};
    ;(tcData.bots||[]).forEach(b => {
      const meta    = getBotMeta(b.id);
      const capital = meta?.capital||100;
      const roi     = b.profit ? (b.profit/capital)*100 : 0;
      const trades  = (b.completedDeals||0)+(b.activeDeals||0);
      const type    = meta?.strategy==='signal'?'signal':meta?.marketType==='futures'?'futures-dca':'dca';
      scores[b.id]  = scoreBot({ roi, trades, drawdownPct:roi<0?Math.abs(roi):0, change24h:market.btcChange24h||0, type });
    });
    ;(bnData.bots||[]).forEach(b => {
      const meta = getBotMeta(b.id);
      if (!meta) return;
      scores[b.id] = scoreBot({ roi:meta.roi||0, trades:b.trades, drawdownPct:meta.roi<0?Math.abs(meta.roi||0):0, change24h:b.change24h||0, type:meta.scoreType||'spot-grid' });
    });

    return json({ ...result, scores });
  } catch(e) {
    return json({ error:e.message, decisions:[], scores:{} }, 500);
  }
}

// ============================================================
// WRITE ENDPOINTS — Layer 1 execution (3Commas only for now)
// ALWAYS requires user confirmation in UI before calling these
// ALWAYS requires EXECUTION_ENABLED=true in Cloudflare env
// ============================================================
async function botAction(env, botId, action) {
  const url = `https://tc-proxy-h2pp.onrender.com/bot/${botId}/${action}`;
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'} });
  const raw = await res.text();
  let data;
  try { data=JSON.parse(raw); } catch(e) { throw new Error('Parse error: '+raw.slice(0,200)); }
  if (!data.success) throw new Error(data.error||'Action failed');
  return json(data);
}

// ============================================================
// SERVE DASHBOARD HTML
// ============================================================
const DASHBOARD_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>AlphaControl</title>\n<link href=\"https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Syne:wght@400;500;700;800&display=swap\" rel=\"stylesheet\">\n<style>\n:root {\n  --bg:#0a0c0f; --bg2:#111318; --bg3:#181b22;\n  --border:rgba(255,255,255,0.07); --border2:rgba(255,255,255,0.12);\n  --text:#e8eaf0; --muted:#6b7280;\n  --green:#22c55e; --green-dim:rgba(34,197,94,0.12);\n  --red:#ef4444;   --red-dim:rgba(239,68,68,0.12);\n  --amber:#f59e0b; --amber-dim:rgba(245,158,11,0.12);\n  --blue:#3b82f6;  --blue-dim:rgba(59,130,246,0.12);\n  --purple:#a855f7;--purple-dim:rgba(168,85,247,0.12);\n  --teal:#14b8a6;  --teal-dim:rgba(20,184,166,0.12);\n}\n*{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:'Syne',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}\n.mono{font-family:'JetBrains Mono',monospace}\nheader{display:flex;align-items:center;justify-content:space-between;padding:16px 32px;border-bottom:1px solid var(--border);background:var(--bg);position:sticky;top:0;z-index:100}\n.logo{display:flex;align-items:center;gap:10px}\n.logo-icon{width:32px;height:32px;background:var(--green);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px}\n.logo-text{font-size:18px;font-weight:800;letter-spacing:-0.5px}\n.logo-sub{font-size:10px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-top:1px}\n.prices{display:flex;gap:24px;align-items:center}\n.price-item{display:flex;flex-direction:column;align-items:flex-end}\n.price-label{font-size:10px;color:var(--muted);letter-spacing:1px;text-transform:uppercase}\n.price-value{font-size:14px;font-weight:700;font-family:'JetBrains Mono',monospace}\n.last-updated{font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace}\n.update-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:6px;animation:pulse 2s infinite}\n@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}\nmain{padding:24px 32px;max-width:1400px;margin:0 auto}\n\n/* PNL HERO */\n.pnl-hero{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin-bottom:20px}\n.pnl-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 18px}\n.pnl-card.primary{border-color:rgba(34,197,94,0.4);background:rgba(34,197,94,0.06)}\n.pnl-card.primary-red{border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.06)}\n.pnl-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}\n.pnl-value{font-size:20px;font-weight:800;font-family:'JetBrains Mono',monospace;letter-spacing:-0.5px}\n.pnl-sub{font-size:10px;color:var(--muted);margin-top:3px}\n\n/* PANELS */\n.panels-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}\n.panel{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px 20px}\n.panel-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:8px}\n.pt-dot{width:6px;height:6px;border-radius:50%}\n.risk-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}\n.risk-label{font-size:11px;color:var(--muted)}\n.risk-value{font-size:13px;font-weight:700;font-family:'JetBrains Mono',monospace}\n.exp-bar{height:6px;background:var(--bg3);border-radius:3px;margin:6px 0 12px;overflow:hidden;display:flex}\n.exp-long{height:100%;background:var(--green);transition:width .5s}\n.exp-short{height:100%;background:var(--red);transition:width .5s}\n.bias-badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px}\n.bias-long{background:var(--green-dim);color:var(--green)}\n.bias-short{background:var(--red-dim);color:var(--red)}\n.alloc-row{display:flex;align-items:center;margin-bottom:9px;gap:8px}\n.alloc-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0}\n.alloc-name{font-size:11px;color:var(--muted);width:80px;flex-shrink:0}\n.alloc-bar-wrap{flex:1;height:4px;background:var(--bg3);border-radius:2px;overflow:hidden}\n.alloc-bar-fill{height:100%;border-radius:2px;transition:width .5s}\n.alloc-pct{font-size:11px;font-family:'JetBrains Mono',monospace;font-weight:700;min-width:32px;text-align:right}\n.market-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}\n.mkt-item{background:var(--bg3);border-radius:8px;padding:10px 12px}\n.mkt-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}\n.mkt-value{font-size:13px;font-weight:700;font-family:'JetBrains Mono',monospace}\n\n/* DECISION ENGINE */\n.decision-panel{background:var(--bg2);border:1px solid rgba(168,85,247,0.3);border-radius:14px;padding:18px 20px;margin-bottom:20px}\n.decision-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}\n.decision-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--purple);display:flex;align-items:center;gap:8px}\n.d-badge{font-size:10px;background:var(--purple-dim);color:var(--purple);padding:2px 8px;border-radius:20px;font-weight:700}\n.d-engine-tag{font-size:9px;background:rgba(34,197,94,0.15);color:var(--green);padding:2px 7px;border-radius:20px;font-weight:700;letter-spacing:.5px}\n.decisions-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}\n.dc{background:var(--bg3);border-radius:10px;padding:12px 14px;border-left:3px solid transparent}\n.dc.increase{border-left-color:var(--green)}\n.dc.reduce{border-left-color:var(--amber)}\n.dc.pause{border-left-color:var(--red)}\n.dc.hold{border-left-color:var(--blue)}\n.dc-action{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}\n.dc.increase .dc-action{color:var(--green)}\n.dc.reduce   .dc-action{color:var(--amber)}\n.dc.pause    .dc-action{color:var(--red)}\n.dc.hold     .dc-action{color:var(--blue)}\n.dc-text{font-size:12px;color:var(--text);line-height:1.4;margin-bottom:5px;font-weight:600}\n.dc-reason{font-size:11px;color:var(--muted);line-height:1.35;margin-bottom:8px}\n.dc-footer{display:flex;align-items:center;justify-content:space-between}\n.dc-conf{font-size:10px;font-family:'JetBrains Mono',monospace;color:var(--purple)}\n.dc-execute-btn{font-size:10px;font-weight:700;padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-family:'Syne',sans-serif;transition:all .2s;letter-spacing:.3px}\n.dc-execute-btn.btn-pause{background:var(--red-dim);color:var(--red)}\n.dc-execute-btn.btn-pause:hover{background:var(--red);color:#fff}\n.dc-execute-btn.btn-enable{background:var(--green-dim);color:var(--green)}\n.dc-execute-btn.btn-enable:hover{background:var(--green);color:#000}\n.dc-execute-btn:disabled{opacity:.4;cursor:not-allowed}\n.dc-execute-btn.loading{opacity:.6;cursor:wait}\n\n/* CONFIRM MODAL */\n.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:9998;display:flex;align-items:center;justify-content:center}\n.modal{background:var(--bg2);border:1px solid var(--border2);border-radius:16px;padding:28px;width:380px;text-align:center}\n.modal-title{font-size:16px;font-weight:800;margin-bottom:8px}\n.modal-body{font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:20px}\n.modal-warning{font-size:11px;background:var(--amber-dim);color:var(--amber);padding:8px 12px;border-radius:8px;margin-bottom:20px}\n.modal-buttons{display:flex;gap:10px}\n.modal-btn{flex:1;padding:10px;border-radius:8px;border:none;font-size:13px;font-weight:700;cursor:pointer;font-family:'Syne',sans-serif}\n.modal-btn.cancel{background:var(--bg3);color:var(--muted)}\n.modal-btn.confirm-pause{background:var(--red);color:#fff}\n.modal-btn.confirm-enable{background:var(--green);color:#000}\n\n/* TOAST */\n.toast{position:fixed;bottom:24px;right:24px;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:12px 18px;font-size:13px;z-index:9999;transform:translateY(100px);opacity:0;transition:all .3s;max-width:320px}\n.toast.show{transform:translateY(0);opacity:1}\n.toast.success{border-color:var(--green);color:var(--green)}\n.toast.error{border-color:var(--red);color:var(--red)}\n\n/* BOTS */\n.section-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;margin-top:24px}\n.section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--muted)}\n.section-count{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:2px 10px;font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted)}\n.section-line{flex:1;height:1px;background:var(--border)}\n.bots-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}\n.bot-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:16px 18px;transition:all .2s;position:relative;overflow:hidden}\n.bot-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}\n.bot-card.long::before{background:var(--green)}\n.bot-card.short::before{background:var(--red)}\n.bot-card.signal::before{background:var(--blue)}\n.bot-card.grid::before{background:var(--purple)}\n.bot-card:hover{border-color:var(--border2);transform:translateY(-1px)}\n.bot-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}\n.bot-name{font-size:13px;font-weight:700;line-height:1.3;max-width:160px}\n.bot-header-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px}\n.status-badge{font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}\n.status-active{background:var(--green-dim);color:var(--green)}\n.status-idle{background:var(--amber-dim);color:var(--amber)}\n.status-underperforming{background:var(--red-dim);color:var(--red)}\n.status-paused{background:rgba(255,255,255,.06);color:var(--muted)}\n.status-waiting{background:var(--amber-dim);color:var(--amber)}\n.score-wrap{display:flex;align-items:center;gap:5px}\n.score-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}\n.ai-score{font-size:11px;font-weight:800;font-family:'JetBrains Mono',monospace;padding:2px 6px;border-radius:4px}\n.score-strong{background:var(--green-dim);color:var(--green)}\n.score-stable{background:var(--blue-dim);color:var(--blue)}\n.score-weak{background:var(--amber-dim);color:var(--amber)}\n.score-critical{background:var(--red-dim);color:var(--red)}\n.score-idle{background:rgba(255,255,255,.06);color:var(--muted)}\n.bot-tags{display:flex;gap:5px;margin-bottom:10px;flex-wrap:wrap}\n.tag{font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;font-family:'JetBrains Mono',monospace}\n.tag-long{background:var(--green-dim);color:var(--green)}\n.tag-short{background:var(--red-dim);color:var(--red)}\n.tag-spot{background:var(--blue-dim);color:var(--blue)}\n.tag-futures{background:var(--purple-dim);color:var(--purple)}\n.tag-signal{background:var(--teal-dim);color:var(--teal)}\n.tag-grid{background:var(--amber-dim);color:var(--amber)}\n.tag-dca{background:rgba(255,255,255,.06);color:var(--muted)}\n.tag-binance{background:rgba(240,185,11,.12);color:#f0b90b}\n.bot-pair{font-size:13px;font-weight:700;font-family:'JetBrains Mono',monospace;margin-bottom:10px}\n.divider{height:1px;background:var(--border);margin:4px 0 10px}\n.bot-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}\n.stat{display:flex;flex-direction:column;gap:2px}\n.stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}\n.stat-value{font-size:13px;font-weight:700;font-family:'JetBrains Mono',monospace}\n.pnl-bar{margin-top:10px;height:3px;background:var(--bg3);border-radius:2px;overflow:hidden}\n.pnl-fill{height:100%;border-radius:2px;transition:width .5s}\n.pnl-fill.positive{background:var(--green)}\n.pnl-fill.negative{background:var(--red)}\n.alert-banner{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:8px 12px;margin-top:8px;font-size:11px;color:var(--red)}\n.filter-bar{display:flex;gap:8px;margin-bottom:20px}\n.filter-btn{background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--muted);padding:6px 14px;font-size:12px;cursor:pointer;font-family:'Syne',sans-serif;font-weight:600;transition:all .2s}\n.filter-btn:hover,.filter-btn.active{border-color:var(--border2);color:var(--text);background:var(--bg3)}\n.filter-btn.active{border-color:var(--green);color:var(--green)}\n.footer{text-align:center;padding:28px;color:var(--muted);font-size:11px;border-top:1px solid var(--border);margin-top:40px}\n#pw-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:#0a0c0f;display:flex;align-items:center;justify-content:center;z-index:9999}\n#pw-box{background:#111318;border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:40px;width:340px;text-align:center}\n#pw-logo{width:48px;height:48px;background:#22c55e;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 20px}\n#pw-title{font-size:22px;font-weight:800;color:#e8eaf0;margin-bottom:6px}\n#pw-sub{font-size:13px;color:#6b7280;margin-bottom:24px}\n#pw-input{width:100%;padding:12px 16px;background:#181b22;border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#e8eaf0;font-size:15px;margin-bottom:12px;outline:none;box-sizing:border-box;font-family:'JetBrains Mono',monospace;letter-spacing:2px}\n#pw-input:focus{border-color:#22c55e}\n#pw-btn{width:100%;padding:12px;background:#22c55e;border:none;border-radius:8px;color:#0a0c0f;font-size:15px;font-weight:700;cursor:pointer;font-family:'Syne',sans-serif}\n#pw-btn:hover{opacity:.9}\n#pw-error{color:#ef4444;font-size:12px;margin-top:10px;display:none}\n@media(max-width:1200px){.pnl-hero{grid-template-columns:repeat(4,1fr)}.bots-grid{grid-template-columns:repeat(2,1fr)}.decisions-grid{grid-template-columns:repeat(2,1fr)}.panels-row{grid-template-columns:1fr 1fr}}\n@media(max-width:700px){main{padding:16px}header{padding:14px 16px}.bots-grid{grid-template-columns:1fr}.pnl-hero{grid-template-columns:repeat(2,1fr)}.decisions-grid{grid-template-columns:1fr}.panels-row{grid-template-columns:1fr}.prices{display:none}}\n.green{color:var(--green)}.red{color:var(--red)}.amber{color:var(--amber)}.blue{color:var(--blue)}\n</style>\n</head>\n<body>\n\n<!-- PASSWORD -->\n<div id=\"pw-overlay\">\n  <div id=\"pw-box\">\n    <div id=\"pw-logo\">\u26a1</div>\n    <div id=\"pw-title\">AlphaControl</div>\n    <div id=\"pw-sub\">Enter password to access your dashboard</div>\n    <input id=\"pw-input\" type=\"password\" placeholder=\"Password\" autofocus />\n    <button id=\"pw-btn\" onclick=\"checkPw()\">Access Dashboard</button>\n    <div id=\"pw-error\">Incorrect password. Try again.</div>\n  </div>\n</div>\n\n<!-- CONFIRM MODAL -->\n<div class=\"modal-overlay\" id=\"modal\" style=\"display:none\">\n  <div class=\"modal\">\n    <div class=\"modal-title\" id=\"modal-title\">Confirm Action</div>\n    <div class=\"modal-body\" id=\"modal-body\">Are you sure?</div>\n    <div class=\"modal-warning\" id=\"modal-warning\"></div>\n    <div class=\"modal-buttons\">\n      <button class=\"modal-btn cancel\" onclick=\"closeModal()\">Cancel</button>\n      <button class=\"modal-btn\" id=\"modal-confirm\" onclick=\"confirmAction()\">Confirm</button>\n    </div>\n  </div>\n</div>\n\n<!-- TOAST -->\n<div class=\"toast\" id=\"toast\"></div>\n\n<header>\n  <div class=\"logo\">\n    <div class=\"logo-icon\">\u26a1</div>\n    <div>\n      <div class=\"logo-text\">AlphaControl</div>\n      <div class=\"logo-sub\">Capital Management System</div>\n    </div>\n  </div>\n  <div class=\"prices\">\n    <div class=\"price-item\"><span class=\"price-label\">BTC/USD</span><span class=\"price-value green\" id=\"btc-price\">\u2014</span></div>\n    <div class=\"price-item\"><span class=\"price-label\">ETH/USD</span><span class=\"price-value green\" id=\"eth-price\">\u2014</span></div>\n  </div>\n  <div class=\"last-updated\"><span class=\"update-dot\"></span><span id=\"last-updated\">Connecting...</span></div>\n</header>\n\n<main>\n  <!-- PNL HERO -->\n  <div class=\"pnl-hero\">\n    <div class=\"pnl-card\"><div class=\"pnl-label\">Total Capital</div><div class=\"pnl-value blue\" id=\"total-capital\">\u2014</div><div class=\"pnl-sub\">Spot + Futures</div></div>\n    <div class=\"pnl-card\"><div class=\"pnl-label\">Allocated</div><div class=\"pnl-value\" id=\"allocated-capital\">$3,169</div><div class=\"pnl-sub\">Across 12 bots</div></div>\n    <div class=\"pnl-card\"><div class=\"pnl-label\">Realized PnL</div><div class=\"pnl-value green\" id=\"realized-pnl\">\u2014</div><div class=\"pnl-sub\">Closed positions</div></div>\n    <div class=\"pnl-card\" id=\"floating-pnl-card\"><div class=\"pnl-label\">Floating PnL</div><div class=\"pnl-value amber\" id=\"floating-pnl\">\u2014</div><div class=\"pnl-sub\">Open positions</div></div>\n    <div class=\"pnl-card primary\" id=\"net-pnl-card\"><div class=\"pnl-label\">\u26a1 Net PnL</div><div class=\"pnl-value green\" id=\"net-pnl\">\u2014</div><div class=\"pnl-sub\" id=\"net-roi\">Realized + Floating</div></div>\n    <div class=\"pnl-card\"><div class=\"pnl-label\">Total Trades</div><div class=\"pnl-value\" id=\"total-trades-val\">\u2014</div><div class=\"pnl-sub\" id=\"total-trades-sub\">All bots</div></div>\n    <div class=\"pnl-card\"><div class=\"pnl-label\">Spot Wallet</div><div class=\"pnl-value\" id=\"spot-wallet-val\">\u2014</div><div class=\"pnl-sub\" id=\"spot-wallet-sub\">Binance Spot</div></div>\n  </div>\n\n  <!-- PANELS -->\n  <div class=\"panels-row\">\n    <div class=\"panel\">\n      <div class=\"panel-title\"><span class=\"pt-dot\" style=\"background:var(--amber)\"></span>Risk Overview</div>\n      <div class=\"risk-row\"><span class=\"risk-label\">Long Exposure</span><span class=\"risk-value green\" id=\"long-exp\">\u2014</span></div>\n      <div class=\"risk-row\"><span class=\"risk-label\">Short Exposure</span><span class=\"risk-value red\" id=\"short-exp\">\u2014</span></div>\n      <div class=\"exp-bar\"><div class=\"exp-long\" id=\"exp-long-bar\" style=\"width:0%\"></div><div class=\"exp-short\" id=\"exp-short-bar\" style=\"width:0%\"></div></div>\n      <div class=\"risk-row\"><span class=\"risk-label\">Net Bias</span><span class=\"bias-badge bias-long\" id=\"net-bias\">\u2014</span></div>\n      <div style=\"height:8px\"></div>\n      <div class=\"risk-row\"><span class=\"risk-label\">Futures uPnL</span><span class=\"risk-value\" id=\"upnl-val\">\u2014</span></div>\n      <div class=\"risk-row\"><span class=\"risk-label\">Avail. Margin</span><span class=\"risk-value\" id=\"avail-margin\">\u2014</span></div>\n      <div class=\"risk-row\"><span class=\"risk-label\">Futures Wallet</span><span class=\"risk-value\" id=\"futures-wallet-val\">\u2014</span></div>\n    </div>\n    <div class=\"panel\">\n      <div class=\"panel-title\"><span class=\"pt-dot\" style=\"background:var(--blue)\"></span>Capital Allocation</div>\n      <div class=\"alloc-row\"><div class=\"alloc-dot\" style=\"background:var(--purple)\"></div><div class=\"alloc-name\">Grid Bots</div><div class=\"alloc-bar-wrap\"><div class=\"alloc-bar-fill\" style=\"background:var(--purple);width:53%\"></div></div><div class=\"alloc-pct\">53%</div></div>\n      <div class=\"alloc-row\"><div class=\"alloc-dot\" style=\"background:var(--blue)\"></div><div class=\"alloc-name\">DCA Bots</div><div class=\"alloc-bar-wrap\"><div class=\"alloc-bar-fill\" style=\"background:var(--blue);width:25%\"></div></div><div class=\"alloc-pct\">25%</div></div>\n      <div class=\"alloc-row\"><div class=\"alloc-dot\" style=\"background:var(--red)\"></div><div class=\"alloc-name\">Hedge Bot</div><div class=\"alloc-bar-wrap\"><div class=\"alloc-bar-fill\" style=\"background:var(--red);width:8%\"></div></div><div class=\"alloc-pct\">8%</div></div>\n      <div class=\"alloc-row\"><div class=\"alloc-dot\" style=\"background:var(--teal)\"></div><div class=\"alloc-name\">Signal Bots</div><div class=\"alloc-bar-wrap\"><div class=\"alloc-bar-fill\" style=\"background:var(--teal);width:6%\"></div></div><div class=\"alloc-pct\">6%</div></div>\n      <div class=\"alloc-row\"><div class=\"alloc-dot\" style=\"background:var(--muted)\"></div><div class=\"alloc-name\">Idle / Free</div><div class=\"alloc-bar-wrap\"><div class=\"alloc-bar-fill\" id=\"idle-bar\" style=\"background:var(--muted);width:8%\"></div></div><div class=\"alloc-pct\" id=\"idle-pct\">\u2014</div></div>\n      <div style=\"margin-top:12px;padding-top:10px;border-top:1px solid var(--border)\">\n        <div class=\"risk-row\"><span class=\"risk-label\">Total Allocated</span><span class=\"risk-value blue\">$3,169</span></div>\n        <div class=\"risk-row\"><span class=\"risk-label\">Free Capital</span><span class=\"risk-value green\" id=\"free-capital\">\u2014</span></div>\n      </div>\n    </div>\n    <div class=\"panel\">\n      <div class=\"panel-title\"><span class=\"pt-dot\" style=\"background:var(--purple)\"></span>Market Context</div>\n      <div class=\"market-grid\">\n        <div class=\"mkt-item\"><div class=\"mkt-label\">Regime</div><div class=\"mkt-value\" id=\"market-regime\">\u2014</div></div>\n        <div class=\"mkt-item\"><div class=\"mkt-label\">Volatility</div><div class=\"mkt-value\" id=\"market-vol\">\u2014</div></div>\n        <div class=\"mkt-item\"><div class=\"mkt-label\">BTC 24h</div><div class=\"mkt-value\" id=\"btc-move\">\u2014</div></div>\n        <div class=\"mkt-item\"><div class=\"mkt-label\">Signal Bias</div><div class=\"mkt-value\" id=\"signal-bias\">\u2014</div></div>\n        <div class=\"mkt-item\" style=\"grid-column:span 2\"><div class=\"mkt-label\">Grid Suitability</div><div class=\"mkt-value\" id=\"grid-suit\">\u2014</div></div>\n      </div>\n    </div>\n  </div>\n\n  <!-- ALPHACONTROL DECISION ENGINE -->\n  <div class=\"decision-panel\">\n    <div class=\"decision-header\">\n      <div class=\"decision-title\">\n        \ud83e\udde0 AlphaControl Actions\n        <span class=\"d-badge\" id=\"action-count\">Loading...</span>\n        <span class=\"d-engine-tag\">LIVE ENGINE</span>\n      </div>\n      <div style=\"font-size:11px;color:var(--muted)\" id=\"decision-ts\">\u2014</div>\n    </div>\n    <div class=\"decisions-grid\" id=\"decisions-container\">\n      <div style=\"grid-column:span 3;text-align:center;color:var(--muted);font-size:12px;padding:20px\">\n        \u23f3 Running intelligence engine...\n      </div>\n    </div>\n  </div>\n\n  <!-- FILTER -->\n  <div class=\"filter-bar\">\n    <button class=\"filter-btn active\" onclick=\"filterBots('all',this)\">All</button>\n    <button class=\"filter-btn\" onclick=\"filterBots('dca',this)\">DCA</button>\n    <button class=\"filter-btn\" onclick=\"filterBots('signal',this)\">Signal</button>\n    <button class=\"filter-btn\" onclick=\"filterBots('spot',this)\">Spot</button>\n    <button class=\"filter-btn\" onclick=\"filterBots('futures',this)\">Futures</button>\n    <button class=\"filter-btn\" onclick=\"filterBots('binance',this)\">Binance Native</button>\n  </div>\n\n  <!-- 3COMMAS DCA -->\n  <div class=\"section-header\"><span class=\"section-title\">3Commas DCA Bots</span><span class=\"section-count\">4</span><div class=\"section-line\"></div></div>\n  <div class=\"bots-grid\">\n    <div class=\"bot-card long\" data-type=\"dca futures\">\n      <div class=\"bot-header\"><div class=\"bot-name\">BTC Long Futures Bot</div><div class=\"bot-header-right\"><span class=\"status-badge status-idle\" id=\"status-16801943\">Idle</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-idle\" id=\"score-16801943\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-long\">Long</span><span class=\"tag tag-futures\">Futures</span><span class=\"tag tag-dca\">DCA</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">BTCUSDT / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Size</span><span class=\"stat-value\">$350</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Leverage</span><span class=\"stat-value amber\">2\u00d7</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Take Profit</span><span class=\"stat-value\">2.4%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"trades-16801943\">0</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Avg Orders</span><span class=\"stat-value\">3</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Stop Loss</span><span class=\"stat-value red\">22%</span></div>\n      </div>\n    </div>\n    <div class=\"bot-card short\" data-type=\"dca futures\">\n      <div class=\"bot-header\"><div class=\"bot-name\" data-bot-id=\"16801248\">BTC Hedge Bot</div><div class=\"bot-header-right\"><span class=\"status-badge status-active\" id=\"status-16801248\">Active</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-stable\" id=\"score-16801248\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-short\">Short</span><span class=\"tag tag-futures\">Futures</span><span class=\"tag tag-dca\">DCA</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">BTCUSDT / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Size</span><span class=\"stat-value\">$250</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">PnL</span><span class=\"stat-value green\" id=\"pnl-16801248\">+$8.50</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Take Profit</span><span class=\"stat-value\">2.4%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"trades-16801248\">1</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Leverage</span><span class=\"stat-value amber\">2\u00d7</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Stop Loss</span><span class=\"stat-value red\">22%</span></div>\n      </div>\n      <div class=\"pnl-bar\"><div class=\"pnl-fill positive\" style=\"width:60%\"></div></div>\n    </div>\n    <div class=\"bot-card long\" data-type=\"dca spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\" data-bot-id=\"16801317\">BTC Break Out Bot</div><div class=\"bot-header-right\"><span class=\"status-badge status-idle\" id=\"status-16801317\">Idle</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-idle\" id=\"score-16801317\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-long\">Long</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-dca\">DCA</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">BTC / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Size</span><span class=\"stat-value\">$100</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Active</span><span class=\"stat-value\">1/1</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Take Profit</span><span class=\"stat-value\">3%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"trades-16801317\">0</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Avg Orders</span><span class=\"stat-value\">3</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Stop Loss</span><span class=\"stat-value red\">5%</span></div>\n      </div>\n    </div>\n    <div class=\"bot-card long\" data-type=\"dca spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\" data-bot-id=\"16801290\">USDT Stable Coin Engine</div><div class=\"bot-header-right\"><span class=\"status-badge status-idle\" id=\"status-16801290\">Idle</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-idle\" id=\"score-16801290\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-long\">Long</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-dca\">DCA</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">BTC / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Size</span><span class=\"stat-value\">$100</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Active</span><span class=\"stat-value\">1/1</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Take Profit</span><span class=\"stat-value\">2.4%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"trades-16801290\">0</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Avg Orders</span><span class=\"stat-value\">3</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Stop Loss</span><span class=\"stat-value red\">5%</span></div>\n      </div>\n    </div>\n  </div>\n\n  <!-- SIGNAL BOTS -->\n  <div class=\"section-header\"><span class=\"section-title\">3Commas Signal Bots</span><span class=\"section-count\">2</span><div class=\"section-line\"></div></div>\n  <div class=\"bots-grid\">\n    <div class=\"bot-card signal\" data-type=\"signal spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\" data-bot-id=\"194116\">BTC Binance Signal Bot</div><div class=\"bot-header-right\"><span class=\"status-badge status-waiting\" id=\"status-194116\">Waiting</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-weak\" id=\"score-194116\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-long\">Long</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-signal\">Signal</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">BTC / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Size</span><span class=\"stat-value\">$100</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Signals</span><span class=\"stat-value\">1</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trigger</span><span class=\"stat-value\" style=\"font-size:11px\">EMA 9\u00d721</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Active</span><span class=\"stat-value\">0/1</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Timeframe</span><span class=\"stat-value\">15m</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Webhook</span><span class=\"stat-value green\" style=\"font-size:11px\">\u2713 Live</span></div>\n      </div>\n      <div class=\"alert-banner\">\ud83d\udea8 Signal performance declining \u2014 0 executions detected</div>\n    </div>\n    <div class=\"bot-card signal\" data-type=\"signal spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\" data-bot-id=\"194115\">ETH Binance Signal Bot</div><div class=\"bot-header-right\"><span class=\"status-badge status-waiting\" id=\"status-194115\">Waiting</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-weak\" id=\"score-194115\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-long\">Long</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-signal\">Signal</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">ETH / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Size</span><span class=\"stat-value\">$100</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Signals</span><span class=\"stat-value\">1</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trigger</span><span class=\"stat-value\" style=\"font-size:11px\">EMA 9\u00d721</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Active</span><span class=\"stat-value\">0/1</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Timeframe</span><span class=\"stat-value\">15m</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Webhook</span><span class=\"stat-value green\" style=\"font-size:11px\">\u2713 Live</span></div>\n      </div>\n      <div class=\"alert-banner\">\ud83d\udea8 Signal performance declining \u2014 0 executions detected</div>\n    </div>\n  </div>\n\n  <!-- BINANCE NATIVE -->\n  <div class=\"section-header\"><span class=\"section-title\">Binance Native Bots</span><span class=\"section-count\">6</span><div class=\"section-line\"></div></div>\n  <div class=\"bots-grid\">\n    <div class=\"bot-card long\" data-type=\"binance spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\">ETH/USDT Spot Grid</div><div class=\"bot-header-right\"><span class=\"status-badge status-active\" id=\"status-eth-grid\">Active</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-stable\" id=\"score-eth-grid\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-grid\">Grid</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">ETH / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Invested</span><span class=\"stat-value\">$400</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Profit</span><span class=\"stat-value green\">+$3.31</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">ROI</span><span class=\"stat-value green\">+0.83%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"eth-grid-trades\">\u2014</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\">$403.31</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">24h</span><span class=\"stat-value\" id=\"change-eth-grid\">\u2014</span></div>\n      </div>\n      <div class=\"pnl-bar\"><div class=\"pnl-fill positive\" style=\"width:40%\"></div></div>\n    </div>\n    <div class=\"bot-card long\" data-type=\"binance spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\">BTC/USDT Spot DCA</div><div class=\"bot-header-right\"><span class=\"status-badge status-active\" id=\"status-btc-dca\">Active</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-strong\" id=\"score-btc-dca\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-dca\">DCA</span><span class=\"tag tag-long\">Buy BTC</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">BTC / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Invested</span><span class=\"stat-value\">$300</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Profit</span><span class=\"stat-value green\">+$7.63</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">ROI</span><span class=\"stat-value green\">+2.54%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"btc-dca-trades\">\u2014</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\">$307.63</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">24h</span><span class=\"stat-value\" id=\"change-btc-dca\">\u2014</span></div>\n      </div>\n      <div class=\"pnl-bar\"><div class=\"pnl-fill positive\" style=\"width:65%\"></div></div>\n    </div>\n    <div class=\"bot-card long\" data-type=\"binance spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\">BNB/USDT Spot Grid</div><div class=\"bot-header-right\"><span class=\"status-badge status-idle\" id=\"status-bnb-grid\">Idle</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-weak\" id=\"score-bnb-grid\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-grid\">Grid</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">BNB / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Invested</span><span class=\"stat-value\">$300</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Profit</span><span class=\"stat-value green\">+$1.16</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">ROI</span><span class=\"stat-value green\">+0.39%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"bnb-grid-trades\">\u2014</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\">$301.16</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">24h</span><span class=\"stat-value\" id=\"change-bnb-grid\">\u2014</span></div>\n      </div>\n      <div class=\"pnl-bar\"><div class=\"pnl-fill positive\" style=\"width:20%\"></div></div>\n    </div>\n    <div class=\"bot-card long\" data-type=\"binance spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\">SOL/USDT Spot Grid</div><div class=\"bot-header-right\"><span class=\"status-badge status-idle\" id=\"status-sol-grid\">Idle</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-weak\" id=\"score-sol-grid\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-grid\">Grid</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">SOL / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Invested</span><span class=\"stat-value\">$220</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Profit</span><span class=\"stat-value green\">+$4.02</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">ROI</span><span class=\"stat-value green\">+1.83%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"sol-grid-trades\">\u2014</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\">$224.02</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">24h</span><span class=\"stat-value\" id=\"change-sol-grid\">\u2014</span></div>\n      </div>\n      <div class=\"pnl-bar\"><div class=\"pnl-fill positive\" style=\"width:50%\"></div></div>\n    </div>\n    <div class=\"bot-card short\" data-type=\"binance spot\">\n      <div class=\"bot-header\"><div class=\"bot-name\">XRP/USDT Spot Grid</div><div class=\"bot-header-right\"><span class=\"status-badge status-underperforming\" id=\"status-xrp-grid\">Underperforming</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-weak\" id=\"score-xrp-grid\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-grid\">Grid</span><span class=\"tag tag-spot\">Spot</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">XRP / USDT</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Invested</span><span class=\"stat-value\">$249</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Profit</span><span class=\"stat-value red\">-$0.81</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">ROI</span><span class=\"stat-value red\">-0.32%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Trades</span><span class=\"stat-value\" id=\"xrp-grid-trades\">\u2014</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Balance</span><span class=\"stat-value\">$248.19</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">24h</span><span class=\"stat-value\" id=\"change-xrp-grid\">\u2014</span></div>\n      </div>\n      <div class=\"pnl-bar\"><div class=\"pnl-fill negative\" style=\"width:15%\"></div></div>\n    </div>\n    <div class=\"bot-card grid\" data-type=\"binance grid futures\">\n      <div class=\"bot-header\"><div class=\"bot-name\">ETHUSDT Perp Grid</div><div class=\"bot-header-right\"><span class=\"status-badge status-active\" id=\"status-eth-perp\">Active</span><div class=\"score-wrap\"><span class=\"score-lbl\">AI</span><span class=\"ai-score score-stable\" id=\"score-eth-perp\">\u2014</span></div></div></div>\n      <div class=\"bot-tags\"><span class=\"tag tag-grid\">Grid</span><span class=\"tag tag-futures\">Futures UM</span><span class=\"tag tag-binance\">Binance</span></div>\n      <div class=\"bot-pair mono\">ETHUSDT / Perpetual</div><div class=\"divider\"></div>\n      <div class=\"bot-stats\">\n        <div class=\"stat\"><span class=\"stat-label\">Margin</span><span class=\"stat-value\">$700</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Profit</span><span class=\"stat-value green\">+$10.56</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">ROI</span><span class=\"stat-value green\">+1.51%</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">uPnL</span><span class=\"stat-value amber\" id=\"perp-upnl\">\u2014</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">Mode</span><span class=\"stat-value\" style=\"font-size:12px\">Cross</span></div>\n        <div class=\"stat\"><span class=\"stat-label\">24h</span><span class=\"stat-value\" id=\"change-eth-perp\">\u2014</span></div>\n      </div>\n      <div class=\"pnl-bar\"><div class=\"pnl-fill positive\" style=\"width:55%\"></div></div>\n    </div>\n  </div>\n</main>\n\n<div class=\"footer\">AlphaControl Dashboard \u00b7 Last synced <span id=\"sync-time\">\u2014</span> \u00b7 Rules engine v2 \u00b7 Data: 3Commas + Binance</div>\n\n<script>\n// ============ CONSTANTS ============\nconst TOTAL_ALLOCATED = 3169;\nconst TOTAL_REALIZED  = 34.37;\n\n// ============ HELPERS ============\nfunction fmtUSD(n)    { const v=parseFloat(n); return (v<0?'-$':'$')+Math.abs(v).toFixed(2); }\nfunction fmtProfit(n) { const v=parseFloat(n); return (v>=0?'+$':'-$')+Math.abs(v).toFixed(2); }\nfunction fmt(n,d=2)   { return parseFloat(n).toFixed(d); }\nfunction cc(n)        { return parseFloat(n)>=0?'green':'red'; }\nfunction setEl(id, val, cls) { const e=document.getElementById(id); if(!e)return; e.textContent=val; if(cls!==undefined)e.className=cls; }\nfunction fmtChange(c) { return (c>=0?'+':'')+c.toFixed(2)+'%'; }\n\n// ============ TOAST ============\nfunction showToast(msg, type='success') {\n  const t = document.getElementById('toast');\n  t.textContent = msg;\n  t.className = 'toast ' + type + ' show';\n  setTimeout(() => t.className='toast', 3500);\n}\n\n// ============ MODAL ============\nlet _pendingAction = null;\nfunction openModal(title, body, warning, confirmCls, action) {\n  document.getElementById('modal-title').textContent   = title;\n  document.getElementById('modal-body').textContent    = body;\n  document.getElementById('modal-warning').textContent = warning;\n  document.getElementById('modal-confirm').className   = 'modal-btn ' + confirmCls;\n  document.getElementById('modal-confirm').textContent = title;\n  document.getElementById('modal').style.display       = 'flex';\n  _pendingAction = action;\n}\nfunction closeModal() {\n  document.getElementById('modal').style.display = 'none';\n  _pendingAction = null;\n}\nasync function confirmAction() {\n  if (!_pendingAction) return;\n  closeModal();\n  await _pendingAction();\n}\n\n// ============ BOT ACTIONS ============\nasync function executeBotAction(botId, action, btnEl) {\n  const actionLabel = action === 'disable' ? 'Pause' : 'Enable';\n  const warningText = action === 'disable'\n    ? 'This will pause the bot in 3Commas. Active deals will remain open until their take-profit or stop-loss is hit.'\n    : 'This will re-enable the bot in 3Commas. New deals will start according to the bot strategy.';\n\n  openModal(\n    `${actionLabel} Bot`,\n    `Are you sure you want to ${action} this bot in 3Commas?`,\n    warningText,\n    action === 'disable' ? 'confirm-pause' : 'confirm-enable',\n    async () => {\n      if (btnEl) { btnEl.disabled = true; btnEl.classList.add('loading'); btnEl.textContent = '\u23f3'; }\n      try {\n        const res  = await fetch(`/api/bot/${botId}/${action}`, { method: 'POST' });\n        const data = await res.json();\n        if (!data.success) throw new Error(data.error || 'Action failed');\n        showToast(`\u2705 Bot ${action}d successfully`, 'success');\n        // Refresh bot status after action\n        setTimeout(refreshAll, 1500);\n      } catch(e) {\n        showToast(`\u274c Failed: ${e.message}`, 'error');\n        if (btnEl) { btnEl.disabled = false; btnEl.classList.remove('loading'); btnEl.textContent = actionLabel; }\n      }\n    }\n  );\n}\n\n// ============ SCORE DISPLAY ============\nfunction scoreClass(s) {\n  if (s >= 75) return 'score-strong';\n  if (s >= 55) return 'score-stable';\n  if (s >= 35) return 'score-weak';\n  return 'score-critical';\n}\nfunction statusFromScore(s, trades, enabled) {\n  if (!enabled)   return { label:'Paused',          cls:'status-paused'          };\n  if (trades===0) return { label:'Idle',             cls:'status-idle'            };\n  if (s < 35)     return { label:'Underperforming',  cls:'status-underperforming' };\n  return                 { label:'Active',           cls:'status-active'          };\n}\n\n// ============ API ============\nasync function apiFetch(p) { const r=await fetch('/api/'+p); if(!r.ok)throw new Error(r.status); return r.json(); }\n\n// ============ DECISION ENGINE (calls server-side) ============\nasync function loadDecisions() {\n  try {\n    const data = await apiFetch('decisions');\n    const decisions = data.decisions || [];\n    const scores    = data.scores    || {};\n    const market    = data.marketSnapshot || {};\n\n    // Apply scores to bot cards\n    Object.entries(scores).forEach(([id, score]) => {\n      const scEl = document.getElementById('score-' + id);\n      if (scEl) { scEl.textContent = score; scEl.className = 'ai-score ' + scoreClass(score); }\n    });\n\n    // Update market context from server data\n    if (market.regime) {\n      const re = document.getElementById('market-regime');\n      if (re) { re.textContent = market.regime; re.style.color = market.regime==='Bull'?'var(--green)':market.regime==='Bear'?'var(--red)':'var(--amber)'; }\n    }\n    if (market.volatility) {\n      const ve = document.getElementById('market-vol');\n      if (ve) { ve.textContent = market.volatility; ve.style.color = market.volatility==='High'?'var(--amber)':market.volatility==='Low'?'var(--green)':'var(--text)'; }\n    }\n    if (market.btcChange24h !== undefined) {\n      const me = document.getElementById('btc-move');\n      if (me) { me.textContent = fmtChange(market.btcChange24h); me.style.color = market.btcChange24h>=0?'var(--green)':'var(--red)'; }\n      const bias = market.btcChange24h > 1 ? 'LONG' : market.btcChange24h < -1 ? 'SHORT' : 'NEUTRAL';\n      setEl('signal-bias', bias);\n      const absC = Math.abs(market.btcChange24h);\n      const suit = market.regime==='Sideways'&&absC<2 ? 'Excellent for Grid' : absC>4 ? 'Good for Breakout' : market.regime==='Bull' ? 'Good for DCA' : 'Monitor closely';\n      setEl('grid-suit', suit);\n    }\n\n    // Render decision cards\n    const container = document.getElementById('decisions-container');\n    setEl('action-count', decisions.length + ' action' + (decisions.length!==1?'s':''));\n    setEl('decision-ts', 'Engine ran ' + new Date(data.generatedAt||Date.now()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}));\n\n    if (!decisions.length) {\n      container.innerHTML = '<div style=\"grid-column:span 3;text-align:center;color:var(--muted);font-size:12px;padding:20px\">\u2705 No actions required at this time</div>';\n      return;\n    }\n\n    container.innerHTML = decisions.map((d, i) => {\n      const execBtn = d.executable && d.botIds && d.botIds.length\n        ? `<button class=\"dc-execute-btn btn-pause\" onclick=\"executeBotAction(${d.botIds[0]},'disable',this)\">\u23f8 Pause Bot</button>`\n        : d.executable\n          ? `<button class=\"dc-execute-btn btn-enable\" onclick=\"executeBotAction(${d.target},'enable',this)\">\u25b6 Enable Bot</button>`\n          : `<span style=\"font-size:10px;color:var(--muted)\">Manual action</span>`;\n      return `\n        <div class=\"dc ${d.type}\">\n          <div class=\"dc-action\">${d.action}</div>\n          <div class=\"dc-text\">${d.text}</div>\n          <div class=\"dc-reason\">${d.reason}</div>\n          <div class=\"dc-footer\">\n            <div class=\"dc-conf\">Confidence: ${d.confidence}%</div>\n            ${execBtn}\n          </div>\n        </div>`;\n    }).join('');\n  } catch(e) {\n    console.warn('Decisions failed', e);\n    document.getElementById('decisions-container').innerHTML =\n      `<div style=\"grid-column:span 3;text-align:center;color:var(--red);font-size:12px;padding:20px\">\u26a0\ufe0f Engine error: ${e.message}</div>`;\n  }\n}\n\n// ============ DATA LOADERS ============\nasync function loadPrices() {\n  const d   = await apiFetch('prices');\n  const btc = d.BTCUSDT, eth = d.ETHUSDT;\n  document.getElementById('btc-price').textContent = '$'+btc.toLocaleString('en-US',{maximumFractionDigits:0});\n  document.getElementById('eth-price').textContent = '$'+eth.toLocaleString('en-US',{maximumFractionDigits:0});\n}\n\nasync function loadWallets() {\n  const [spot, fut] = await Promise.all([apiFetch('spot-wallet'), apiFetch('futures-wallet')]);\n  const floatPnl = fut.unrealizedPnl, margin = fut.marginBalance, avail = fut.availableBalance;\n\n  setEl('spot-wallet-val', fmtUSD(spot.usdtBalance));\n  setEl('spot-wallet-sub', spot.assetCount+' assets held');\n  setEl('futures-wallet-val', fmtUSD(margin));\n  setEl('avail-margin', fmtUSD(avail));\n  const ue = document.getElementById('upnl-val');\n  if(ue){ ue.textContent=(floatPnl>=0?'+':'')+fmtUSD(floatPnl); ue.style.color=floatPnl<0?'var(--red)':'var(--green)'; }\n  setEl('perp-upnl', (floatPnl>=0?'+':'')+fmtUSD(floatPnl));\n  setEl('realized-pnl', fmtProfit(TOTAL_REALIZED));\n\n  const fe = document.getElementById('floating-pnl');\n  if(fe){ fe.textContent=(floatPnl>=0?'+':'')+fmtUSD(floatPnl); fe.className='pnl-value '+cc(floatPnl); }\n  const fc = document.getElementById('floating-pnl-card');\n  if(fc) fc.className='pnl-card'+(floatPnl<0?' primary-red':'');\n\n  const net = TOTAL_REALIZED + floatPnl;\n  const ne  = document.getElementById('net-pnl');\n  if(ne){ ne.textContent=fmtProfit(net); ne.className='pnl-value '+cc(net); }\n  const nc = document.getElementById('net-pnl-card');\n  if(nc) nc.className='pnl-card '+(net>=0?'primary':'primary-red');\n  const roi = (net/TOTAL_ALLOCATED)*100;\n  setEl('net-roi', (roi>=0?'+':'')+roi.toFixed(2)+'% ROI on $'+TOTAL_ALLOCATED.toLocaleString());\n\n  const total = spot.usdtBalance + margin;\n  setEl('total-capital', fmtUSD(total));\n  const free = total - TOTAL_ALLOCATED;\n  setEl('free-capital', fmtUSD(Math.max(0,free)));\n  const idlePct = Math.max(0, Math.round((free/total)*100));\n  setEl('idle-pct', idlePct+'%');\n  const ib = document.getElementById('idle-bar'); if(ib) ib.style.width=idlePct+'%';\n\n  const longCap=350+100+100+400+300+300+220+249+700+100+100, shortCap=250, totExp=longCap+shortCap;\n  const lPct=Math.round((longCap/totExp)*100), sPct=Math.round((shortCap/totExp)*100);\n  setEl('long-exp', lPct+'%'); setEl('short-exp', sPct+'%');\n  const lb=document.getElementById('exp-long-bar'); if(lb) lb.style.width=lPct+'%';\n  const sb=document.getElementById('exp-short-bar'); if(sb) sb.style.width=sPct+'%';\n  const be=document.getElementById('net-bias');\n  if(be){ be.textContent=lPct>sPct?'LONG':'SHORT'; be.className='bias-badge '+(lPct>sPct?'bias-long':'bias-short'); }\n}\n\nasync function load3CommasBots() {\n  const data = await apiFetch('commas-bots');\n  const CAPS = {16801943:350,16801248:250,16801317:100,16801290:100,194116:100,194115:100};\n  data.bots.forEach(b => {\n    const trades = (b.completedDeals||0)+(b.activeDeals||0);\n    const cap    = CAPS[b.id]||100;\n    const roi    = b.profit ? (b.profit/cap)*100 : 0;\n    setEl('trades-'+b.id, trades);\n    const pe=document.getElementById('pnl-'+b.id);\n    if(pe&&b.profit!==undefined){ pe.textContent=fmtProfit(b.profit); pe.className='stat-value '+cc(b.profit); }\n    // Status driven by score (scores loaded separately via /api/decisions)\n    const st = !b.enabled ? {label:'Paused',cls:'status-paused'} :\n               trades===0  ? {label:'Idle',  cls:'status-idle'}   :\n               roi<-1      ? {label:'Underperforming',cls:'status-underperforming'} :\n                             {label:'Active',cls:'status-active'};\n    setEl('status-'+b.id, st.label, 'status-badge '+st.cls);\n  });\n  window._tcTrades = data.bots.reduce((s,b)=>s+(b.completedDeals||0),0);\n  updateTotalTrades();\n}\n\nasync function loadBinanceBots() {\n  const data = await apiFetch('binance-bots');\n  if(!data.bots) return;\n  const META = {\n    'eth-grid-trades':    {si:'score-eth-grid', sti:'status-eth-grid', chg:'change-eth-grid',   roi:0.83,  type:'spot-grid'    },\n    'btc-dca-trades':     {si:'score-btc-dca',  sti:'status-btc-dca',  chg:'change-btc-dca',    roi:2.54,  type:'spot-dca'     },\n    'bnb-grid-trades':    {si:'score-bnb-grid', sti:'status-bnb-grid', chg:'change-bnb-grid',   roi:0.39,  type:'spot-grid'    },\n    'sol-grid-trades':    {si:'score-sol-grid', sti:'status-sol-grid', chg:'change-sol-grid',   roi:1.83,  type:'spot-grid'    },\n    'xrp-grid-trades':    {si:'score-xrp-grid', sti:'status-xrp-grid', chg:'change-xrp-grid',   roi:-0.32, type:'spot-grid'    },\n    'ethusdt-perp-trades':{si:'score-eth-perp', sti:'status-eth-perp', chg:'change-eth-perp',   roi:1.51,  type:'futures-grid' }\n  };\n  data.bots.forEach(b => {\n    const el=document.getElementById(b.id); if(el) el.textContent=b.trades;\n    const m=META[b.id]; if(!m) return;\n    // 24h change\n    const ce=document.getElementById(m.chg);\n    if(ce&&b.change24h!==undefined){ ce.textContent=fmtChange(b.change24h); ce.style.color=b.change24h>=0?'var(--green)':'var(--red)'; }\n    // Status\n    const st = b.trades===0 ? {label:'Idle',cls:'status-idle'} :\n               m.roi<-1    ? {label:'Underperforming',cls:'status-underperforming'} :\n                              {label:'Active',cls:'status-active'};\n    setEl(m.sti, st.label, 'status-badge '+st.cls);\n  });\n  // Market context panels from live data\n  if (data.market) {\n    const mk = data.market;\n    const re=document.getElementById('market-regime');\n    if(re){ re.textContent=mk.regime; re.style.color=mk.regime==='Bull'?'var(--green)':mk.regime==='Bear'?'var(--red)':'var(--amber)'; }\n    const ve=document.getElementById('market-vol');\n    if(ve){ ve.textContent=mk.volatility; ve.style.color=mk.volatility==='High'?'var(--amber)':mk.volatility==='Low'?'var(--green)':'var(--text)'; }\n    const me=document.getElementById('btc-move');\n    if(me){ me.textContent=fmtChange(mk.btcChange24h); me.style.color=mk.btcChange24h>=0?'var(--green)':'var(--red)'; }\n    const bias=mk.btcChange24h>1?'LONG':mk.btcChange24h<-1?'SHORT':'NEUTRAL';\n    setEl('signal-bias', bias);\n    const absC=Math.abs(mk.btcChange24h);\n    const suit=mk.regime==='Sideways'&&absC<2?'Excellent for Grid':absC>4?'Good for Breakout':mk.regime==='Bull'?'Good for DCA':'Monitor closely';\n    setEl('grid-suit', suit);\n  }\n  window._binanceTrades = data.totalTrades;\n  updateTotalTrades();\n}\n\nfunction updateTotalTrades() {\n  const t=(window._tcTrades||0)+(window._binanceTrades||0);\n  setEl('total-trades-val', t);\n  setEl('total-trades-sub', t+' total trades');\n}\nfunction updateTime() {\n  const n=new Date();\n  const ts=n.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});\n  const ds=n.toLocaleDateString('en-GB',{day:'numeric',month:'short'});\n  document.getElementById('last-updated').textContent='Live \u00b7 '+ts;\n  document.getElementById('sync-time').textContent=ts+' \u00b7 '+ds;\n}\nfunction filterBots(type,btn) {\n  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));\n  btn.classList.add('active');\n  document.querySelectorAll('.bot-card').forEach(c=>{\n    c.style.display=(type==='all'||(c.dataset.type||'').includes(type))?'':'none';\n  });\n}\n\n// ============ REFRESH CYCLES ============\n// Main data: every 30s\n// Decisions: every 15 minutes (server-side engine)\nlet _decisionInterval;\n\nasync function refreshAll() {\n  updateTime();\n  await Promise.allSettled([loadPrices(), loadWallets(), load3CommasBots(), loadBinanceBots()]);\n}\nasync function refreshDecisions() {\n  await loadDecisions();\n}\n\n// ============ AUTH ============\nconst DASHBOARD_PW = 'Underwood10';\nfunction checkPw() {\n  const v=document.getElementById('pw-input').value;\n  if(v===DASHBOARD_PW){\n    document.getElementById('pw-overlay').style.display='none';\n    sessionStorage.setItem('bjbots_auth','1');\n    refreshAll();\n    refreshDecisions();\n    _decisionInterval = setInterval(refreshDecisions, 15 * 60 * 1000); // 15 min\n  } else {\n    document.getElementById('pw-error').style.display='block';\n    document.getElementById('pw-input').value='';\n    document.getElementById('pw-input').focus();\n  }\n}\n\nif(sessionStorage.getItem('bjbots_auth')==='1'){\n  refreshAll();\n  refreshDecisions();\n  _decisionInterval = setInterval(refreshDecisions, 15 * 60 * 1000);\n}\nsetInterval(()=>{if(sessionStorage.getItem('bjbots_auth')==='1')refreshAll();},30000);\nsetInterval(updateTime,1000);\n\ndocument.addEventListener('DOMContentLoaded',()=>{\n  if(sessionStorage.getItem('bjbots_auth')==='1'){\n    document.getElementById('pw-overlay').style.display='none';\n    refreshAll();\n    refreshDecisions();\n    _decisionInterval = setInterval(refreshDecisions, 15 * 60 * 1000);\n  }\n  document.getElementById('pw-input').addEventListener('keydown',e=>{if(e.key==='Enter')checkPw();});\n});\n</script>\n</body>\n</html>\n";

async function serveHTML() {
  return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html' } });
}

// ============================================================
// ROUTER
// ============================================================
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      // System status (ChatGPT improvement — health check)
      if (path === '/api/status') {
        return json({
          executionEnabled: executionAllowed(env),
          advisoryMode:     !executionAllowed(env),
          version:          'v3',
          timestamp:        new Date().toISOString(),
        });
      }

      // Portfolio snapshot (ChatGPT improvement — live dynamic portfolio)
      if (path === '/api/portfolio') {
        return json(getPortfolioSnapshot());
      }

      // Action logs (ChatGPT improvement — audit trail)
      if (path === '/api/logs') {
        const logs = await getActionLogs(env, 100);
        return json({ logs, count: logs.length });
      }

      // READ endpoints
      if (path === '/api/prices')         return await getPrices();
      if (path === '/api/spot-wallet')    return await getSpotWallet(env);
      if (path === '/api/futures-wallet') return await getFuturesWallet(env);
      if (path === '/api/commas-bots')    return await getCommasBots();
      if (path === '/api/binance-bots')   return await getBinanceBots(env);

      // Intelligence engine
      if (path === '/api/decisions')      return await getDecisions(env);

      // WRITE — bot actions (POST only, execution guard, user confirmed in UI)
      if (path.startsWith('/api/bot/') && request.method === 'POST') {
        // Advisory mode check
        if (!executionAllowed(env)) {
          return json({
            success: false,
            error:   'System is in Advisory Mode. Set EXECUTION_ENABLED=true in Cloudflare to enable live actions.',
            advisory: true
          }, 403);
        }
        const parts  = path.split('/');
        const botId  = parts[3];
        const action = parts[4];
        if (!botId || !['enable','disable'].includes(action)) {
          return json({ error:'Usage: POST /api/bot/:id/enable or /api/bot/:id/disable' }, 400);
        }
        // Log the action attempt
        await logAction(env, {
          type:      'bot_action',
          botId,
          action,
          timestamp: new Date().toISOString(),
          botMeta:   getBotMeta(parseInt(botId)||botId),
        });
        return await botAction(env, botId, action);
      }

      // Serve dashboard
      if (path==='/' || path==='/index.html') return await serveHTML();
      return new Response('Not found', { status:404 });

    } catch(e) {
      return json({ error: e.message }, 500);
    }
  }
};
