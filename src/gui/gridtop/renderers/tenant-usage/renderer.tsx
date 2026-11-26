"use client";

/**
 * Gridtop's renderers for `tenant.usage-month@1` and `tenant.usage-day@1`, a
 * tenant's use of their unit (RFC mgm#197 § 4), loaded on their own by
 * ./index.tsx: the month as a calendar of days and the day as bars and a
 * list of hours, each between its previous and next steps. They print the
 * text the server formatted, format nothing, and write only through
 * kit.act. A model whose ext they cannot read, or whose rows do not match
 * its days or hours one to one, is drawn by the kit's view instead.
 *
 * The text comes from the rows, so what is printed is exactly the model's
 * values; the layout and each day's or hour's state come from the ext. The
 * row ids are the ext's `date` / `start` as buildUsageMonthModel /
 * buildUsageDayModel set them (src/lib/tenant-app/surface/usage-model.ts);
 * if they change, revisit (./ext.ts joins them).
 *
 * The kit comes from ./index.tsx as a prop, and these files import nothing
 * else of Gridtop's or the kit's, so this chunk shares no module with the
 * shell's (../site-day/renderer.tsx says why).
 */
import type { ViewProps } from "@/lib/gui/contract";
import type { GuiKit, SyncNode } from "@/lib/gui/contract-react";
import { HourBars, HourTable } from "./day";
import { readUsageDay, readUsageMonth, type DayExt, type Joined, type MonthExt } from "./ext";
import { MonthCalendar, MonthLegend } from "./month";
import { Steps, TotalLine, UsageFrame } from "./parts";

/** Every href the ext placed, so the controls leave out a model link to the same page. */
const placedOf = (...hrefs: (string | null | undefined)[]) => new Set(hrefs.filter((h): h is string => typeof h === "string"));

function UsageMonth({ read, kit }: { read: Joined<MonthExt>; kit: GuiKit }) {
  const { model, ext, rowOf } = read;
  const placed = placedOf(ext.previous?.href, ext.next?.href, ...ext.days.map((d) => d.href));
  return (
    <UsageFrame
      name="tenant-usage-month"
      model={model}
      read={ext}
      placed={placed}
      kit={kit}
      steps={<Steps label="Months" heading={ext.title} previous={ext.previous} next={ext.next} kit={kit} />}
    >
      {model.body.totals && <TotalLine totals={model.body.totals} />}
      <MonthCalendar ext={ext} rowOf={rowOf} totals={model.body.totals} kit={kit} />
      <MonthLegend ext={ext} />
    </UsageFrame>
  );
}

function UsageDay({ read, kit }: { read: Joined<DayExt>; kit: GuiKit }) {
  const { model, ext, rowOf } = read;
  const placed = placedOf(ext.previous?.href, ext.next?.href, ext.month.href);
  return (
    <UsageFrame
      name="tenant-usage-day"
      model={model}
      read={ext}
      placed={placed}
      kit={kit}
      steps={
        <div className="gt:flex gt:flex-col gt:items-center gt:gap-1">
          <div className="gt:w-full">
            <Steps label="Days" heading={ext.title} previous={ext.previous} next={ext.next} kit={kit} />
          </div>
          <kit.Link
            href={ext.month.href}
            className="gt:inline-flex gt:items-center gt:gap-1 gt:text-dense gt:text-primary gt:hover:underline gt:pointer-coarse:min-h-11 gt:focus-visible:outline-2 gt:focus-visible:outline-ring"
          >
            <span aria-hidden="true">↑</span>
            {ext.month.label}
          </kit.Link>
        </div>
      }
    >
      {model.body.totals && <TotalLine totals={model.body.totals} />}
      <HourBars hours={ext.hours} />
      <HourTable ext={ext} rowOf={rowOf} columns={model.body.columns} totals={model.body.totals} />
    </UsageFrame>
  );
}

export function UsageMonthView({ model, kit }: ViewProps & { kit: GuiKit }): SyncNode {
  const read = readUsageMonth(model);
  return read ? <UsageMonth read={read} kit={kit} /> : <kit.KitView model={model} />;
}

export function UsageDayView({ model, kit }: ViewProps & { kit: GuiKit }): SyncNode {
  const read = readUsageDay(model);
  return read ? <UsageDay read={read} kit={kit} /> : <kit.KitView model={model} />;
}
