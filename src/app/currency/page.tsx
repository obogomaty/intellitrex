"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { SUPPORTED_COINS, MODELS } from "@/lib/constants";
import { TrendingUp, TrendingDown, Activity } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type FearGreed = {
  current: { value: number; classification: string };
  yesterday: { value: number; classification: string };
  lastWeek: { value: number; classification: string };
  lastMonth: { value: number; classification: string };
};

type ForecastRow = Record<string, string>;

type Metrics = Record<
  string,
  { MAE?: number; RMSE?: number; R2?: number; [key: string]: number | undefined }
>;

type LoadStatus = "loading" | "success" | "empty" | "error";

function DataNotice({ status, error, onRetry, emptyMessage }: {
  status: LoadStatus;
  error: string;
  onRetry: () => void;
  emptyMessage: string;
}) {
  if (status === "loading") {
    return <p role="status" className="text-sm text-muted-foreground">Loading data...</p>;
  }
  if (status === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
        <span>{error}</span>
        <button onClick={onRetry} className="text-primary hover:underline">Retry</button>
      </div>
    );
  }
  if (status === "empty") {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }
  return null;
}

function isFearGreedEntry(value: unknown): value is { value: number; classification: string } {
  return typeof value === "object" && value !== null && "value" in value &&
    typeof value.value === "number" && Number.isFinite(value.value) &&
    "classification" in value && typeof value.classification === "string";
}

function isFearGreedPayload(value: unknown): value is FearGreed {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return ["current", "yesterday", "lastWeek", "lastMonth"].every((key) =>
    isFearGreedEntry(payload[key]));
}

const TIME_RANGES = [
  { label: "24H", interval: "60", limit: 24 },
  { label: "1W", interval: "1440", limit: 7 },
  { label: "1M", interval: "1440", limit: 30 },
  { label: "1Y", interval: "1440", limit: 365 },
  { label: "ALL", interval: "1440", limit: 720 },
];

function computeSMA(candles: Candle[], period: number): (number | null)[] {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const slice = candles.slice(i - period + 1, i + 1);
    return slice.reduce((sum, c) => sum + c.close, 0) / period;
  });
}

