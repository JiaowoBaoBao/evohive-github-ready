import { config } from './config.js';

async function wsTicker(symbol, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@ticker`);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error('WS_TIMEOUT'));
    }, timeoutMs);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data || '{}'));
        const price = Number(data.c || data.lastPrice || data.p);
        if (Number.isFinite(price) && price > 0) {
          clearTimeout(timer);
          ws.close();
          resolve(price);
        }
      } catch {
        // ignore until timeout
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('WS_ERROR'));
    };
  });
}

async function restTicker(symbol, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`, {
      signal: ctl.signal
    });
    const data = await res.json();
    const p = Number(data.price);
    if (!Number.isFinite(p) || p <= 0) throw new Error('REST_PRICE_INVALID');
    return p;
  } finally {
    clearTimeout(timer);
  }
}

function shocksFromPrices(priceMap, rounds) {
  const symbols = Object.keys(priceMap).sort();
  if (!symbols.length) return Array.from({ length: rounds }, () => 0);

  const avg = symbols.reduce((acc, s) => acc + priceMap[s], 0) / symbols.length;
  return Array.from({ length: rounds }, (_, i) => {
    const symbol = symbols[i % symbols.length];
    const drift = (priceMap[symbol] - avg) / Math.max(avg, 1);
    const phase = Math.sin((i + 1) * 1.7 + symbols.length);
    const shock = Math.max(-1, Math.min(1, drift * 8 + phase * 0.15));
    return Number(shock.toFixed(6));
  });
}

export async function getMarketProfile({ rounds, symbols }) {
  if (config.marketData.mode !== 'live') {
    return {
      source: 'sim',
      symbols,
      shocks: null
    };
  }

  const picked = (symbols?.length ? symbols : config.marketData.symbols).map((s) => String(s || '').replace(/[-_]/g, '').toUpperCase());

  const wsEntries = await Promise.all(
    picked.map(async (s) => {
      try {
        const p = await wsTicker(s, config.marketData.wsTimeoutMs);
        return [s, p];
      } catch {
        return null;
      }
    })
  );

  const wsMap = Object.fromEntries(wsEntries.filter(Boolean));
  if (Object.keys(wsMap).length > 0) {
    return {
      source: 'ws',
      symbols: Object.keys(wsMap),
      shocks: shocksFromPrices(wsMap, rounds)
    };
  }

  const restEntries = await Promise.all(
    picked.map(async (s) => {
      try {
        const p = await restTicker(s, config.marketData.restTimeoutMs);
        return [s, p];
      } catch {
        return null;
      }
    })
  );
  const restMap = Object.fromEntries(restEntries.filter(Boolean));

  if (Object.keys(restMap).length === 0) {
    return {
      source: 'sim-fallback',
      symbols: picked,
      shocks: null
    };
  }

  return {
    source: 'rest',
    symbols: Object.keys(restMap),
    shocks: shocksFromPrices(restMap, rounds)
  };
}
