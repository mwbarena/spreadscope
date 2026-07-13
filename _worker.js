// SpreadScope Worker — proxies Binance + Bybit funding rate APIs to avoid browser CORS blocks
// Deploy this as a Cloudflare Pages Function / Worker alongside the static index.html

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];

const BINANCE_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
];
const BYBIT_URL = "https://api.bybit.com/v5/market/tickers?category=linear";

async function fetchBinance() {
  let lastErr = "";
  for (const host of BINANCE_HOSTS) {
    try {
      const res = await fetch(`${host}/fapi/v1/premiumIndex`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) {
        lastErr = `${host} HTTP ${res.status}`;
        continue; // try next host
      }
      const data = await res.json();
      const out = {};
      for (const item of data) {
        if (SYMBOLS.includes(item.symbol)) {
          out[item.symbol] = parseFloat(item.lastFundingRate) * 100;
        }
      }
      return { ok: true, rates: out, host_used: host };
    } catch (e) {
      lastErr = `${host} error: ${e}`;
    }
  }
  return { ok: false, error: lastErr, rates: {} };
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
      const [binance, bybit] = await Promise.all([fetchBinance(), fetchBybit()]);

      const combined = SYMBOLS.map((symbol) => {
        const b = binance.rates[symbol];
        const y = bybit.rates[symbol];
        if (b === undefined || y === undefined) return null;
        const spread = Math.abs(b - y);
        const direction = b < y ? "Long Binance / Short Bybit" : "Long Bybit / Short Binance";
        return { symbol, binance: b, bybit: y, spread, direction };
      }).filter(Boolean);

      return new Response(
        JSON.stringify({
          timestamp: Date.now(),
          binance_ok: binance.ok,
          bybit_ok: bybit.ok,
          binance_error: binance.error || null,
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
