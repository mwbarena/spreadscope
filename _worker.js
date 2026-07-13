// SpreadScope Worker v2 — multi-exchange funding rate proxy
// Sources: OKX, Bybit, Hyperliquid (all public, no keys needed), Binance (best-effort, likely IP-blocked from Cloudflare Workers)
//
// Coin universe = a curated liquid-coin base list UNION today's top 24h movers (by |% change|)
// pulled live from Bybit's bulk ticker feed. Movers are where cross-exchange funding gaps tend
// to be widest, since traders pile into one exchange faster than funding rates re-equalize.

const CURATED_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT",
  "ADAUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT","TRXUSDT",
  "NEARUSDT","ARBUSDT","OPUSDT","SUIUSDT","APTUSDT","INJUSDT","TIAUSDT","POLUSDT"
];
const MOVER_COUNT = 15; // how many top 24h movers to pull in alongside the curated list

// ---------- Bybit (bulk: funding rate + 24h % change for every linear USDT perp) ----------
async function fetchBybitFull() {
  try {
    const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
    const data = await res.json();
    const list = data?.result?.list || [];
    const rates = {};
    const movers = []; // {symbol, changePct}
    for (const item of list) {
      if (!item.symbol?.endsWith("USDT")) continue;
      const rate = parseFloat(item.fundingRate);
      const change = parseFloat(item.price24hPcnt);
      if (!isNaN(rate)) rates[item.symbol] = rate * 100;
      if (!isNaN(change)) movers.push({ symbol: item.symbol, changePct: change * 100 });
    }
    movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    const topMovers = movers.slice(0, MOVER_COUNT).map(m => m.symbol);
    return { ok: true, rates, topMovers, moverChange: Object.fromEntries(movers.map(m => [m.symbol, m.changePct])) };
  } catch (e) {
    return { ok: false, error: String(e), rates: {}, topMovers: [], moverChange: {} };
  }
}

// ---------- OKX (instId derived directly from symbol, no static mapping needed) ----------
async function fetchOKX(symbols) {
  try {
    const results = await Promise.all(
      symbols.map(async (sym) => {
        const base = sym.replace("USDT", "");
        try {
          const res = await fetch(
            `https://www.okx.com/api/v5/public/funding-rate?instId=${base}-USDT-SWAP`,
            { headers: { "User-Agent": "Mozilla/5.0" } }
          );
          if (!res.ok) return [sym, null];
          const json = await res.json();
          const rate = json?.data?.[0]?.fundingRate;
          return [sym, rate !== undefined ? parseFloat(rate) * 100 : null];
        } catch { return [sym, null]; }
      })
    );
    const out = {};
    for (const [sym, rate] of results) if (rate !== null) out[sym] = rate;
    return { ok: Object.keys(out).length > 0, rates: out };
  } catch (e) {
    return { ok: false, error: String(e), rates: {} };
  }
}

// ---------- Hyperliquid ----------
// Funding is quoted hourly; normalized to an 8h-equivalent (approximation) to compare
// with the other exchanges' 8h funding convention.
async function fetchHyperliquid(symbols) {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    });
    if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
    const json = await res.json();
    const universe = json?.[0]?.universe || [];
    const ctxs = json?.[1] || [];
    const nameToRate = {};
    universe.forEach((u, i) => {
      const funding = ctxs?.[i]?.funding;
      if (funding !== undefined) nameToRate[u.name] = parseFloat(funding) * 100 * 8;
    });
    const out = {};
    for (const sym of symbols) {
      const base = sym.replace("USDT", "");
      if (nameToRate[base] !== undefined) out[sym] = nameToRate[base];
    }
    return { ok: Object.keys(out).length > 0, rates: out };
  } catch (e) {
    return { ok: false, error: String(e), rates: {} };
  }
}

// ---------- Binance (best-effort; commonly IP-blocked from Cloudflare Workers regardless of API key) ----------
async function fetchBinance(env, symbols) {
  try {
    const headers = { "User-Agent": "Mozilla/5.0" };
    if (env?.BINANCE_API_KEY) headers["X-MBX-APIKEY"] = env.BINANCE_API_KEY;
    const res = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex", { headers });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const data = await res.json();
    const out = {};
    for (const item of data) {
      if (symbols.includes(item.symbol)) out[item.symbol] = parseFloat(item.lastFundingRate) * 100;
    }
    return { ok: true, rates: out };
  } catch (e) {
    return { ok: false, error: String(e), rates: {} };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rates") {
      // Step 1: get Bybit's full feed first — gives us funding AND today's top movers in one call
      const bybit = await fetchBybitFull();
      const symbols = Array.from(new Set([...CURATED_SYMBOLS, ...bybit.topMovers]));

      // Step 2: fetch the other exchanges for that combined symbol set
      const [okx, hl, binance] = await Promise.all([
        fetchOKX(symbols), fetchHyperliquid(symbols), fetchBinance(env, symbols),
      ]);

      const sources = { okx, bybit, hyperliquid: hl, binance };

      const combined = symbols.map((symbol) => {
        const rates = {};
        for (const [name, src] of Object.entries(sources)) {
          if (src.rates[symbol] !== undefined) rates[name] = src.rates[symbol];
        }
        const names = Object.keys(rates);
        if (names.length < 2) return null;

        let maxName = names[0], minName = names[0];
        for (const n of names) {
          if (rates[n] > rates[maxName]) maxName = n;
          if (rates[n] < rates[minName]) minName = n;
        }
        const spread = rates[maxName] - rates[minName];
        const direction = `Long ${minName} / Short ${maxName}`;
        const isMover = bybit.topMovers.includes(symbol);
        const change24h = bybit.moverChange[symbol] ?? null;

        return { symbol, rates, spread, direction, isMover, change24h };
      }).filter(Boolean).sort((a, b) => b.spread - a.spread);

      return new Response(
        JSON.stringify({
          timestamp: Date.now(),
          sources_ok: { okx: okx.ok, bybit: bybit.ok, hyperliquid: hl.ok, binance: binance.ok },
          sources_error: {
            okx: okx.error || null, bybit: bybit.error || null,
            hyperliquid: hl.error || null, binance: binance.error || null,
          },
          data: combined,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    return env.ASSETS.fetch(request);
  },
};