function computeRSI(candles: Candle[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function computeBollinger(
  candles: Candle[],
  period = 20,
  mult = 2
): { upper: (number | null)[]; lower: (number | null)[]; middle: (number | null)[] } {
  const middle = computeSMA(candles, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  candles.forEach((_, i) => {
    if (middle[i] === null) {
      upper.push(null);
      lower.push(null);
      return;
    }
    const slice = candles.slice(i - period + 1, i + 1);
    const std = Math.sqrt(
      slice.reduce((sum, c) => sum + Math.pow(c.close - middle[i]!, 2), 0) / period
    );
    upper.push(middle[i]! + mult * std);
    lower.push(middle[i]! - mult * std);
  });

  return { upper, lower, middle };
}

function formatPrice(price: number): string {
  if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}

function FearGreedGauge({ value, label }: { value: number; label: string }) {
  const getColor = (v: number) => {
    if (v <= 25) return "bg-danger text-white";
    if (v <= 45) return "bg-red-300 text-red-900";
    if (v <= 55) return "bg-yellow-300 text-yellow-900";
    if (v <= 75) return "bg-green-300 text-green-900";
    return "bg-success text-white";
  };
  const getLabel = (v: number) => {
    if (v <= 25) return "Extreme Fear";
    if (v <= 45) return "Fear";
    if (v <= 55) return "Neutral";
    if (v <= 75) return "Greed";
    return "Extreme Greed";
  };
  return (
    <div
      className={cn(
        "rounded-xl p-3 text-center min-w-[100px]",
        getColor(value)
      )}
    >
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="text-xl font-bold">{value}%</p>
      <p className="text-xs font-medium">{getLabel(value)}</p>
    </div>
  );
}

export default function CurrencyPage() {
  const { isPremium } = useAuth();
  const [selectedCoin, setSelectedCoin] = useState(SUPPORTED_COINS[0] as typeof SUPPORTED_COINS[number]);
  const [timeRange, setTimeRange] = useState(TIME_RANGES[1]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [fearGreed, setFearGreed] = useState<FearGreed | null>(null);
  const [forecasts, setForecasts] = useState<ForecastRow[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [selectedModel, setSelectedModel] = useState("xgboost");
  const [showSMA, setShowSMA] = useState(false);
  const [showRSI, setShowRSI] = useState(false);
  const [showBollinger, setShowBollinger] = useState(false);
  const [pricesStatus, setPricesStatus] = useState<LoadStatus>("loading");
  const [pricesError, setPricesError] = useState("");
  const [forecastsStatus, setForecastsStatus] = useState<LoadStatus>("loading");
  const [forecastsError, setForecastsError] = useState("");
  const [fearGreedStatus, setFearGreedStatus] = useState<LoadStatus>("loading");
  const [fearGreedError, setFearGreedError] = useState("");
  const requestIds = useRef({ prices: 0, forecasts: 0, fearGreed: 0 });

  const fetchPrices = useCallback(async () => {
    const requestId = ++requestIds.current.prices;
    setPricesStatus("loading");
    setPricesError("");
    setCandles([]);
    try {
      const res = await fetch(
        `/api/prices?pair=${selectedCoin.krakenPair}&interval=${timeRange.interval}&limit=${timeRange.limit}`
      );
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error(typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
          ? data.error : "Unable to load prices.");
      }
      if (typeof data !== "object" || data === null || !("candles" in data) || !Array.isArray(data.candles) ||
        !data.candles.every((c) => typeof c === "object" && c !== null &&
          ["time", "open", "high", "low", "close", "volume"].every((key) =>
            key in c && typeof c[key] === "number" && Number.isFinite(c[key])))) {
        throw new Error("Price service returned invalid data.");
      }
      if (requestId !== requestIds.current.prices) return;
      const nextCandles = data.candles.slice(-timeRange.limit) as Candle[];
      setCandles(nextCandles);
      setPricesStatus(nextCandles.length ? "success" : "empty");
    } catch (error) {
      if (requestId !== requestIds.current.prices) return;
      setPricesError(error instanceof Error ? error.message : "Unable to load prices.");
      setPricesStatus("error");
    }
  }, [selectedCoin, timeRange]);

  const fetchForecasts = useCallback(async () => {
    const requestId = ++requestIds.current.forecasts;
    setForecastsStatus("loading");
    setForecastsError("");
    setForecasts([]);
    setMetrics(null);
    try {
      const res = await fetch(
        `/api/forecasts?pair=${selectedCoin.pair}&model=${selectedModel}`
      );
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error(typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
          ? data.error : "Unable to load forecasts.");
      }
      if (typeof data !== "object" || data === null || !("forecasts" in data) || !Array.isArray(data.forecasts) ||
        !data.forecasts.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) {
        throw new Error("Forecast service returned invalid data.");
      }
      if (requestId !== requestIds.current.forecasts) return;
      const nextForecasts = data.forecasts as ForecastRow[];
      setForecasts(nextForecasts);
      setMetrics("metrics" in data && typeof data.metrics === "object" && data.metrics !== null && !Array.isArray(data.metrics)
        ? data.metrics as Metrics : null);
      setForecastsStatus(nextForecasts.length ? "success" : "empty");
    } catch (error) {
      if (requestId !== requestIds.current.forecasts) return;
      setForecastsError(error instanceof Error ? error.message : "Unable to load forecasts.");
      setForecastsStatus("error");
    }
  }, [selectedCoin, selectedModel]);

  const fetchFearGreedData = useCallback(async () => {
    const requestId = ++requestIds.current.fearGreed;
    setFearGreedStatus("loading");
    setFearGreedError("");
    setFearGreed(null);
    try {
      const res = await fetch("/api/fear-greed");
      const data: unknown = await res.json();
      if (!res.ok) {
        throw new Error(typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
          ? data.error : "Unable to load Fear & Greed data.");
      }
      if (!isFearGreedPayload(data)) {
        throw new Error("Fear & Greed service returned invalid data.");
      }
      if (requestId !== requestIds.current.fearGreed) return;
      setFearGreed(data as FearGreed);
      setFearGreedStatus("success");
    } catch (error) {
      if (requestId !== requestIds.current.fearGreed) return;
      setFearGreedError(error instanceof Error ? error.message : "Unable to load Fear & Greed data.");
      setFearGreedStatus("error");
    }
  }, []);

  useEffect(() => {
    fetchPrices();
    fetchForecasts();
  }, [fetchPrices, fetchForecasts]);

  useEffect(() => {
    fetchFearGreedData();
  }, [fetchFearGreedData]);

  const latestCandle = candles[candles.length - 1];
  const firstCandle = candles[0];
  const priceChange =
    latestCandle && firstCandle
      ? ((latestCandle.close - firstCandle.close) / firstCandle.close) * 100
      : 0;
  const highOfDay = candles.length
    ? Math.max(...candles.map((c) => c.high))
    : 0;
  const lowOfDay = candles.length
    ? Math.min(...candles.map((c) => c.low))
    : 0;

  const sma20 = showSMA ? computeSMA(candles, 20) : [];
  const rsi = showRSI ? computeRSI(candles) : [];
  const bollinger = showBollinger ? computeBollinger(candles) : null;

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Chart dimensions with padding for axes
  const padL = 70; // left padding for Y-axis labels
  const padB = 30; // bottom padding for X-axis labels
  const padR = 10;
  const padT = 10;
  const svgW = 700;
  const svgH = 340;
  const chartW = svgW - padL - padR;
  const chartH = svgH - padB - padT;

  const minPrice = candles.length ? Math.min(...candles.map((c) => c.low)) * 0.995 : 0;
  const maxPrice = candles.length ? Math.max(...candles.map((c) => c.high)) * 1.005 : 1;
  const priceRange = maxPrice - minPrice || 1;

  const toX = (i: number, total: number) => padL + (i / Math.max(total - 1, 1)) * chartW;
  const toY = (price: number) =>
    padT + chartH - ((price - minPrice) / priceRange) * chartH;

  // Y-axis tick values (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => minPrice + (priceRange * i) / 4);

  // X-axis date labels (max 6)
  const xLabelCount = Math.min(candles.length, 6);
  const xLabels = candles.length > 1
    ? Array.from({ length: xLabelCount }, (_, i) => {
        const idx = Math.floor((i / (xLabelCount - 1)) * (candles.length - 1));
        const c = candles[idx];
        const d = new Date(c.time * 1000);
        return {
          x: toX(idx, candles.length),
          label: timeRange.interval === "60"
            ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : d.toLocaleDateString([], { month: "short", day: "numeric" }),
        };
      })
    : [];

  const priceLine =
    candles.length > 1
      ? candles.map((c, i) => `${toX(i, candles.length)},${toY(c.close)}`).join(" ")
      : "";

  const smaLine =
    sma20.length > 0
      ? sma20.map((v, i) => (v !== null ? `${toX(i, candles.length)},${toY(v)}` : "")).filter(Boolean).join(" ")
      : "";

  const forecastLine = forecasts
    .map((f, i) => {
      const price = parseFloat(f.Close || f.Predicted_Close || f.Forecast || "0");
      if (!price) return "";
      return `${toX(candles.length + i, candles.length + forecasts.length)},${toY(price)}`;
    })
    .filter(Boolean)
    .join(" ");

  const lastRSI = rsi.length > 0 ? rsi[rsi.length - 1] : null;

  const hoverCandle = hoverIdx !== null ? candles[hoverIdx] : null;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (candles.length < 2) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * svgW;
    const dataX = mouseX - padL;
    if (dataX < 0 || dataX > chartW) { setHoverIdx(null); return; }
    const idx = Math.round((dataX / chartW) * (candles.length - 1));
    setHoverIdx(Math.max(0, Math.min(idx, candles.length - 1)));
  };

  return (
    <div className="min-h-screen py-8 px-6">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-foreground mb-8">Currency</h1>

        <div className="grid lg:grid-cols-5 gap-6">
          {/* Left: Chart area */}
          <div className="lg:col-span-3 space-y-6">
            {/* Coin selector + time range */}
            <div className="bg-card rounded-2xl p-6 border border-border">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <div>
                  <label className="text-sm text-muted-foreground">Select Currency</label>
                  <select
                    value={selectedCoin.id}
                    onChange={(e) => {
                      const coin = SUPPORTED_COINS.find((c) => c.id === e.target.value);
                      if (coin) setSelectedCoin(coin);
                    }}
                    className="ml-3 px-4 py-2 rounded-lg border border-border bg-card text-foreground text-sm"
                  >
                    {SUPPORTED_COINS.map((coin) => (
                      <option key={coin.id} value={coin.id}>
                        {coin.name} ({coin.symbol})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                  {TIME_RANGES.map((tr) => (
                    <button
                      key={tr.label}
                      onClick={() => setTimeRange(tr)}
                      className={cn(
                        "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                        timeRange.label === tr.label
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {tr.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Price badges */}
              {latestCandle && (
                <div className="flex items-center gap-3 mb-4">
                  <span
                    className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium",
                      priceChange >= 0
                        ? "bg-success/10 text-success"
                        : "bg-danger/10 text-danger"
                    )}
                  >
                    {priceChange >= 0 ? (
                      <TrendingUp className="w-3 h-3 inline mr-1" />
                    ) : (
                      <TrendingDown className="w-3 h-3 inline mr-1" />
                    )}
                    {priceChange.toFixed(1)}%
                  </span>
                  <span className="px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary">
                    {formatPrice(latestCandle.close)}
                  </span>
                </div>
              )}

              {/* SVG Chart */}
              <div className="relative w-full bg-muted/30 rounded-xl overflow-hidden" style={{ aspectRatio: `${svgW}/${svgH}` }}>
                {pricesStatus === "loading" ? (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Activity className="w-8 h-8 text-muted-foreground animate-pulse" />
                  </div>
                ) : pricesStatus === "error" || pricesStatus === "empty" ? (
                  <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
                    <DataNotice status={pricesStatus} error={pricesError} onRetry={fetchPrices}
                      emptyMessage="No price data is available for this selection." />
                  </div>
                ) : (
                  <svg
                    viewBox={`0 0 ${svgW} ${svgH}`}
                    className="w-full h-full"
                    preserveAspectRatio="xMidYMid meet"
                    onMouseMove={handleMouseMove}
                    onMouseLeave={() => setHoverIdx(null)}
                  >
                    {/* Y-axis labels + grid lines */}
                    {yTicks.map((price, i) => (
                      <g key={`y-${i}`}>
                        <line
                          x1={padL}
                          y1={toY(price)}
                          x2={svgW - padR}
                          y2={toY(price)}
                          stroke="currentColor"
                          strokeOpacity={0.08}
                        />
                        <text
                          x={padL - 6}
                          y={toY(price) + 3}
                          textAnchor="end"
                          fill="currentColor"
                          fillOpacity={0.4}
                          fontSize="9"
                          fontFamily="system-ui"
                        >
                          {price >= 1000
                            ? `$${(price / 1000).toFixed(1)}K`
                            : price >= 1
                            ? `$${price.toFixed(1)}`
                            : `$${price.toFixed(4)}`}
                        </text>
                      </g>
                    ))}

                    {/* X-axis date labels */}
                    {xLabels.map((lbl, i) => (
                      <text
                        key={`x-${i}`}
                        x={lbl.x}
                        y={svgH - 6}
                        textAnchor="middle"
                        fill="currentColor"
                        fillOpacity={0.4}
                        fontSize="9"
                        fontFamily="system-ui"
                      >
                        {lbl.label}
                      </text>
                    ))}

                    {/* Bollinger band fill */}
                    {bollinger && (() => {
                      const upperPts = bollinger.upper
                        .map((v, i) => (v !== null ? `${toX(i, candles.length)},${toY(v)}` : null))
                        .filter(Boolean);
                      const lowerPts = bollinger.lower
                        .map((v, i) => (v !== null ? `${toX(i, candles.length)},${toY(v)}` : null))
                        .filter(Boolean);
                      const fillPoly = [...upperPts, ...lowerPts.reverse()].join(" ");
                      return (
                        <>
                          <polygon points={fillPoly} fill="#a78bfa" fillOpacity="0.06" />
                          <polyline points={upperPts.join(" ")} fill="none" stroke="#22c55e" strokeWidth="1.2" strokeOpacity="0.7" />
                          <polyline points={lowerPts.reverse().join(" ")} fill="none" stroke="#ef4444" strokeWidth="1.2" strokeOpacity="0.7" />
                        </>
                      );
                    })()}

                    {/* Price line */}
                    {priceLine && (
                      <>
                        <defs>
                          <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.15" />
                            <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        <polygon
                          points={`${priceLine} ${toX(candles.length - 1, candles.length)},${padT + chartH} ${toX(0, candles.length)},${padT + chartH}`}
                          fill="url(#priceGrad)"
                        />
                        <polyline points={priceLine} fill="none" stroke="#22c55e" strokeWidth="2" />
                      </>
                    )}

                    {/* SMA 20 */}
                    {smaLine && (
                      <polyline points={smaLine} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="4 2" />
                    )}

                    {/* Forecast overlay */}
                    {forecastLine && (
                      <polyline points={forecastLine} fill="none" stroke="#5b7cfa" strokeWidth="2" strokeDasharray="6 3" />
                    )}

                    {/* Hover crosshair + tooltip */}
                    {hoverCandle && hoverIdx !== null && (
                      <>
                        <line
                          x1={toX(hoverIdx, candles.length)}
                          y1={padT}
                          x2={toX(hoverIdx, candles.length)}
                          y2={padT + chartH}
                          stroke="currentColor"
                          strokeOpacity={0.2}
                          strokeDasharray="3 3"
                        />
                        <circle
                          cx={toX(hoverIdx, candles.length)}
                          cy={toY(hoverCandle.close)}
                          r="4"
                          fill="#22c55e"
                          stroke="white"
                          strokeWidth="1.5"
                        />
                        <rect
                          x={Math.min(toX(hoverIdx, candles.length) - 55, svgW - padR - 115)}
                          y={Math.max(toY(hoverCandle.close) - 42, padT)}
                          width="110"
                          height="36"
                          rx="6"
                          fill="var(--card, #1a1d2e)"
                          stroke="var(--border, #2a2f45)"
                          strokeWidth="1"
                        />
                        <text
                          x={Math.min(toX(hoverIdx, candles.length), svgW - padR - 60)}
                          y={Math.max(toY(hoverCandle.close) - 26, padT + 14)}
                          textAnchor="middle"
                          fill="var(--foreground, #e2e8f0)"
                          fontSize="10"
                          fontWeight="600"
                          fontFamily="system-ui"
                        >
                          {formatPrice(hoverCandle.close)}
                        </text>
                        <text
                          x={Math.min(toX(hoverIdx, candles.length), svgW - padR - 60)}
                          y={Math.max(toY(hoverCandle.close) - 12, padT + 28)}
                          textAnchor="middle"
                          fill="var(--muted-foreground, #94a3b8)"
                          fontSize="8"
                          fontFamily="system-ui"
                        >
                          {new Date(hoverCandle.time * 1000).toLocaleDateString([], {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </text>
                      </>
                    )}
                  </svg>
                )}
              </div>

              {/* Indicator toggles */}
              <div className="flex flex-wrap gap-3 mt-4">
                {[
                  { label: "SMA 20", active: showSMA, toggle: () => setShowSMA(!showSMA), color: "bg-yellow-500" },
                  { label: "RSI", active: showRSI, toggle: () => setShowRSI(!showRSI), color: "bg-blue-500" },
                  {
                    label: "Bollinger",
                    active: showBollinger,
                    toggle: () => setShowBollinger(!showBollinger),
                    color: "bg-purple-500",
                  },
                ].map((ind) => (
                  <button
                    key={ind.label}
                    onClick={ind.toggle}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                      ind.active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span className={cn("inline-block w-2 h-2 rounded-full mr-1.5", ind.color)} />
                    {ind.label}
                  </button>
                ))}

                <select
                  value={selectedModel}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "ensemble" && !isPremium) return;
                    setSelectedModel(val);
                  }}
                  className="ml-auto px-3 py-1.5 rounded-lg border border-border bg-card text-foreground text-xs"
                >
                  {MODELS.map((m) => {
                    const val = m.toLowerCase();
                    const locked = val === "ensemble" && !isPremium;
                    return (
                      <option key={m} value={val} disabled={locked}>
                        {locked ? `\uD83D\uDD12 ${m} (Premium)` : `Forecast: ${m}`}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            {/* Bollinger Bands display */}
            {showBollinger && bollinger && (
              <div className="bg-card rounded-2xl p-6 border border-border">
                <h3 className="font-semibold text-foreground mb-4">Bollinger Bands</h3>
                <div className="grid grid-cols-3 gap-4">
                  {[
                    {
                      label: "Upper Bound",
                      value: bollinger.upper.filter((v): v is number => v !== null).pop(),
                    },
                    {
                      label: "Lower Bound",
                      value: bollinger.lower.filter((v): v is number => v !== null).pop(),
                    },
                    {
                      label: "20 Period SMA",
                      value: bollinger.middle.filter((v): v is number => v !== null).pop(),
                    },
                  ].map((b) => (
                    <div key={b.label}>
                      <p className="text-xs text-muted-foreground">{b.label}</p>
                      <p className="text-lg font-semibold text-foreground">
                        {b.value ? formatPrice(b.value) : "N/A"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* RSI display */}
            {showRSI && lastRSI !== null && (
              <div className="bg-card rounded-2xl p-6 border border-border">
                <h3 className="font-semibold text-foreground mb-2">RSI (14)</h3>
                <div className="flex items-center gap-4">
                  <span className="text-2xl font-bold text-foreground">
                    {lastRSI?.toFixed(1)}
                  </span>
                  <span
                    className={cn(
                      "px-2 py-1 rounded text-xs font-medium",
                      lastRSI && lastRSI > 70
                        ? "bg-danger/10 text-danger"
                        : lastRSI && lastRSI < 30
                        ? "bg-success/10 text-success"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {lastRSI && lastRSI > 70
                      ? "Overbought"
                      : lastRSI && lastRSI < 30
                      ? "Oversold"
                      : "Neutral"}
                  </span>
                </div>
              </div>
            )}

            {/* Model Metrics */}
            {metrics && (
              <div className="bg-card rounded-2xl p-6 border border-border">
                <h3 className="font-semibold text-foreground mb-4">Model Performance</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 text-muted-foreground font-medium">Model</th>
                        <th className="text-right py-2 text-muted-foreground font-medium">MAE</th>
                        <th className="text-right py-2 text-muted-foreground font-medium">RMSE</th>
                        <th className="text-right py-2 text-muted-foreground font-medium">R&sup2;</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(metrics).map(([model, m]) => (
                        <tr key={model} className="border-b border-border/50">
                          <td className="py-2 text-foreground font-medium">{model}</td>
                          <td className="text-right py-2 text-muted-foreground">
                            {m.MAE?.toFixed(2) || "N/A"}
                          </td>
                          <td className="text-right py-2 text-muted-foreground">
                            {m.RMSE?.toFixed(2) || "N/A"}
                          </td>
                          <td className="text-right py-2 text-muted-foreground">
                            {m.R2?.toFixed(4) || "N/A"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Right: Stats panel */}
          <div className="lg:col-span-2 space-y-6">
            {/* Price stats */}
            <div className="bg-card rounded-2xl p-6 border border-border">
              <h3 className="font-semibold text-foreground mb-4">Price</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-success/10 p-4 text-center">
                  <p className="text-xl font-bold text-success">
                    {latestCandle ? formatPrice(latestCandle.close) : "--"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Current Price</p>
                </div>
                <div
                  className={cn(
                    "rounded-xl p-4 text-center",
                    !latestCandle ? "bg-muted" : priceChange >= 0 ? "bg-success/10" : "bg-danger/10"
                  )}
                >
                  <p
                    className={cn(
                      "text-xl font-bold",
                      !latestCandle ? "text-muted-foreground" : priceChange >= 0 ? "text-success" : "text-danger"
                    )}
                  >
                    {latestCandle ? `${priceChange.toFixed(2)}%` : "--"}{" "}
                    {!latestCandle ? null : priceChange >= 0 ? (
                      <TrendingUp className="w-4 h-4 inline" />
                    ) : (
                      <TrendingDown className="w-4 h-4 inline" />
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Change</p>
                </div>
                <div className="rounded-xl border border-border p-4 text-center">
                  <p className="text-lg font-semibold text-foreground">
                    {latestCandle ? formatPrice(highOfDay) : "--"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Highest</p>
                </div>
                <div className="rounded-xl border border-border p-4 text-center">
                  <p className="text-lg font-semibold text-foreground">
                    {latestCandle ? formatPrice(lowOfDay) : "--"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Lowest</p>
                </div>
              </div>
            </div>

            {/* 7-Day Forecast */}
            {forecastsStatus !== "success" || forecasts.length > 0 ? (
              <div className="bg-card rounded-2xl p-6 border border-border">
                <h3 className="font-semibold text-foreground mb-4">
                  7-Day Forecast ({selectedModel})
                </h3>
                {forecastsStatus !== "success" ? (
                  <DataNotice status={forecastsStatus} error={forecastsError} onRetry={fetchForecasts}
                    emptyMessage="No forecast data is available for this pair and model." />
                ) : <div className="space-y-2">
                  {forecasts.map((f, i) => {
                    const price = parseFloat(
                      f.Close || f.Predicted_Close || f.Forecast || "0"
                    );
                    return (
                      <div
                        key={i}
                        className="flex justify-between items-center py-1.5 border-b border-border/50 last:border-0"
                      >
                        <span className="text-xs text-muted-foreground">
                          Day {i + 1}
                        </span>
                        <span className="text-sm font-medium text-foreground">
                          {price ? formatPrice(price) : "N/A"}
                        </span>
                      </div>
                    );
                  })}
                </div>}
              </div>
            ) : null}

            {/* Fear & Greed */}
            <div className="bg-card rounded-2xl p-6 border border-border">
              <h3 className="font-semibold text-foreground mb-4">Fear and Greed Index</h3>
              {fearGreedStatus !== "success" || !fearGreed ? (
                <DataNotice status={fearGreedStatus} error={fearGreedError} onRetry={fetchFearGreedData}
                  emptyMessage="Fear & Greed data is not available." />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <FearGreedGauge value={fearGreed.current.value} label="Now" />
                  <FearGreedGauge value={fearGreed.yesterday.value} label="Yesterday" />
                  <FearGreedGauge value={fearGreed.lastWeek.value} label="Last Week" />
                  <FearGreedGauge value={fearGreed.lastMonth.value} label="Last Month" />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
