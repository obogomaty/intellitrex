import { NextRequest, NextResponse } from "next/server";

const REPO = "reallyticsai/Intellitrax_Workflow";
const SUPPORTED_PAIRS = new Set([
  "XBTUSD", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ARBUSD",
  "DOTUSDT", "LINKUSDT", "KSMUSD", "PYTHUSD", "SUIUSD",
]);
const SUPPORTED_MODELS = new Set(["xgboost", "prophet", "nhits", "gru", "ensemble"]);

async function fetchCSV(path: string): Promise<string | null> {
  const token = process.env.GH_TOKEN;
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    {
      headers: token
        ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" }
        : { Accept: "application/vnd.github.v3+json" },
      next: { revalidate: 3600 },
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Forecast service unavailable");
  const data: unknown = await res.json();
  if (typeof data !== "object" || data === null || !("content" in data) || typeof data.content !== "string") {
    throw new Error("Forecast service returned invalid data");
  }
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return content;
}

function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i]?.trim() || "";
    });
    return row;
  });
}

export async function GET(req: NextRequest) {
  const pair = req.nextUrl.searchParams.get("pair") || "XBTUSD";
  const model = (req.nextUrl.searchParams.get("model") || "ensemble").toLowerCase();

  if (!SUPPORTED_PAIRS.has(pair)) {
    return NextResponse.json({ error: "Unsupported trading pair" }, { status: 400 });
  }
  if (!SUPPORTED_MODELS.has(model)) {
    return NextResponse.json({ error: "Unsupported forecast model" }, { status: 400 });
  }

  const forecastPath = `${pair}/forecasts/${model}_forecast.csv`;
  const predictionPath = `${pair}/predictions/${model}_predictions.csv`;
  const metricsPath = `${pair}/ml_metrics/ml_model_metrics.json`;

  try {
    const [forecastCSV, predictionCSV, metricsRaw] = await Promise.all([
      fetchCSV(forecastPath),
      fetchCSV(predictionPath),
      fetchCSV(metricsPath),
    ]);

    const forecasts = forecastCSV ? parseCSV(forecastCSV) : [];
    const predictions = predictionCSV ? parseCSV(predictionCSV) : [];
    let metrics: Record<string, unknown> | null = null;
    if (metricsRaw) {
      const parsedMetrics: unknown = JSON.parse(metricsRaw);
      if (typeof parsedMetrics !== "object" || parsedMetrics === null || Array.isArray(parsedMetrics)) {
        return NextResponse.json({ error: "Forecast service returned invalid metrics" }, { status: 502 });
      }
      metrics = parsedMetrics as Record<string, unknown>;
    }

    return NextResponse.json({ pair, model, forecasts, predictions, metrics });
  } catch {
    return NextResponse.json({ error: "Forecast service unavailable" }, { status: 502 });
  }
}
