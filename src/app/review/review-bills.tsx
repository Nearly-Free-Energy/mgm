"use client";

import { useMemo, useState } from "react";

type Period = { id: string; microgrid_id: string; start_date: string; end_date: string; timezone: string };
type Household = { id: string; microgrid_id: string };
type Exception = { code: string; message: string };
type Row = {
  householdId: string;
  label: string;
  savedUsageKwh: number | null;
  savedAmount: number | null;
  proposedUsageKwh: number | null;
  proposedAmount: number | null;
  usageDifferenceKwh: number | null;
  amountDifference: number | null;
  status: "comparable" | "excluded" | "error";
  exceptions: Exception[];
  provenance: { provider: "openems" | "fixture"; calculatedAt: string; periodTimezone: string };
};
type Comparison = {
  period: { id: string; startDate: string; endDate: string; timezone: string; tariffName: string | null; baselineImportedAt: string | null };
  rows: Row[];
  calculatedAt: string;
  errors: Exception[];
};

function value(value: number | null, unit = ""): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit}`;
}

function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `\u0027${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportComparison(data: Comparison) {
  const columns = ["Household", "Status", "Saved usage (kWh)", "Proposed usage (kWh)", "Usage difference (kWh)", "Saved amount", "Proposed amount", "Amount difference", "Exceptions", "Provider", "Calculated at", "Period timezone"];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of data.rows) {
    lines.push([
      row.label, row.status, row.savedUsageKwh, row.proposedUsageKwh,
      row.usageDifferenceKwh, row.savedAmount, row.proposedAmount, row.amountDifference,
      row.exceptions.map((e) => `${e.code}: ${e.message}`).join("; "),
      row.provenance.provider, row.provenance.calculatedAt, row.provenance.periodTimezone,
    ].map(csvCell).join(","));
  }
  const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `mgm-bill-review-${data.period.id}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ReviewBills({ periods, households }: { periods: Period[]; households: Household[] }) {
  const [periodId, setPeriodId] = useState(periods[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const period = periods.find((item) => item.id === periodId);
  const available = useMemo(() => households.filter((item) => item.microgrid_id === period?.microgrid_id), [households, period?.microgrid_id]);

  async function review() {
    if (!periodId) return;
    setBusy(true);
    setError(null);
    setComparison(null);
    try {
      const response = await fetch("/api/billing-review/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId, ...(selected.length ? { householdIds: selected } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Review failed");
      setComparison(result as Comparison);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }

  const comparable = comparison?.rows.filter((row) => row.status === "comparable") ?? [];
  const excluded = comparison?.rows.filter((row) => row.status !== "comparable") ?? [];

  return <div className="space-y-8">
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="grid gap-5 md:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">Billing period
          <select className="mt-2 w-full rounded-md border border-slate-300 bg-white p-3" value={periodId} onChange={(event) => { setPeriodId(event.target.value); setSelected([]); setComparison(null); }}>
            {periods.map((item) => <option key={item.id} value={item.id}>{item.start_date} – {item.end_date} · {item.timezone}</option>)}
          </select>
        </label>
        <div className="text-sm text-slate-600">
          <p className="font-medium text-slate-700">Households</p>
          <p className="mt-2">{selected.length === 0 ? `All ${available.length} households in this period’s microgrid` : `${selected.length} selected`}</p>
          <p className="mt-1 text-xs">Use the selection below to narrow the review. Labels contain no contact details.</p>
        </div>
      </div>
      {available.length > 0 && <details className="mt-5 border-t border-slate-100 pt-4">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">Choose households</summary>
        <div className="mt-3 grid max-h-48 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
          {available.map((item) => <label key={item.id} className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
            Household {item.id.slice(0, 8)}
          </label>)}
        </div>
      </details>}
      <button className="mt-5 rounded-md bg-slate-900 px-5 py-3 text-sm font-medium text-white disabled:opacity-50" disabled={!periodId || busy} onClick={review}>{busy ? "Calculating…" : "Compare bills"}</button>
      {periods.length === 0 && <p className="mt-4 text-sm text-slate-600">No imported billing periods are available yet.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
    </section>

    {comparison && <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Comparison</h2>
          <p className="mt-1 text-sm text-slate-600">{comparable.length} comparable · {excluded.length} excluded or failed</p>
          <p className="mt-1 text-xs text-slate-500">Calculated {new Date(comparison.calculatedAt).toLocaleString()} · Timezone {comparison.period.timezone} · Tariff {comparison.period.tariffName ?? "Not recorded"} · Baseline imported {comparison.period.baselineImportedAt ? new Date(comparison.period.baselineImportedAt).toLocaleString() : "Not recorded"}</p>
        </div>
        <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700" onClick={() => exportComparison(comparison)}>Export CSV</button>
      </div>
      {comparison.errors.length > 0 && <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">{comparison.errors.map((item, index) => <p key={`${item.code}-${index}`}>{item.code}: {item.message}</p>)}</div>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr><th className="p-3">Household</th><th className="p-3">Saved usage</th><th className="p-3">Proposed usage</th><th className="p-3">Difference</th><th className="p-3">Saved amount</th><th className="p-3">Proposed amount</th><th className="p-3">Difference</th><th className="p-3">Status and evidence</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{comparison.rows.map((row) => <tr key={row.householdId} className="align-top"><td className="p-3 font-medium">{row.label}</td><td className="p-3">{value(row.savedUsageKwh, " kWh")}</td><td className="p-3">{value(row.proposedUsageKwh, " kWh")}</td><td className="p-3">{value(row.usageDifferenceKwh, " kWh")}</td><td className="p-3">{value(row.savedAmount)}</td><td className="p-3">{value(row.proposedAmount)}</td><td className="p-3">{value(row.amountDifference)}</td><td className="p-3"><span className={row.status === "comparable" ? "text-emerald-700" : "text-amber-800"}>{row.status}</span><p className="mt-1 text-xs text-slate-500">{row.provenance.provider} · {row.provenance.periodTimezone}</p>{row.exceptions.map((item, index) => <p key={`${item.code}-${index}`} className="mt-1 text-xs text-amber-800">{item.message}</p>)}</td></tr>)}</tbody>
        </table>
        {comparison.rows.length === 0 && <p className="p-5 text-sm text-slate-600">No households matched this review.</p>}
      </div>
      <p className="text-xs text-slate-500">Differences can reflect changed readings, meter mappings, or tariffs. Review each exception before relying on the totals.</p>
    </section>}
  </div>;
}
