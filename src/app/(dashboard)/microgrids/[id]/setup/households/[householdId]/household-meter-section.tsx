"use client";

import * as React from "react";
import { StatusChip } from "@/components/ui/status-chip";
import { OpeningRegisterDialog } from "./opening-register-dialog";

export type AssignmentEntryView = {
  deviceId: string;
  deviceName: string;
  role: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  current: boolean;
};

export type AssignmentGapView = {
  from: string;
  to: string | null;
};

/**
 * HouseholdMeterSection — assignment history, gaps, and the opening-register
 * affordance (issue #4). History rows come from effective-dated links;
 * gaps are computed server-side and rendered explicitly rather than
 * papered over. The opening-register dialog posts to the validated
 * server endpoint.
 */
export function HouseholdMeterSection({
  entries,
  gaps,
  hasReadings,
  canManage,
}: {
  entries: AssignmentEntryView[];
  gaps: AssignmentGapView[];
  hasReadings: boolean;
  canManage: boolean;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const current = entries.find((e) => e.current) ?? null;

  return (
    <section aria-labelledby="meter-history-heading">
      <h4
        id="meter-history-heading"
        className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Meter assignment history
      </h4>
      {entries.length === 0 ? (
        <p className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          No meter assigned yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Meter
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Effective from
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Effective to
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={`${entry.deviceId}-${entry.effectiveFrom}`} className="border-t border-border">
                  <td className="px-4 py-3 font-medium text-foreground">
                    {entry.deviceName}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {entry.effectiveFrom}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {entry.effectiveTo ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {entry.current ? (
                      <StatusChip kind="meter" status="linked" />
                    ) : (
                      <span className="text-muted-foreground">Replaced</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {gaps.length > 0 && (
        <div
          role="alert"
          className="mt-3 rounded-md bg-warning-muted p-3 text-sm text-warning-fg"
        >
          <p className="font-medium">Assignment gaps need attention</p>
          <ul className="mt-1 list-disc pl-5">
            {gaps.map((gap) => (
              <li key={`${gap.from}-${gap.to ?? "open"}`}>
                {gap.to
                  ? `No meter assigned from ${gap.from} to ${gap.to}.`
                  : `Replacement boundary missing after ${gap.from} — verify which meter served the household.`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {current && !hasReadings && canManage && (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-md border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            No readings recorded for {current.deviceName} yet. Record its
            opening register to make the first billable period reviewable.
          </p>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Record opening register
          </button>
        </div>
      )}
      {current && (
        <OpeningRegisterDialog
          deviceId={current.deviceId}
          deviceName={current.deviceName}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </section>
  );
}
