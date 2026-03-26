// AlphaControl - Cloudflare Worker
// Handles all API requests server-side, keeping keys hidden

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ── READ ENDPOINTS ────────────────────────────────────────────────────────────

async function getPrices() {
  const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT"]');
  const data = await res.json();
  const prices = {};
  data.forEach(p => prices[p.symbol] = parseFloat(p.price));
  return json(prices);
}

async function getSpotWallet(env) {
  const ts = Date.now();
  const query = `timestamp=${ts}&recvWindow=10000`;
  const sig = await hmacSign(env.BINANCE_SECRET, query);
  const res = await fetch(`https://api.binance.com/api/v3/account?${query}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }
  });
  const data = await res.json();
  if (data.msg) throw new Error(data.msg);
  const usdt = data.balances.find(b => b.asset === 'USDT');
  const usdtBal = usdt ? parseFloat(usdt.free) + parseFloat(usdt.locked) : 0;
  const nonZero = data.balances.filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0);
  return json({
    usdtBalance: usdtBal,
    assetCount: nonZero.length,
    balances: nonZero.map(b => ({
      asset: b.asset,
      free: parseFloat(b.free),
      locked: parseFloat(b.locked)
    }))
  });
}

async function getFuturesWallet(env) {
  const ts = Date.now();
  const query = `timestamp=${ts}&recvWindow=10000`;
  const sig = await hmacSign(env.BINANCE_SECRET, query);
  const res = await fetch(`https://fapi.binance.com/fapi/v2/account?${query}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }
  });
  const data = await res.json();
  if (data.msg) throw new Error(data.msg);
  return json({
    marginBalance: parseFloat(data.totalMarginBalance || 0),
    walletBalance: parseFloat(data.totalWalletBalance || 0),
    unrealizedPnl: parseFloat(data.totalUnrealizedProfit || 0),
    availableBalance: parseFloat(data.availableBalance || 0)
  });
}

async function getCommasBots() {
  const res = await fetch('https://tc-proxy-h2pp.onrender.com/bots');
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('Parse error: ' + raw.slice(0, 200));
  }
  if (data.error) throw new Error(data.error);
  return json(data);
}

async function getBinanceBots(env) {
  try {
    const ts = Date.now();

    async function spotTrades(symbol) {
      const q = `symbol=${symbol}&limit=1000&timestamp=${ts}&recvWindow=10000`;
      const sig = await hmacSign(env.BINANCE_SECRET, q);
      const r = await fetch(`https://api.binance.com/api/v3/myTrades?${q}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }
      });
      const d = await r.json();
      return Array.isArray(d) ? d.length : 0;
    }

    async function futuresTrades(symbol) {
      const q = `symbol=${symbol}&limit=1000&timestamp=${ts}&recvWindow=10000`;
      const sig = await hmacSign(env.BINANCE_SECRET, q);
      const r = await fetch(`https://fapi.binance.com/fapi/v1/userTrades?${q}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }
      });
      const d = await r.json();
      return Array.isArray(d) ? d.length : 0;
    }

    async function get24hChange() {
      const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT","BNBUSDT"]');
      const d = await r.json();
      const changes = {};
      d.forEach(t => {
        changes[t.symbol] = {
          change: parseFloat(t.priceChangePercent),
          volume: parseFloat(t.quoteVolume),
          high: parseFloat(t.highPrice),
          low: parseFloat(t.lowPrice)
        };
      });
      return changes;
    }

    const [ethSpot, btcSpot, bnbSpot, solSpot, xrpSpot, ethFutures, changes] = await Promise.all([
      spotTrades('ETHUSDT'),
      spotTrades('BTCUSDT'),
      spotTrades('BNBUSDT'),
      spotTrades('SOLUSDT'),
      spotTrades('XRPUSDT'),
      futuresTrades('ETHUSDT'),
      get24hChange()
    ]);

    const bots = [
      { symbol: 'ETHUSDT', type: 'spot-grid', trades: ethSpot, id: 'eth-grid-trades', change24h: changes['ETHUSDT']?.change || 0 },
      { symbol: 'BTCUSDT', type: 'spot-dca', trades: btcSpot, id: 'btc-dca-trades', change24h: changes['BTCUSDT']?.change || 0 },
      { symbol: 'BNBUSDT', type: 'spot-grid', trades: bnbSpot, id: 'bnb-grid-trades', change24h: changes['BNBUSDT']?.change || 0 },
      { symbol: 'SOLUSDT', type: 'spot-grid', trades: solSpot, id: 'sol-grid-trades', change24h: changes['SOLUSDT']?.change || 0 },
      { symbol: 'XRPUSDT', type: 'spot-grid', trades: xrpSpot, id: 'xrp-grid-trades', change24h: changes['XRPUSDT']?.change || 0 },
      { symbol: 'ETHUSDT-FUTURES', type: 'futures-grid', trades: ethFutures, id: 'ethusdt-perp-trades', change24h: changes['ETHUSDT']?.change || 0 }
    ];

    const btcChange = changes['BTCUSDT']?.change || 0;
    const btcVol = Math.abs(btcChange);
    const regime = btcChange > 2 ? 'Bull' : btcChange < -2 ? 'Bear' : 'Sideways';
    const volatility = btcVol > 4 ? 'High' : btcVol > 1.5 ? 'Medium' : 'Low';

    return json({
      bots,
      totalTrades: bots.reduce((s, b) => s + b.trades, 0),
      market: { regime, volatility, btcChange24h: btcChange, changes }
    });
  } catch (e) {
    return json({ error: e.message, bots: [], totalTrades: 0 });
  }
}

