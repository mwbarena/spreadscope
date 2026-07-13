// SpreadScope Worker — proxies Binance + Bybit funding rate APIs to avoid browser CORS blocks
// Deploy this as a Cloudflare Pages Function / Worker alongside the static index.html

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];

// OKX perpetual instrument IDs mapped to our display symbols
const OKX_INST = {
  BTCUSDT: "BTC-USDT-SWAP",
  ETHUSDT: "ETH-USDT-SWAP",
  SOLUSDT: "SOL-USDT-SWAP",
  BNBUSDT: "BNB-USDT-SWAP",
  XRPUSDT: "XRP-USDT-SWAP",
  DOGEUSDT: "DOGE-USDT-SWAP",
};
const BYBIT_URL = "https://api.bybit.com/v5/market/tickers?category=linear";

async function fetchOKX() {
  try {
    const entries = Object.entries(OKX_INST);
    const results = await Promise.all(
      entries.map(async ([sym, instId]) => {
        const res = await fetch(
          `https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`,
          { headers: { "User-Agent": "Mozilla/5.0" } }
        );
        if (!res.ok) return [sym, null];
        const json = await res.json();
        const rate = json?.data?.[0]?.fundingRate;
        return [sym, rate !== undefined ? parseFloat(rate) * 100 : null];
      })
    );
    const out = {};
    for (const [sym, rate] of results) {
      if (rate !== null) out[sym] = rate;
    }
    return { ok: true, rates: out };
  } catch (e) {
    return { ok: false, error: String(e), rates: {} };
  }
}

async function fetchBybit() {
  try {
    const res = await fetch(BYBIT_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
    const data = await res.json();
    const out = {};
    const list = data?.result?.list || [];
    for (const item of list) {
      if (SYMBOLS.includes(item.symbol)) {
        out[item.symbol] = parseFloat(item.fundingRate) * 100;
      }
    }
    return { ok: true, rates: out };
  } catch (e) {
    return { ok: false, error: String(e), rates: {} };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API endpoint: /api/rates
    if (url.pathname === "/api/rates") {
      const [okx, bybit] = await Promise.all([fetchOKX(), fetchBybit()]);

      const combined = SYMBOLS.map((symbol) => {
        const b = okx.rates[symbol];
        const y = bybit.rates[symbol];
        if (b === undefined || y === undefined) return null;
        const spread = Math.abs(b - y);
        const direction = b < y ? "Long OKX / Short Bybit" : "Long Bybit / Short OKX";
        return { symbol, binance: b, bybit: y, spread, direction };
      }).filter(Boolean);

      return new Response(
        JSON.stringify({
          timestamp: Date.now(),
          binance_ok: okx.ok,
          bybit_ok: bybit.ok,
          binance_error: okx.error || null,
          bybit_error: bybit.error || null,
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

    // Fallback: serve static assets (index.html etc) via Cloudflare Pages asset binding
    return env.ASSETS.fetch(request);
  },
};
