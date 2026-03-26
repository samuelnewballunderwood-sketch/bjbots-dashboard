// AlphaControl - Cloudflare Worker v3
// BOT_META engine, portfolio snapshot, advisory mode, action logging
// DASHBOARD_HTML is injected by build.js at deploy time

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
// BOT METADATA — Single source of truth
// Update here when portfolio changes — everything derives from this
// ============================================================
const BOT_META = {
  16801943: { name:'BTC Long Futures Bot',   capital:350, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'futures', symbol:'BTCUSDT' },
  16801248: { name:'BTC Hedge Bot',           capital:250, direction:'short', strategy:'dca',    venue:'3commas', marketType:'futures', symbol:'BTCUSDT' },
  16801317: { name:'BTC Break Out Bot',       capital:100, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'spot',    symbol:'BTCUSDT' },
  16801290: { name:'USDT Stable Coin Engine', capital:100, direction:'long',  strategy:'dca',    venue:'3commas', marketType:'spot',    symbol:'BTCUSDT' },
  194116:   { name:'BTC Binance Signal Bot',  capital:100, direction:'long',  strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'BTCUSDT' },
  194115:   { name:'ETH Binance Signal Bot',  capital:100, direction:'long',  strategy:'signal', venue:'3commas', marketType:'spot',    symbol:'ETHUSDT' },
  'eth-grid-trades':    { name:'ETH/USDT Spot Grid',   capital:400, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'ETHUSDT', roi:0.83,  scoreType:'spot-grid'    },
  'btc-dca-trades':     { name:'BTC/USDT Spot DCA',    capital:300, direction:'long', strategy:'dca',  venue:'binance', marketType:'spot',    symbol:'BTCUSDT', roi:2.54,  scoreType:'spot-dca'     },
  'bnb-grid-trades':    { name:'BNB/USDT Spot Grid',   capital:300, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'BNBUSDT', roi:0.39,  scoreType:'spot-grid'    },
  'sol-grid-trades':    { name:'SOL/USDT Spot Grid',   capital:220, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'SOLUSDT', roi:1.83,  scoreType:'spot-grid'    },
  'xrp-grid-trades':    { name:'XRP/USDT Spot Grid',   capital:249, direction:'long', strategy:'grid', venue:'binance', marketType:'spot',    symbol:'XRPUSDT', roi:-0.32, scoreType:'spot-grid'    },
  'ethusdt-perp-trades':{ name:'ETHUSDT Futures Grid', capital:700, direction:'long', strategy:'grid', venue:'binance', marketType:'futures', symbol:'ETHUSDT', roi:1.51,  scoreType:'futures-grid' },
};

// ============================================================
// PORTFOLIO SNAPSHOT — Dynamic, derived from BOT_META
// ============================================================
function getPortfolioSnapshot() {
  const bots = Object.entries(BOT_META).map(([id, m]) => ({ id, ...m }));
  const totalAllocated = bots.reduce((s,b) => s + b.capital, 0);
  const longCapital    = bots.filter(b => b.direction==='long').reduce((s,b)  => s + b.capital, 0);
  const shortCapital   = bots.filter(b => b.direction==='short').reduce((s,b) => s + b.capital, 0);
  const byStrategy = bots.reduce((acc,b) => { acc[b.strategy]=(acc[b.strategy]||0)+b.capital; return acc; }, {});
  const byVenue    = bots.reduce((acc,b) => { acc[b.venue]=(acc[b.venue]||0)+b.capital; return acc; }, {});
  const bySymbol   = bots.reduce((acc,b) => { acc[b.symbol]=(acc[b.symbol]||0)+b.capital; return acc; }, {});
  return {
    totalAllocated, longCapital, shortCapital,
    longPct:  totalAllocated ? Math.round((longCapital/totalAllocated)*100) : 0,
    shortPct: totalAllocated ? Math.round((shortCapital/totalAllocated)*100) : 0,
    byStrategy, byVenue, bySymbol, botCount: bots.length,
  };
}

