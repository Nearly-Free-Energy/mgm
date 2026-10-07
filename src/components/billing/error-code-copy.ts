// errorCodeCopy — friendly per-error-code copy for partial/full failures
// surfaced inside <RegenerateMultiDialog> and <PreflightPanel> result views.
//
// Codes mirror `GenerationErrorCode` in `src/lib/billing/generate.ts:80-86`.
// The route response includes `error.householdName`, so callers should pass
// that name straight through here — do NOT re-resolve from the `households`
// prop (it may have drifted from the server's view).
//
// Default fallback for unknown / future codes (or missing `code`):
//   `${name}: ${error}` — uses the route's verbatim `error` string.

import type { GenerationErrorCode } from "@/lib/billing/generate";

export interface PartialFailureError {
  householdId: string;
  householdName: string;
  error: string;
  code?: string;
}

export function errorCodeCopy(err: PartialFailureError): string {
  const name = err.householdName;
  switch (err.code as GenerationErrorCode | undefined) {
    case "currently_manual":
      return `${name} is set to manual entry — use per-row regenerate.`;
    case "unknown_household":
      return `${name} no longer belongs to this microgrid.`;
    case "no_meter_reading":
      return `${name} has no usable OpenEMS consumption for this billing period. Enter manual readings for this household.`;
    case "line_item_write_failed":
      return `${name}'s bill could not be saved. Retry after checking the reported error.`;
    case "tariff_changed":
      return `${name}'s billing tariff changed while this bill was being calculated — review the new tariff and regenerate this household.`;
    case "missing_openems_config":
      return `${name}'s edge has no OpenEMS connection configured.`;
    case "invalid_manual_reading":
      return `${name} has an invalid manual reading.`;
    case "unmetered_no_manual":
      return `${name} has no meter and no manual reading provided.`;
    case "meter_assignment_continuity":
      return `${name}'s meter assignment does not cover the whole period. Verify the historical meter and replacement date, or enter manual readings to reconcile this bill.`;
    case "needs_seed_reading":
      // #339. This message decides whether the operator walks to the meter or
      // types a zero to clear a block, so it must not read as a validation
      // complaint. It says why THIS household and not the others — without the
      // "billed before it was connected" clause the reasonable conclusion is
      // that something is broken, and the next action is a support message
      // rather than a walk to the wall — and it names the number wanted in the
      // operator's terms rather than as "a seed" or "start_kwh".
      return `${name}'s meter was billed before it was connected to OpenEMS — enter the reading from the meter to bill this household.`;
    default:
      return `${name}: ${err.error}`;
  }
}
