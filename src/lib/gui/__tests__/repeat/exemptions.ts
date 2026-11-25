/**
 * Billing, payments and Pesapal actions allowed to declare repeat "unsafe"
 * while the issue named builds their repeat key (#276). Read by check 12 of
 * ../gui-surface.test.ts, which refuses "unsafe" on those plugins' actions
 * unless this list names the action.
 *
 * An entry goes in only for an action that failed the twice-sent test
 * (../repeat.db.test.ts), with the issue that will make it "keyed"; that
 * test sends only "safe" actions, so the action leaves its cases while it
 * is listed here. The entry goes when the action becomes "keyed" and gains
 * a twice-sent case again.
 *
 * RFC #259 § 3 says a billing or payments action may not be "unsafe": this
 * list is the one exception #276 allows, until a key exists. If that
 * exception is withdrawn, delete this module and check 12's use of it, and
 * check 12 refuses every "unsafe" billing, payments or Pesapal action.
 *
 * Empty: every billing and payments action is "safe".
 */
import type { Id } from "@/lib/gui/contract";

export interface RepeatKeyPending {
  /** What a second send writes, as the twice-sent test showed. */
  reason: string;
  /** The issue building the action's repeat key. */
  key: `#${number}`;
}

export const REPEAT_KEY_PENDING: Readonly<Record<Id, RepeatKeyPending>> = {};