function getBotMeta(botId) {
  return BOT_META[botId] || BOT_META[String(botId)] || null;
}

// ============================================================
// EXECUTION GUARD — Advisory mode
// ============================================================
function executionAllowed(env) {
  return env.EXECUTION_ENABLED === 'true';
}

// ============================================================
// SCORING ENGINE
// ============================================================
function scoreBot({ roi, trades, drawdownPct, change24h, type, capital }) {
  const roiScore      = Math.min(100, Math.max(0, 50 + roi * 15));
  const ddScore       = Math.min(100, Math.max(0, 100 - drawdownPct * 4));
  const actScore      = Math.min(100, trades * 8);
  const conScore      = trades > 5 ? 80 : trades > 0 ? 40 + trades*8 : 15;
  const absChange     = Math.abs(change24h);
  const marketFit     = (type==='spot-grid'||type==='futures-grid')
    ? (absChange < 2 ? 80 : absChange < 4 ? 55 : 35)
    : (absChange > 1 ? 75 : 45);
  // Capital efficiency: return per dollar allocated (higher = better use of capital)
  const capEfficiency = capital && capital > 0 ? Math.min(100, Math.max(0, 50 + (roi / 100) * capital * 0.1)) : 50;
  return Math.round(roiScore*0.25 + ddScore*0.25 + actScore*0.15 + conScore*0.15 + marketFit*0.10 + capEfficiency*0.10);
}

// Capital efficiency: actual return per $ allocated
function capitalEfficiency(roi, capital) {
  if (!capital || capital === 0) return 0;
  return parseFloat(((roi / 100) * capital).toFixed(2)); // $ return on capital
}

