import "server-only";
import type { RuntimeEnv } from "./public-runtime-config";

/**
 * `MGM_METERING_FIXTURES`: whether this installation may generate synthetic
 * site data for microgrids whose edges carry the reserved `SYNTHETIC-EDGE-`
 * ids (decision 12 on #115). Off unless set to an "on" value.
 *
 * Read per call, like the other settings (ADR-003), and never sent to the
 * browser. An invalid value counts as off and never throws: a demonstration
 * switch must not stop anything else. It is logged at server start, naming
 * the variable and never the value.
 */
export const METERING_FIXTURES_VARIABLE = "MGM_METERING_FIXTURES";

const ON = new Set(["1", "true", "on"]);
const OFF = new Set(["", "0", "false", "off"]);

/** "on" for 1, true, on; "off" when unset, blank, 0, false, off (any case); "invalid" otherwise. */
export function readMeteringFixtures(env: RuntimeEnv = process.env): "on" | "off" | "invalid" {
  const value = (env.MGM_METERING_FIXTURES ?? "").trim().toLowerCase();
  if (ON.has(value)) return "on";
  if (OFF.has(value)) return "off";
  return "invalid";
}

/** True only for an "on" value; an invalid value is off. */
export function meteringFixturesEnabled(env: RuntimeEnv = process.env): boolean {
  return readMeteringFixtures(env) === "on";
}

/**
 * The start-up check (src/instrumentation.ts): logs an invalid value as an
 * error and an "on" value as a warning, so synthetic data is never on
 * unnoticed. Never throws.
 */
export function validateMeteringFixturesAtStartup(env: RuntimeEnv = process.env): void {
  const state = readMeteringFixtures(env);
  if (state === "invalid") {
    console.error(
      `[mgm] ${METERING_FIXTURES_VARIABLE} must be on or off; synthetic site data stays off.`,
    );
  } else if (state === "on") {
    console.warn(
      `[mgm] ${METERING_FIXTURES_VARIABLE} is on: microgrids on SYNTHETIC-EDGE- edges may show generated site data.`,
    );
  }
}
