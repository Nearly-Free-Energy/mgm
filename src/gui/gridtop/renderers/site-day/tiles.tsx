"use client";

/**
 * The day's six tiles, as the Operations page shows them: solar, what the
 * houses used in the evening, power cuts, the lowest battery level, the
 * battery at 17:00 and lights on. Every figure, hint and status is text the
 * server formatted. Colour only marks a status, as a chip of its tone.
 */
import type { ReactNode } from "react";
import { cls } from "./ext";
import type { ModelOf, Tone, Value } from "@/lib/gui/contract";

export type Tile = ModelOf<"metrics">["body"]["tiles"][number];

/** Shown in another tile, or by the evening strip (./evening-strip.tsx): evening-supply. */
const FOLDED = new Set(["battery-evening", "cut-time", "evening-supply"]);
/** The tiles in the page's order; any other key follows them. */
const ORDER = ["solar", "houses-evening", "cuts", "lowest-soc", "soc-17", "lights-on"];

const CHIP: Record<Tone, string> = {
  neutral: "gt:bg-muted gt:text-muted-foreground",
  info: "gt:bg-muted gt:text-muted-foreground",
  accent: "gt:bg-accent gt:text-accent-foreground",
  success: "gt:bg-success-muted gt:text-success-fg",
  warning: "gt:bg-warning-muted gt:text-warning-fg",
  danger: "gt:bg-destructive-muted gt:text-destructive-fg",
};

/** A quiet mark on a generated figure; the band above the tiles says what it means. */
export function SyntheticMark() {
  return (
    <span title="Synthetic" className="gt:ml-0.5 gt:align-super gt:text-caption gt:font-normal gt:text-muted-foreground">
      <span aria-hidden="true">*</span>
      <span className="gt:sr-only"> (synthetic)</span>
    </span>
  );
}

/** A figure as given, with ≈ for a calculated one and the synthetic mark. */
export function Figure({ value }: { value: Value }) {
  return (
    <span className={value.t === "empty" ? "gt:text-muted-foreground" : undefined}>
      {value.derived && (
        <>
          <span aria-hidden="true">≈ </span>
          <span className="gt:sr-only">estimated </span>
        </>
      )}
      {value.text}
      {value.synthetic && <SyntheticMark />}
    </span>
  );
}

function Chip({ value }: { value: Value }) {
  const tone = value.t === "status" ? value.tone : "neutral";
  return (
    <span className={cls("gt:shrink-0 gt:rounded-pill gt:px-2 gt:py-0.5 gt:text-caption gt:font-semibold gt:uppercase", CHIP[tone] ?? CHIP.neutral)}>
      {value.text}
      {value.synthetic && <SyntheticMark />}
    </span>
  );
}

function TileCard(props: { tile: Tile; figure: ReactNode; hintMark?: boolean }) {
  const { tile, figure, hintMark } = props;
  return (
    <section data-tile={tile.key} className="gt:flex gt:flex-col gt:gap-1 gt:rounded-lg gt:border gt:border-border gt:bg-card gt:px-4 gt:py-3">
      <div className="gt:flex gt:items-start gt:justify-between gt:gap-2">
        <h3 className="gt:text-caption gt:font-semibold gt:uppercase gt:tracking-wide gt:text-muted-foreground">{tile.label}</h3>
        {tile.status && <Chip value={tile.status} />}
      </div>
      <p className="gt:text-kpi gt:font-semibold gt:tabular-nums gt:text-foreground">{figure}</p>
      {tile.hint && (
        <p className="gt:text-caption gt:text-muted-foreground">
          {tile.hint}
          {hintMark && <SyntheticMark />}
        </p>
      )}
    </section>
  );
}

export function Tiles({ tiles }: { tiles: Tile[] }) {
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  const batteryEvening = byKey.get("battery-evening");
  const cutTime = byKey.get("cut-time");
  const shown = [...ORDER.flatMap((key) => byKey.get(key) ?? []), ...tiles.filter((t) => !ORDER.includes(t.key) && !FOLDED.has(t.key))];

  const figureOf = (tile: Tile) => {
    // "3 / 4h 10m": the count of cuts and how long they lasted.
    if (tile.key === "cuts" && tile.value.t !== "empty" && cutTime) {
      return (
        <>
          <Figure value={tile.value} /> / <Figure value={cutTime.value} />
        </>
      );
    }
    return <Figure value={tile.value} />;
  };

  return (
    <>
      <div className="gt:grid gt:grid-cols-2 gt:gap-3 gt:medium:grid-cols-3">
        {shown.map((tile) => (
          <TileCard
            key={tile.key}
            tile={tile}
            figure={figureOf(tile)}
            // The houses' hint carries the battery's evening share, so its mark goes there.
            hintMark={tile.key === "houses-evening" && batteryEvening?.value.synthetic === true}
          />
        ))}
      </div>
    </>
  );
}