// ============================================================
// DECISION ENGINE — Recommendation engine (rules-based)
// ============================================================
function decisionEngine({ bots, tcBots, floatingPnl, portfolio, market }) {
  const decisions = [];
  const now = new Date().toISOString();
  const { longPct, bySymbol, totalAllocated } = portfolio;

  // 1. Signal bots idle
  const signalBotIds = [194116, 194115];
  const signalIdle = tcBots.filter(b => signalBotIds.includes(b.id) && b.completedDeals===0 && b.activeDeals===0);
  if (signalIdle.length > 0) {
    decisions.push({ action:'PAUSE', type:'pause', severity:'high',
      text:'Pause Signal Bots',
      reason:`${signalIdle.length} signal bot(s) have 0 executions. Capital allocated but generating no return.`,
      confidence:85, executable:true, botIds:signalIdle.map(b=>b.id) });
  }

  // 2. XRP low activity + negative ROI
  const xrp = bots.find(b => b.id==='xrp-grid-trades');
  if (xrp && xrp.trades < 3) {
    decisions.push({ action:'REVIEW', type:'reduce', severity:'medium',
      text:'Review XRP/USDT Grid',
      reason:`Only ${xrp.trades} trade(s) recorded. Negative ROI. Grid range may not suit current market.`,
      confidence:72, executable:false });
  }

  // 3. Long bias / hedge scaling
  if (longPct > 65) {
    decisions.push({ action:'INCREASE', type:'increase', severity:'medium',
      text:'Scale Hedge Allocation',
      reason:`Portfolio is ${longPct}% long-biased${market.regime==='Bear'?' in a Bear market — heightened risk':''}. Consider scaling hedge bot.`,
      confidence: longPct > 80 ? 88 : 74, executable:false,
      note:'Manual — adjust hedge bot size in 3Commas' });
  }

  // 4. BTC concentration risk (asset overlap detection)
  const btcExposure = bySymbol['BTCUSDT'] || 0;
  const btcPct = totalAllocated ? Math.round((btcExposure/totalAllocated)*100) : 0;
  if (btcPct > 45) {
    decisions.push({ action:'REVIEW', type:'reduce', severity:'medium',
      text:`High BTC Concentration (${btcPct}%)`,
      reason:`${btcPct}% of portfolio is BTC-correlated across multiple bots. Single-asset risk is elevated.`,
      confidence:70, executable:false });
  }

  // 5. Best performer — protect
  const btcDca = bots.find(b => b.id==='btc-dca-trades');
  if (btcDca && btcDca.trades > 5) {
    decisions.push({ action:'HOLD', type:'hold', severity:'low',
      text:'Hold BTC/USDT DCA',
      reason:`Top performer with ${btcDca.trades} completed trades (+2.54% ROI). Do not disturb.`,
      confidence:90, executable:false });
  }

  // 6. Idle 3Commas DCA bots + stale bot detection
  const idleTcBots = tcBots.filter(b => !signalBotIds.includes(b.id) && b.id!==16801248 && b.completedDeals===0 && b.activeDeals<=1);
  if (idleTcBots.length > 0) {
    decisions.push({ action:'REVIEW', type:'reduce', severity:'low',
      text:`Review ${idleTcBots.length} Idle DCA Bot(s)`,
      reason:`${idleTcBots.map(b=>b.name).join(', ')}: 0 completed deals. Capital allocated but not working.`,
      confidence:65, executable:false });
  }

  // Stale bot detection — bots with very low trades relative to capital
  const staleBots = bots.filter(b => {
    const meta = BOT_META[b.id];
    if (!meta) return false;
    const capitalEffRatio = meta.capital / Math.max(b.trades, 0.01);
    return b.trades < 2 && meta.capital >= 200; // High capital, barely trading
  });
  if (staleBots.length > 0) {
    decisions.push({ action:'REVIEW', type:'reduce', severity:'low',
      text:`${staleBots.length} Stale Bot(s) Detected`,
      reason:`${staleBots.map(b=>BOT_META[b.id]?.name||b.id).join(', ')}: high capital allocation with very few trades. Consider rebalancing.`,
      confidence:60, executable:false });
  }

  // 7. Floating loss
  if (floatingPnl < -10) {
    decisions.push({ action:'ALERT', type:'pause', severity:'high',
      text:'Floating Loss Warning',
      reason:`Net floating PnL is $${floatingPnl.toFixed(2)}. Open futures positions underwater — monitor closely.`,
      confidence:82, executable:false });
  }

  // 8. High volatility grid warning
  if (market.regime==='Bull' && market.volatility==='High') {
    decisions.push({ action:'REVIEW', type:'reduce', severity:'medium',
      text:'High Volatility — Review Grid Ranges',
      reason:`BTC moved ${market.btcChange24h.toFixed(1)}% in 24h. High volatility may push grids outside their ranges.`,
      confidence:70, executable:false });
  }

  // Sort: high → medium → low
  const order = { high:0, medium:1, low:2 };
  decisions.sort((a,b) => (order[a.severity]||2) - (order[b.severity]||2));

  return { decisions, generatedAt: now, marketSnapshot: market, portfolio };
}

// ============================================================
// ACTION LOGGING — Audit trail (requires KV binding ALPHA_LOGS)
// ============================================================
async function logAction(env, entry) {
  try {
    if (!env.ALPHA_LOGS) return;
    await env.ALPHA_LOGS.put('log:' + Date.now(), JSON.stringify(entry), { expirationTtl: 60*60*24*90 });
  } catch(e) { console.warn('Log write failed:', e.message); }
}

