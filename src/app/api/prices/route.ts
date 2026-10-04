import { NextRequest, NextResponse } from "next/server";

// Map our pair IDs to CoinGecko IDs
const PAIR_TO_COINGECKO: Record<string, string> = {
  XXBTZUSD: "bitcoin",
  XETHZUSD: "ethereum",
  SOLUSD: "solana",
  XXRPZUSD: "ripple",
  ARBUSD: "arbitrum",
  DOTUSD: "polkadot",
  LINKUSD: "chainlink",
  KSMUSD: "kusama",
  PYTHUSD: "pyth-network",
  SUIUSD: "sui",
};


export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const pair = params.get("pair") || "XXBTZUSD";
  const interval = params.get("interval") || "1440";
  const limitParam = params.get("limit") || "30";
  const limit = Number(limitParam);
  const coinId = PAIR_TO_COINGECKO[pair];

  if (!coinId) {
    return NextResponse.json({ error: "Unsupported trading pair" }, { status: 400 });
  }
  if (interval !== "60" && interval !== "1440") {
    return NextResponse.json({ error: "Unsupported interval" }, { status: 400 });
  }
  if (!/^\d+$/.test(limitParam) || !Number.isInteger(limit) || limit < 1 || limit > 720) {
    return NextResponse.json({ error: "Limit must be an integer from 1 to 720" }, { status: 400 });
  }

  // Determine days from limit + interval
  let days = String(limit);
  if (interval === "60") days = "1";
  else if (limit > 365) days = "max";

  try {
    // Fetch OHLC data from CoinGecko
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`,
      { next: { revalidate: 60 } }
    );

    if (!res.ok) {
      // Fallback to market_chart for simple price data
      const fallbackRes = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`,
        { next: { revalidate: 60 } }
      );
      if (!fallbackRes.ok) {
        return NextResponse.json({ error: "Price service unavailable" }, { status: 502 });
      }
      const fallbackData: unknown = await fallbackRes.json();

      if (
        typeof fallbackData === "object" && fallbackData !== null &&
        "prices" in fallbackData && Array.isArray(fallbackData.prices) &&
        fallbackData.prices.every((row) => Array.isArray(row) && row.length >= 2 &&
          typeof row[0] === "number" && Number.isFinite(row[0]) &&
          typeof row[1] === "number" && Number.isFinite(row[1]))
      ) {
        const candles = fallbackData.prices.map(
          ([time, price]: [number, number]) => ({
            time: Math.floor(time / 1000),
            open: price,
            high: price * 1.001,
            low: price * 0.999,
            close: price,
            volume: 0,
          })
        );
        return NextResponse.json({ pair, candles });
      }
      return NextResponse.json({ error: "Price service returned invalid data" }, { status: 502 });
    }

    const ohlcData: unknown = await res.json();

    // CoinGecko OHLC format: [[timestamp, open, high, low, close], ...]
    if (!Array.isArray(ohlcData) || !ohlcData.every((row) => Array.isArray(row) && row.length >= 5 &&
      row.slice(0, 5).every((value: unknown) => typeof value === "number" && Number.isFinite(value)))) {
      return NextResponse.json({ error: "Price service returned invalid data" }, { status: 502 });
    }
    const candles = ohlcData.map(
      (c: [number, number, number, number, number]) => ({
        time: Math.floor(c[0] / 1000),
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: 0,
      })
    );

    return NextResponse.json({ pair, candles });
  } catch {
    return NextResponse.json({ error: "Failed to fetch prices" }, { status: 500 });
  }
}
