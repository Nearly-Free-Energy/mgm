"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GridTariff, MicrogridSavingsSettings } from "@/lib/types/domain";
import { validateGridTariffBands } from "@/lib/billing/site-savings";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/chip";
import { Currency } from "@/components/format/currency";
import { LocalDate } from "@/components/format/local-date";

/** `effective_from` and the savings start dates are calendar days, not instants. */
const CALENDAR_DAY = { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" } as const;

const SELECT_CLASS =
  "rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50";

const DEFAULT_ROWS: BandRow[] = [
  { from_hour: 0, to_hour: 6, rate: "" },
  { from_hour: 6, to_hour: 18, rate: "" },
  { from_hour: 18, to_hour: 24, rate: "" },
];

const DEFAULT_EFFICIENCY = 0.9;

type BandRow = { from_hour: number; to_hour: number; rate: string };

/** "06:00". Hour 24 reads "24:00", the end of the day. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

/**
 * Grid tariff (what the microgrid pays the utility per kWh, by local hour)
 * and the savings settings that turn it into money on the Operations tab.
 *
 * The version list comes from props, so `router.refresh()` after a write is
 * what shows the change; only the forms keep local state.
 */
export function GridTariffEditor({
  microgridId,
  currency,
  tariffs,
  settings,
  today,
  canManage = false,
}: {
  microgridId: string;
  currency: string;
  /** Every version, any order. */
  tariffs: GridTariff[];
  settings: MicrogridSavingsSettings | null;
  /** Today in the microgrid's timezone, to mark the version in force. */
  today: string;
  canManage?: boolean;
}) {
  return (
    <div className="space-y-6">
      <TariffVersions
        microgridId={microgridId}
        currency={currency}
        tariffs={tariffs}
        today={today}
        canManage={canManage}
      />
      <SavingsSettingsForm microgridId={microgridId} settings={settings} canManage={canManage} />
    </div>
  );
}

function TariffVersions({
  microgridId,
  currency,
  tariffs,
  today,
  canManage,
}: {
  microgridId: string;
  currency: string;
  tariffs: GridTariff[];
  today: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<GridTariff | null>(null);

  const versions = [...tariffs].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  const inForce = versions.find((t) => t.effective_from <= today) ?? null;

  async function confirmDelete() {
    if (!pendingDelete) return;
    const res = await fetch(`/api/microgrids/${microgridId}/grid-tariffs/${pendingDelete.id}`, {
      method: "DELETE",
    });
    // ConfirmDialog shows a thrown message inline and stays open.
    if (!res.ok) throw new Error(await errorMessage(res, "Could not delete this version."));
    setPendingDelete(null);
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this grid tariff version?"
        description={
          pendingDelete
            ? `The version taking effect on ${pendingDelete.effective_from} will be removed. Savings for its days will be worked out with the version before it, or not at all if there is none.`
            : undefined
        }
        confirmLabel="Delete version"
        tone="destructive"
        onConfirm={confirmDelete}
      />

      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">Tariff versions</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            The rate per kWh the utility charges at each hour of the day. A version applies from
            its effective date until the next one.
          </p>
        </div>
        {canManage && versions.length > 0 && !formOpen && (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
          >
            Add version
          </button>
        )}
      </div>

      {formOpen && (
        <AddVersionForm
          microgridId={microgridId}
          currency={currency}
          takenDates={versions.map((v) => v.effective_from)}
          onCancel={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            router.refresh();
          }}
        />
      )}

      {versions.length === 0 && !formOpen && (
        <EmptyState
          tone="neutral"
          eyebrow="Grid tariff"
          title="Add the grid tariff"
          body={
            <>
              Enter what the utility charges per kWh at each hour. The Operations tab uses it to
              value the solar the site produced and what the battery saved by charging cheap and
              discharging dear.
            </>
          }
          cta={
            canManage ? (
              <button
                type="button"
                onClick={() => setFormOpen(true)}
                className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                + Add the first version
              </button>
            ) : undefined
          }
          footnote={
            !canManage ? "Ask a manager of this organization to enter the grid tariff." : undefined
          }
          className="border-0 bg-transparent p-0 shadow-none"
        />
      )}

      {versions.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Grid tariff versions">
          {versions.map((version) => {
            const state =
              version === inForce ? "in-force" : version.effective_from > today ? "scheduled" : "past";
            return (
              <li key={version.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    <span>
                      From <LocalDate value={version.effective_from} opts={CALENDAR_DAY} />
                    </span>
                    {state === "in-force" && <Chip tone="success">In force</Chip>}
                    {state === "scheduled" && <Chip tone="neutral">Scheduled</Chip>}
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(version)}
                      aria-label={`Delete the version from ${version.effective_from}`}
                      className="rounded-md px-2 py-1 text-sm text-destructive hover:bg-destructive-muted"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <ul className="mt-2 space-y-0.5 text-sm text-muted-foreground">
                  {[...version.bands]
                    .sort((a, b) => a.from_hour - b.from_hour)
                    .map((band) => (
                      <li key={band.from_hour}>
                        <span className="font-mono tabular-nums">
                          {hourLabel(band.from_hour)}–{hourLabel(band.to_hour)}
                        </span>{" "}
                        &rarr;{" "}
                        <Currency value={band.rate} currency={currency} maxFractionDigits={4} />
                        /kWh
                      </li>
                    ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddVersionForm({
  microgridId,
  currency,
  takenDates,
  onCancel,
  onSaved,
}: {
  microgridId: string;
  currency: string;
  takenDates: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [rows, setRows] = useState<BandRow[]>(DEFAULT_ROWS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(index: number, patch: Partial<BandRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      const from = Math.min(last ? last.to_hour : 0, 23);
      return [...prev, { from_hour: from, to_hour: 24, rate: "" }];
    });
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!effectiveFrom) {
      setError("Choose the date this version takes effect.");
      return;
    }
    if (takenDates.includes(effectiveFrom)) {
      setError("A version already takes effect on that date. Delete it first, or pick another date.");
      return;
    }
    if (rows.some((row) => row.rate.trim() === "")) {
      setError("Enter a rate for every band.");
      return;
    }
    const checked = validateGridTariffBands(
      rows.map((row) => ({
        from_hour: row.from_hour,
        to_hour: row.to_hour,
        rate: Number(row.rate),
      }))
    );
    if (!checked.ok) {
      setError(checked.message);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/microgrids/${microgridId}/grid-tariffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effective_from: effectiveFrom, bands: checked.bands }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "Could not save this version."));
        return;
      }
      onSaved();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    // noValidate: the checks below give the messages, not the browser's.
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="New grid tariff version"
      className="mb-6 space-y-4 rounded-md border border-border bg-muted p-4"
    >
      <div>
        <label htmlFor="grid-tariff-effective-from" className="block text-sm font-medium text-foreground">
          Takes effect on
        </label>
        <Input
          id="grid-tariff-effective-from"
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          className="mt-1 w-48"
        />
      </div>

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="pb-2 pr-4 font-medium text-muted-foreground">From</th>
            <th className="pb-2 pr-4 font-medium text-muted-foreground">To</th>
            <th className="pb-2 pr-4 font-medium text-muted-foreground">Rate per kWh ({currency})</th>
            <th className="pb-2 font-medium text-muted-foreground">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-border">
              <td className="py-2 pr-4">
                <select
                  aria-label={`Band ${index + 1} from`}
                  value={row.from_hour}
                  onChange={(e) => updateRow(index, { from_hour: Number(e.target.value) })}
                  className={SELECT_CLASS}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 pr-4">
                <select
                  aria-label={`Band ${index + 1} to`}
                  value={row.to_hour}
                  onChange={(e) => updateRow(index, { to_hour: Number(e.target.value) })}
                  className={SELECT_CLASS}
                >
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 pr-4">
                <Input
                  aria-label={`Band ${index + 1} rate`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={row.rate}
                  onChange={(e) => updateRow(index, { rate: e.target.value })}
                  className="w-32"
                />
              </td>
              <td className="py-2">
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    aria-label={`Remove band ${index + 1}`}
                    className="rounded-md px-2 py-1 text-sm text-destructive hover:bg-destructive-muted"
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length < 24 && (
        <button
          type="button"
          onClick={addRow}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        >
          Add band
        </button>
      )}

      <p className="text-xs text-muted-foreground">
        Bands are local hours and must cover the whole day, 00:00 to 24:00, without gaps or
        overlaps.
      </p>

      {error && (
        <div role="alert" className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save version"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Round-trip efficiency as a percentage for the input: 0.9 → "90". */
function efficiencyPct(value: number): string {
  return String(Math.round(value * 1000) / 10);
}

export function SavingsSettingsForm({
  microgridId,
  settings,
  canManage,
}: {
  microgridId: string;
  settings: MicrogridSavingsSettings | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [solarFrom, setSolarFrom] = useState(settings?.solar_savings_from ?? "");
  const [arbitrageFrom, setArbitrageFrom] = useState(settings?.arbitrage_from ?? "");
  const [efficiency, setEfficiency] = useState(
    efficiencyPct(settings?.round_trip_efficiency ?? DEFAULT_EFFICIENCY)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const pct = efficiency.trim() === "" ? NaN : Number(efficiency);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      setError("Round-trip efficiency must be more than 0% and at most 100%.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/microgrids/${microgridId}/savings-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          solar_savings_from: solarFrom || null,
          arbitrage_from: arbitrageFrom || null,
          // Stored as a fraction; numeric(4,3) keeps three decimals.
          round_trip_efficiency: Math.round(pct * 10) / 1000,
        }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "Could not save the savings settings."));
        return;
      }
      setSuccess("Savings settings saved.");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Savings settings"
      className="rounded-lg border border-border bg-card p-6"
    >
      <h3 className="text-base font-semibold text-foreground">Savings settings</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Choose from which day each saving is counted on the Operations tab. Leave a date empty to
        leave that saving out.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="savings-solar-from" className="block text-sm font-medium text-foreground">
            Count solar savings from
          </label>
          <Input
            id="savings-solar-from"
            type="date"
            value={solarFrom}
            onChange={(e) => setSolarFrom(e.target.value)}
            disabled={!canManage}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="savings-arbitrage-from" className="block text-sm font-medium text-foreground">
            Count arbitrage from
          </label>
          <Input
            id="savings-arbitrage-from"
            type="date"
            value={arbitrageFrom}
            onChange={(e) => setArbitrageFrom(e.target.value)}
            disabled={!canManage}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="savings-efficiency" className="block text-sm font-medium text-foreground">
            Battery round-trip efficiency (%)
          </label>
          <Input
            id="savings-efficiency"
            type="number"
            min={1}
            max={100}
            step="any"
            value={efficiency}
            onChange={(e) => setEfficiency(e.target.value)}
            disabled={!canManage}
            className="mt-1"
          />
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Round-trip efficiency is the share of the energy put into the battery that comes back out.
        Arbitrage counts each kWh discharged at its cost to charge divided by this share.
      </p>

      {error && (
        <div role="alert" className="mt-4 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="mt-4 rounded-md bg-success-muted p-3 text-sm text-success-fg">
          {success}
        </div>
      )}

      {canManage ? (
        <button
          type="submit"
          disabled={saving}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          Ask a manager of this organization to change these settings.
        </p>
      )}
    </form>
  );
}

