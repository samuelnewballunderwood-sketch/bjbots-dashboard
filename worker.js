// BJ Bots Dashboard - Cloudflare Worker
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}


async function getMyIP() {
  const res = await fetch('https://api.ipify.org?format=json');
  const data = await res.json();
  return json({ ip: data.ip });
}
async function getPrices(env) {
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

async function getCommasBots(env) {
  // Route through Render proxy which has a whitelisted static IP
  const res = await fetch('https://tc-proxy-h2pp.onrender.com/bots');
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error('Parse error: ' + raw.slice(0,200)); }
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
      const data = await r.json();
      return Array.isArray(data) ? data.length : 0;
    }
    async function futuresTrades(symbol) {
      const q = `symbol=${symbol}&limit=1000&timestamp=${ts}&recvWindow=10000`;
      const sig = await hmacSign(env.BINANCE_SECRET, q);
      const r = await fetch(`https://fapi.binance.com/fapi/v1/userTrades?${q}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }
      });
      const data = await r.json();
      return Array.isArray(data) ? data.length : 0;
    }
    const [ethSpot, btcSpot, bnbSpot, solSpot, xrpSpot, ethFutures] = await Promise.all([
      spotTrades('ETHUSDT'), spotTrades('BTCUSDT'), spotTrades('BNBUSDT'),
      spotTrades('SOLUSDT'), spotTrades('XRPUSDT'), futuresTrades('ETHUSDT')
    ]);
    const bots = [
      { symbol: 'ETHUSDT', type: 'spot-grid', trades: ethSpot, id: 'eth-grid-trades' },
      { symbol: 'BTCUSDT', type: 'spot-dca', trades: btcSpot, id: 'btc-dca-trades' },
      { symbol: 'BNBUSDT', type: 'spot-grid', trades: bnbSpot, id: 'bnb-grid-trades' },
      { symbol: 'SOLUSDT', type: 'spot-grid', trades: solSpot, id: 'sol-grid-trades' },
      { symbol: 'XRPUSDT', type: 'spot-grid', trades: xrpSpot, id: 'xrp-grid-trades' },
      { symbol: 'ETHUSDT-FUTURES', type: 'futures-grid', trades: ethFutures, id: 'eth-perp-trades' },
    ];
    return json({ bots, totalTrades: bots.reduce((s,b) => s+b.trades,0) });
  } catch(e) {
    return json({ error: e.message, bots: [], totalTrades: 0 });
  }
}

async function getTCHeaders(env) {
  const path = '/public/api/ver1/bots?limit=50&sort_by=created_at&sort_direction=desc';
  const sig = await hmacSign(env.TC_SECRET, path);
  return json({ apiKey: env.TC_API_KEY, signature: sig, path });
}

async function serveHTML(env) {
  return new Response(DASHBOARD_HTML, {
    headers: { 'Content-Type': 'text/html' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (path === '/api/myip') return await getMyIP();
      if (path === '/api/prices') return await getPrices(env);
      if (path === '/api/spot-wallet') return await getSpotWallet(env);
      if (path === '/api/futures-wallet') return await getFuturesWallet(env);
      if (path === '/api/commas-bots') return await getCommasBots(env);
      if (path === '/api/binance-bots') return await getBinanceBots(env);
      if (path === '/api/tc-headers') return await getTCHeaders(env);
      if (path === '/' || path === '/index.html') return await serveHTML(env);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};