// ── WRITE ENDPOINTS ───────────────────────────────────────────────────────────

async function botAction(env, botId, action) {
  const url = `https://tc-proxy-h2pp.onrender.com/bot/${botId}/${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('Parse error: ' + raw.slice(0, 200));
  }
  if (!data.success) throw new Error(data.error || 'Action failed');
  return json(data);
}

// ── SCORING ENGINE ────────────────────────────────────────────────────────────

function scoreBot({ roi, trades, drawdownPct, change24h, type }) {
  const roiScore = Math.min(100, Math.max(0, 50 + roi * 15));
  const ddScore = Math.min(100, Math.max(0, 100 - drawdownPct * 4));
  const actScore = Math.min(100, trades * 8);
  const conScore = trades > 5 ? 80 : trades > 0 ? 40 + trades * 8 : 15;
  const absChange = Math.abs(change24h);
  const marketFit =
    type === 'spot-grid' || type === 'futures-grid'
      ? (absChange < 2 ? 80 : absChange < 4 ? 55 : 35)
      : (absChange > 1 ? 75 : 45);

  return Math.round(
    roiScore * 0.30 +
    ddScore * 0.25 +
    actScore * 0.15 +
    conScore * 0.15 +
    marketFit * 0.15
  );
}

function decisionEngine({ bots, tcBots, floatingPnl, longPct, market }) {
  const decisions = [];
  const now = new Date().toISOString();

  const signalBotIds = [194116, 194115];
  const signalBots = tcBots.filter(b => signalBotIds.includes(b.id));
  const signalIdle = signalBots.filter(b => b.completedDeals === 0 && b.activeDeals === 0);

  if (signalIdle.length > 0) {
    decisions.push({
      action: 'PAUSE',
      type: 'pause',
      target: signalIdle.map(b => b.id),
      text: 'Pause Signal Bots',
      reason: `${signalIdle.length} signal bot(s) have 0 executions and no positive PnL. Capital allocated but idle.`,
      confidence: 85,
      executable: true,
      botIds: signalIdle.map(b => b.id)
    });
  }

  const xrp = bots.find(b => b.id === 'xrp-grid-trades');
  if (xrp && xrp.trades < 3) {
    decisions.push({
      action: 'REVIEW',
      type: 'reduce',
      text: 'Review XRP/USDT Grid',
      reason: `Only ${xrp.trades} trade(s) recorded. Bot shows negative ROI. Market may not suit this grid range.`,
      confidence: 72,
      executable: false
    });
  }

  if (longPct > 65) {
    decisions.push({
      action: 'INCREASE',
      type: 'increase',
      text: 'Scale Hedge Allocation',
      reason: `Portfolio is ${longPct.toFixed(0)}% long-biased. ${market.regime === 'Bear' ? 'Bear market detected — ' : ''}Hedge bot should be scaled to reduce directional risk.`,
      confidence: longPct > 80 ? 88 : 74,
      executable: false,
      note: 'Manual action required — adjust hedge bot size in 3Commas'
    });
  }

  const btcDca = bots.find(b => b.id === 'btc-dca-trades');
  if (btcDca && btcDca.trades > 5) {
    decisions.push({
      action: 'HOLD',
      type: 'hold',
      text: 'Hold BTC/USDT DCA',
      reason: `Top performer with ${btcDca.trades} completed trades. Consistent execution in current market — do not disturb.`,
      confidence: 90,
      executable: false
    });
  }

  const idleTcBots = tcBots.filter(b =>
    !signalBotIds.includes(b.id) &&
    b.id !== 16801248 &&
    b.completedDeals === 0 &&
    b.activeDeals <= 1
  );

  if (idleTcBots.length > 0) {
    decisions.push({
      action: 'REVIEW',
      type: 'reduce',
      text: `Review ${idleTcBots.length} Idle DCA Bot(s)`,
      reason: `${idleTcBots.map(b => b.name).join(', ')}: 0 completed deals. Verify positions are actually active in 3Commas.`,
      confidence: 65,
      executable: false
    });
  }

  if (floatingPnl < -10) {
    decisions.push({
      action: 'ALERT',
      type: 'pause',
      text: 'Floating Loss Warning',
      reason: `Net floating PnL is $${floatingPnl.toFixed(2)}. Open futures positions are underwater. Monitor closely and consider reducing exposure.`,
      confidence: 82,
      executable: false
    });
  }

  if (market.regime === 'Bull' && market.volatility === 'High') {
    decisions.push({
      action: 'REVIEW',
      type: 'reduce',
      text: 'High Volatility — Review Grid Ranges',
      reason: `BTC moved ${market.btcChange24h.toFixed(1)}% in 24h. High volatility may push grid bots outside their set ranges.`,
      confidence: 70,
      executable: false
    });
  }

  return { decisions, generatedAt: now, marketSnapshot: market };
}

async function getBinanceBotsData(env) {
  const res = await getBinanceBots(env);
  const text = await res.text();
  return JSON.parse(text);
}

async function getFuturesWalletData(env) {
  const res = await getFuturesWallet(env);
  const text = await res.text();
  return JSON.parse(text);
}

async function getDecisions(env) {
  try {
    const [tcData, bnData, futData] = await Promise.all([
      fetch('https://tc-proxy-h2pp.onrender.com/bots').then(r => r.json()),
      getBinanceBotsData(env),
      getFuturesWalletData(env)
    ]);

    const longCap = 350 + 100 + 100 + 400 + 300 + 300 + 220 + 249 + 700 + 100 + 100;
    const shortCap = 250;
    const longPct = Math.round((longCap / (longCap + shortCap)) * 100);

    const result = decisionEngine({
      bots: bnData.bots || [],
      tcBots: tcData.bots || [],
      floatingPnl: futData.unrealizedPnl || 0,
      longPct,
      market: bnData.market || { regime: 'Unknown', volatility: 'Unknown', btcChange24h: 0 }
    });

    const scores = {};
    const tcBots = tcData.bots || [];
    const bnBots = bnData.bots || [];

    tcBots.forEach(b => {
      const capital = {
        16801943: 350,
        16801248: 250,
        16801317: 100,
        16801290: 100,
        194116: 100,
        194115: 100
      }[b.id] || 100;

      const roi = b.profit ? (b.profit / capital) * 100 : 0;
      const trades = (b.completedDeals || 0) + (b.activeDeals || 0);

      scores[b.id] = scoreBot({
        roi,
        trades,
        drawdownPct: roi < 0 ? Math.abs(roi) : 0,
        change24h: bnData.market?.btcChange24h || 0,
        type: 'dca'
      });
    });

    bnBots.forEach(b => {
      const META = {
        'eth-grid-trades': { roi: 0.83, cap: 400, type: 'spot-grid' },
        'btc-dca-trades': { roi: 2.54, cap: 300, type: 'spot-dca' },
        'bnb-grid-trades': { roi: 0.39, cap: 300, type: 'spot-grid' },
        'sol-grid-trades': { roi: 1.83, cap: 220, type: 'spot-grid' },
        'xrp-grid-trades': { roi: -0.32, cap: 249, type: 'spot-grid' },
        'ethusdt-perp-trades': { roi: 1.51, cap: 700, type: 'futures-grid' }
      };
      const m = META[b.id];
      if (m) {
        scores[b.id] = scoreBot({
          roi: m.roi,
          trades: b.trades,
          drawdownPct: m.roi < 0 ? Math.abs(m.roi) : 0,
          change24h: b.change24h || 0,
          type: m.type
        });
      }
    });

    return json({ ...result, scores });
  } catch (e) {
    return json({ error: e.message, decisions: [], scores: {} }, 500);
  }
}

// ── ROUTER ────────────────────────────────────────────────────────────────────

async function serveHTML() {
  return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/portfolio') {
      const BOT_META = {
        16801943: { capital: 350, direction: 'long' },
        16801248: { capital: 250, direction: 'short' },
        16801317: { capital: 100, direction: 'long' },
        16801290: { capital: 100, direction: 'long' },
        194116: { capital: 100, direction: 'long' },
        194115: { capital: 100, direction: 'long' },

        'eth-grid-trades': { capital: 400, direction: 'long' },
        'btc-dca-trades': { capital: 300, direction: 'long' },
        'bnb-grid-trades': { capital: 300, direction: 'long' },
        'sol-grid-trades': { capital: 220, direction: 'long' },
        'xrp-grid-trades': { capital: 249, direction: 'long' },
        'ethusdt-perp-trades': { capital: 700, direction: 'long' }
      };

      const bots = Object.values(BOT_META);
      const total = bots.reduce((s, b) => s + b.capital, 0);
      const long = bots.filter(b => b.direction === 'long').reduce((s, b) => s + b.capital, 0);
      const short = bots.filter(b => b.direction === 'short').reduce((s, b) => s + b.capital, 0);

      return new Response(JSON.stringify({
        total,
        long,
        short,
        longPct: Math.round((long / total) * 100),
        shortPct: Math.round((short / total) * 100)
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (path === '/api/prices') return await getPrices();
      if (path === '/api/spot-wallet') return await getSpotWallet(env);
      if (path === '/api/futures-wallet') return await getFuturesWallet(env);
      if (path === '/api/commas-bots') return await getCommasBots();
      if (path === '/api/binance-bots') return await getBinanceBots(env);
      if (path === '/api/decisions') return await getDecisions(env);

      if (path.startsWith('/api/bot/') && request.method === 'POST') {
        const parts = path.split('/');
        const botId = parts[3];
        const action = parts[4];

        if (!botId || !['enable', 'disable'].includes(action)) {
          return json({ error: 'Usage: POST /api/bot/:id/enable or /api/bot/:id/disable' }, 400);
        }

        return await botAction(env, botId, action);
      }

      if (path === '/' || path === '/index.html') return await serveHTML();
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
