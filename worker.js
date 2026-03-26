// AlphaControl Worker (Updated)
// Advisory Mode + Portfolio Engine

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ================= BOT META =================

const BOT_META = {
  16801943:{capital:350,direction:'long',strategy:'dca',symbol:'BTCUSDT'},
  16801248:{capital:250,direction:'short',strategy:'dca',symbol:'BTCUSDT'},
  16801317:{capital:100,direction:'long',strategy:'dca',symbol:'BTCUSDT'},
  16801290:{capital:100,direction:'long',strategy:'dca',symbol:'BTCUSDT'},
  194116:{capital:100,direction:'long',strategy:'signal',symbol:'BTCUSDT'},
  194115:{capital:100,direction:'long',strategy:'signal',symbol:'ETHUSDT'},

  'eth-grid-trades':{capital:400,direction:'long',strategy:'grid',roi:0.83,type:'spot-grid'},
  'btc-dca-trades':{capital:300,direction:'long',strategy:'dca',roi:2.54,type:'spot-dca'},
  'bnb-grid-trades':{capital:300,direction:'long',strategy:'grid',roi:0.39,type:'spot-grid'},
  'sol-grid-trades':{capital:220,direction:'long',strategy:'grid',roi:1.83,type:'spot-grid'},
  'xrp-grid-trades':{capital:249,direction:'long',strategy:'grid',roi:-0.32,type:'spot-grid'},
  'ethusdt-perp-trades':{capital:700,direction:'long',strategy:'grid',roi:1.51,type:'futures-grid'}
};

function getPortfolio() {
  const bots = Object.entries(BOT_META).map(([id, m]) => ({ id, ...m }));
  const total = bots.reduce((s,b)=>s+b.capital,0);
  const long = bots.filter(b=>b.direction==='long').reduce((s,b)=>s+b.capital,0);
  const short = bots.filter(b=>b.direction==='short').reduce((s,b)=>s+b.capital,0);

  return {
    total,
    long,
    short,
    longPct: Math.round((long/total)*100),
    shortPct: Math.round((short/total)*100)
  };
}

// ================= EXECUTION GUARD =================

function executionAllowed(env){
  return env.EXECUTION_ENABLED === 'true';
}
// ================= SCORE =================

function scoreBot({roi,trades,drawdownPct,change24h,type}){

  const roiScore = Math.min(100, Math.max(0, 50 + roi * 15));
  const ddScore = Math.min(100, Math.max(0, 100 - drawdownPct * 4));
  const actScore = Math.min(100, trades * 8);
  const conScore = trades > 5 ? 80 : trades > 0 ? 40 + trades * 8 : 15;

  const absChange = Math.abs(change24h);
  const marketFit =
    type.includes('grid')
      ? (absChange < 2 ? 80 : absChange < 4 ? 55 : 35)
      : (absChange > 1 ? 75 : 45);

  return Math.round(
    roiScore*0.3 +
    ddScore*0.25 +
    actScore*0.15 +
    conScore*0.15 +
    marketFit*0.15
  );
}

// ================= API =================

export default {
  async fetch(req, env) {

    const url = new URL(req.url);

    if(url.pathname==='/api/status'){
      return json({
        executionEnabled: executionAllowed(env)
      });
    }

    if(url.pathname==='/api/portfolio'){
      return json(getPortfolio());
    }

    if(url.pathname==='/api/decisions'){

      const portfolio = getPortfolio();

      const decisions = [];

      if(portfolio.longPct > 65){
        decisions.push({
          text: "Reduce long exposure",
          reason: "Portfolio heavily long biased",
          confidence: 80,
          executable:false
        });
      }

      return json({
        decisions,
        portfolio
      });
    }

    if(url.pathname.startsWith('/api/bot/')){
      if(!executionAllowed(env)){
        return json({error:'Execution disabled'},403);
      }
    }

    return json({status:'ok'});
  }
};