async function getActionLogs(env) {
  try {
    if (!env.ALPHA_LOGS) return [];
    const list = await env.ALPHA_LOGS.list({ prefix:'log:', limit:100 });
    const entries = await Promise.all(list.keys.map(k => env.ALPHA_LOGS.get(k.name, 'json')));
    return entries.filter(Boolean).reverse();
  } catch(e) { return []; }
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
  const res = await fetch(`https://api.binance.com/api/v3/account?${query}&signature=${sig}`, { headers:{'X-MBX-APIKEY':env.BINANCE_API_KEY} });
  const data = await res.json();
  if (data.msg) throw new Error(data.msg);
  const usdt = data.balances.find(b=>b.asset==='USDT');
  const usdtBal = usdt ? parseFloat(usdt.free)+parseFloat(usdt.locked) : 0;
  const nonZero = data.balances.filter(b=>parseFloat(b.free)+parseFloat(b.locked)>0);
  return json({ usdtBalance:usdtBal, assetCount:nonZero.length, balances:nonZero.map(b=>({ asset:b.asset, free:parseFloat(b.free), locked:parseFloat(b.locked) })) });
}

async function getFuturesWallet(env) {
  const ts=Date.now(), query=`timestamp=${ts}&recvWindow=10000`;
  const sig = await hmacSign(env.BINANCE_SECRET, query);
  const res = await fetch(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${sig}`, { headers:{'X-MBX-APIKEY':env.BINANCE_API_KEY} });
  const data = await res.json();
  if (data.msg) throw new Error(data.msg);
  return json({ marginBalance:parseFloat(data.totalMarginBalance||0), walletBalance:parseFloat(data.totalWalletBalance||0), unrealizedPnl:parseFloat(data.totalUnrealizedProfit||0), availableBalance:parseFloat(data.availableBalance||0) });
}

async function getCommasBots() {
  const res = await fetch('https://tc-proxy-h2pp.onrender.com/bots');
  const raw = await res.text();
  let data;
  try { data=JSON.parse(raw); } catch(e) { throw new Error('Parse error: '+raw.slice(0,200)); }
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
      { symbol:'ETHUSDT',        type:'spot-grid',    trades:ethSpot,    id:'eth-grid-trades',     change24h:changes['ETHUSDT']?.change||0 },
      { symbol:'BTCUSDT',        type:'spot-dca',     trades:btcSpot,    id:'btc-dca-trades',      change24h:changes['BTCUSDT']?.change||0 },
      { symbol:'BNBUSDT',        type:'spot-grid',    trades:bnbSpot,    id:'bnb-grid-trades',     change24h:changes['BNBUSDT']?.change||0 },
      { symbol:'SOLUSDT',        type:'spot-grid',    trades:solSpot,    id:'sol-grid-trades',     change24h:changes['SOLUSDT']?.change||0 },
      { symbol:'XRPUSDT',        type:'spot-grid',    trades:xrpSpot,    id:'xrp-grid-trades',     change24h:changes['XRPUSDT']?.change||0 },
      { symbol:'ETHUSDT-FUTURES',type:'futures-grid', trades:ethFutures, id:'ethusdt-perp-trades', change24h:changes['ETHUSDT']?.change||0 },
    ];
    const btcChange=changes['BTCUSDT']?.change||0, btcVol=Math.abs(btcChange);
    return json({ bots, totalTrades:bots.reduce((s,b)=>s+b.trades,0),
      market:{ regime:btcChange>2?'Bull':btcChange<-2?'Bear':'Sideways', volatility:btcVol>4?'High':btcVol>1.5?'Medium':'Low', btcChange24h:btcChange, changes } });
  } catch(e) { return json({ error:e.message, bots:[], totalTrades:0 }); }
}

async function getBinanceBotsData(env) { const res=await getBinanceBots(env); return res.json(); }
async function getFuturesWalletData(env) { const res=await getFuturesWallet(env); return res.json(); }

// ============================================================
// DECISIONS ENDPOINT
// ============================================================
async function getDecisions(env) {
  try {
    const [tcData, bnData, futData] = await Promise.all([
      fetch('https://tc-proxy-h2pp.onrender.com/bots').then(r=>r.json()),
      getBinanceBotsData(env),
      getFuturesWalletData(env)
    ]);
    const portfolio = getPortfolioSnapshot();
    const result = decisionEngine({
      bots:        bnData.bots||[],
      tcBots:      tcData.bots||[],
      floatingPnl: futData.unrealizedPnl||0,
      portfolio,
      market: bnData.market||{ regime:'Unknown', volatility:'Unknown', btcChange24h:0 }
    });
    const scores = {}, market = bnData.market||{};
    ;(tcData.bots||[]).forEach(b => {
      const meta=getBotMeta(b.id), capital=meta?.capital||100;
      const roi=b.profit?(b.profit/capital)*100:0, trades=(b.completedDeals||0)+(b.activeDeals||0);
      const type=meta?.strategy==='signal'?'signal':meta?.marketType==='futures'?'futures-dca':'dca';
      scores[b.id]=scoreBot({ roi, trades, drawdownPct:roi<0?Math.abs(roi):0, change24h:market.btcChange24h||0, type });
    });
    ;(bnData.bots||[]).forEach(b => {
      const meta=getBotMeta(b.id); if(!meta) return;
      scores[b.id]=scoreBot({ roi:meta.roi||0, trades:b.trades, drawdownPct:meta.roi<0?Math.abs(meta.roi||0):0, change24h:b.change24h||0, type:meta.scoreType||'spot-grid' });
    });
    // Capital efficiency per bot
    const efficiency = {};
    Object.entries(BOT_META).forEach(([id, meta]) => {
      if (meta.roi !== undefined) {
        efficiency[id] = capitalEfficiency(meta.roi, meta.capital);
      }
    });

    return json({ ...result, scores, efficiency });
  } catch(e) { return json({ error:e.message, decisions:[], scores:{} }, 500); }
}

// ============================================================
// WRITE ENDPOINTS — Require EXECUTION_ENABLED=true + user confirmation
// ============================================================
async function botAction(env, botId, action) {
  const url=`https://tc-proxy-h2pp.onrender.com/bot/${botId}/${action}`;
  const res=await fetch(url,{ method:'POST', headers:{'Content-Type':'application/json'} });
  const raw=await res.text(); let data;
  try { data=JSON.parse(raw); } catch(e) { throw new Error('Parse error: '+raw.slice(0,200)); }
  if (!data.success) throw new Error(data.error||'Action failed');
  return json(data);
}

// ============================================================
// SERVE HTML — DASHBOARD_HTML injected by build.js
// ============================================================
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
      // Health check
      if (path === '/api/status') {
        return json({ executionEnabled:executionAllowed(env), advisoryMode:!executionAllowed(env), version:'v3', timestamp:new Date().toISOString() });
      }

      // Live portfolio snapshot
      if (path === '/api/portfolio') {
        return json(getPortfolioSnapshot());
      }

      // Action audit log
      if (path === '/api/logs') {
        return json({ logs: await getActionLogs(env) });
      }

      // Read
      if (path === '/api/prices')         return await getPrices();
      if (path === '/api/spot-wallet')    return await getSpotWallet(env);
      if (path === '/api/futures-wallet') return await getFuturesWallet(env);
      if (path === '/api/commas-bots')    return await getCommasBots();
      if (path === '/api/binance-bots')   return await getBinanceBots(env);
      if (path === '/api/decisions')      return await getDecisions(env);

      // Write — bot actions (POST, execution guard enforced, user confirmed in UI)
      if (path.startsWith('/api/bot/') && request.method === 'POST') {
        if (!executionAllowed(env)) {
          return json({ success:false, error:'Advisory Mode — set EXECUTION_ENABLED=true in Cloudflare env to enable live actions.', advisory:true }, 403);
        }
        const parts=path.split('/'), botId=parts[3], action=parts[4];
        if (!botId || !['enable','disable'].includes(action)) {
          return json({ error:'Usage: POST /api/bot/:id/enable or /api/bot/:id/disable' }, 400);
        }
        await logAction(env, { type:'bot_action', botId, action, timestamp:new Date().toISOString(), botMeta:getBotMeta(parseInt(botId)||botId) });
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
