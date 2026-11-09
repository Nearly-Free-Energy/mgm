import "server-only";

/**
 * Builds the Values a contributed view sends to a GUI, formatted on the
 * server so every GUI prints the same text. The text comes from the format
 * primitives the pages use (src/components/format), so a figure reads the
 * same in a GUI as on a page; this module does no Intl formatting of its own.
 */
import { currencyFractionDigits, formatCurrency, formatRate } from "@/components/format/currency";
import { formatKwh } from "@/components/format/kwh";
import { formatLocalDate } from "@/components/format/local-date";
import { LOCAL_DATE_TIME_OPTS } from "@/components/format/local-date-time";
import { statusEntry } from "./status-maps";
import type { Fmt } from "./surface";

type Meta = { at?: string; derived?: true; synthetic?: true };

/** Copies only the flags that are set, so none appears as an undefined key. */
function meta(o: Meta | undefined): Meta {
  const m: Meta = {};
  if (o?.at !== undefined) m.at = o.at;
  if (o?.derived) m.derived = true;
  if (o?.synthetic) m.synthetic = true;
  return m;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An amount in minor units, rounded the way the currency primitive rounds the
 * text: half away from zero, on the decimal the amount is written as. Scaling
 * in binary would not: 1.005 * 100 is 100.49999999999999, so v would be 100
 * next to the text "$1.01". The exponent of the amount's shortest decimal form
 * is shifted instead, so "1.005" becomes "1.005e2", exactly 100.5. A
 * non-finite amount gives NaN, which the host's Value schema refuses.
 */
function toMinorUnits(amount: number, minor: number): number {
  const [mantissa, exponent = "0"] = String(Math.abs(amount)).split("e");
  const v = Math.round(Number(`${mantissa}e${Number(exponent) + minor}`));
  // `|| 0` keeps a negative amount that rounds to zero from giving -0.
  return amount < 0 ? -v || 0 : v;
}

export function createFmt({ locale }: { locale: string }): Fmt {
  const digits = (v: number, n: number) => formatRate(v, locale, { minDigits: n, maxDigits: n });

  return {
    text: (s) => ({ t: "text", text: s }),

    // The primitives' text for a missing value.
    empty: () => ({ t: "empty", text: formatRate(null, locale) }),

    number(v, unit) {
      const text = formatRate(v, locale, { minDigits: 0, maxDigits: 2 });
      return unit === undefined ? { t: "number", v, text } : { t: "number", v, unit, text: `${text} ${unit}` };
    },

    percent: (v, o) => ({ t: "percent", v, text: `${digits(v, 0)}%`, ...meta(o) }),

    money(amount, currency, o) {
      const minor = currencyFractionDigits(currency);
      // A bare figure keeps the currency's minor unit: "4,216,800" for UGX, "12.34" for USD.
      const text = o?.bare ? digits(amount, minor) : formatCurrency(amount, locale, currency);
      return { t: "money", v: toMinorUnits(amount, minor), currency, text };
    },

    energy(wh, o) {
      const v = wh / 1000;
      const text = formatKwh(v, locale);
      return { t: "energy", v, unit: "kWh", text: o?.bare ? text : `${text} kWh`, ...meta(o) };
    },

    power(w, o) {
      // Compared after rounding the magnitude, so 999.6 W and -999.5 W read
      // "1.0 kW" and "-1.0 kW" rather than "1,000 W" and "-1,000 W".
      if (Math.round(Math.abs(w)) >= 1000) {
        const v = w / 1000;
        return { t: "power", v, unit: "kW", text: `${digits(v, 1)} kW`, ...meta(o) };
      }
      return { t: "power", v: w, unit: "W", text: `${digits(w, 0)} W`, ...meta(o) };
    },

    date(isoDate) {
      const at = new Date(`${isoDate}T00:00:00Z`);
      if (!ISO_DATE.test(isoDate) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== isoDate) {
        throw new RangeError(`fmt.date expects a calendar date as YYYY-MM-DD, got "${isoDate}"`);
      }
      // In UTC, so a server west of UTC does not show the day before.
      const text = formatLocalDate(at, locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
      return { t: "date", v: isoDate, text };
    },

    datetime: (iso, tz) => ({
      t: "datetime",
      v: iso,
      tz,
      text: formatLocalDate(iso, locale, { ...LOCAL_DATE_TIME_OPTS, timeZone: tz }),
    }),

    status(map, v) {
      const entry = statusEntry(map, v);
      // An unknown status shows as itself in a neutral tone, as <StatusChip> does.
      return entry ? { t: "status", v, tone: entry.tone, text: entry.label } : { t: "status", v, tone: "neutral", text: v };
    },

    ref: (r) => ({ t: "ref", ref: r, text: r.label }),
  };
}
