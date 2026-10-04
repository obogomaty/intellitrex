import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=30", {
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Fear & Greed service unavailable" }, { status: 502 });
    }
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null || !("data" in data) || !Array.isArray(data.data)) {
      return NextResponse.json({ error: "Fear & Greed service returned invalid data" }, { status: 502 });
    }

    const entries = data.data.map(
      (d: { value: string; value_classification: string; timestamp: string }) => ({
        value: parseInt(d.value),
        classification: d.value_classification,
        date: new Date(parseInt(d.timestamp) * 1000).toISOString().split("T")[0],
      })
    );
    if (entries.length === 0 || entries.some((entry) =>
      !Number.isInteger(entry.value) || entry.value < 0 || entry.value > 100 ||
      typeof entry.classification !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)
    )) {
      return NextResponse.json({ error: "Fear & Greed service returned invalid data" }, { status: 502 });
    }

    return NextResponse.json({
      current: entries[0],
      yesterday: entries[1],
      lastWeek: entries[7] || entries[entries.length - 1],
      lastMonth: entries[29] || entries[entries.length - 1],
      history: entries,
    });
  } catch {
    return NextResponse.json({ error: "Fear & Greed service unavailable" }, { status: 502 });
  }
}
