import "server-only";

import { createHmac } from "node:crypto";

/** The only source fields accepted by the synthetic pilot importer. */
export const PILOT_SOURCE_FIELDS = [
  "source_household_id",
  "source_meter_id",
  "reading_kwh",
  "read_at",
] as const;

export const PILOT_IMPORT_LIMITS = {
  households: 500,
  readings: 5_000,
} as const;

export type PilotSourceRow = {
  source_household_id: string;
  source_meter_id: string;
  reading_kwh: number;
  read_at: string;
};

export type PreparedPilotReading = {
  household_key: string;
  meter_key: string;
  reading_kwh: number;
  read_at: string;
};

export type ExistingPilotReading = Pick<PreparedPilotReading, "meter_key" | "reading_kwh" | "read_at">;

export type PilotReconciliation = {
  inserts: PreparedPilotReading[];
  unchanged: number;
  conflicts: Array<{ meter_key: string; read_at: string }>;
  duplicate_source_rows: number;
};

export class PilotImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PilotImportError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PilotImportError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validates and pseudonymizes an in-memory synthetic CSV payload.
 * Unknown columns are rejected so names, contact details, and addresses cannot
 * silently pass through. Raw source IDs are never returned or logged.
 */
export function preparePilotRows(rows: unknown[], pseudonymizationKey: string): PreparedPilotReading[] {
  if (!Array.isArray(rows) || rows.length > PILOT_IMPORT_LIMITS.readings) {
    throw new PilotImportError(`Pilot import is limited to ${PILOT_IMPORT_LIMITS.readings} readings`);
  }
  if (Buffer.byteLength(pseudonymizationKey, "utf8") < 32) {
    throw new PilotImportError("Pseudonymization key must contain at least 32 bytes");
  }

  const prepared: PreparedPilotReading[] = [];
  const householdKeys = new Set<string>();

  for (const [index, input] of rows.entries()) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new PilotImportError(`Row ${index + 1} must be an object`);
    }
    const row = input as Record<string, unknown>;
    const unexpected = Object.keys(row).filter((field) => !(PILOT_SOURCE_FIELDS as readonly string[]).includes(field));
    if (unexpected.length) {
      throw new PilotImportError(`Row ${index + 1} contains unsupported fields: ${unexpected.join(", ")}`);
    }

    const sourceHouseholdId = requireNonEmptyString(row.source_household_id, "source_household_id");
    const sourceMeterId = requireNonEmptyString(row.source_meter_id, "source_meter_id");
    const readAt = requireNonEmptyString(row.read_at, "read_at");
    const timestamp = Date.parse(readAt);
    if (!Number.isFinite(timestamp)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(readAt)) {
      throw new PilotImportError(`Row ${index + 1} read_at must be an ISO timestamp with timezone`);
    }
    if (typeof row.reading_kwh !== "number" || !Number.isFinite(row.reading_kwh) || row.reading_kwh < 0) {
      throw new PilotImportError(`Row ${index + 1} reading_kwh must be a finite non-negative number`);
    }

    const householdKey = pseudonymize("household", sourceHouseholdId, pseudonymizationKey);
    householdKeys.add(householdKey);
    if (householdKeys.size > PILOT_IMPORT_LIMITS.households) {
      throw new PilotImportError(`Pilot import is limited to ${PILOT_IMPORT_LIMITS.households} households`);
    }

    prepared.push({
      household_key: householdKey,
      meter_key: pseudonymize("meter", sourceMeterId, pseudonymizationKey),
      reading_kwh: row.reading_kwh,
      read_at: new Date(timestamp).toISOString(),
    });
  }

  return prepared;
}

function pseudonymize(kind: "household" | "meter", sourceId: string, key: string): string {
  return `pilot_${createHmac("sha256", key).update(`${kind}\u0000${sourceId}`, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * A fail-closed guard for operator-triggered writes. Only explicitly named,
 * local targets are accepted; all hosted database URLs are rejected.
 */
export function assertPilotImportTarget(input: {
  target: string;
  targetMicrogridId: string;
  expectedPilotMicrogridId: string;
  databaseUrl: string;
  operatorConfirmed: boolean;
  dryRun: boolean;
}): void {
  if (input.target !== "synthetic-pilot") throw new PilotImportError("Target must be synthetic-pilot");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(input.targetMicrogridId) || !uuidPattern.test(input.expectedPilotMicrogridId)
    || input.targetMicrogridId.toLowerCase() !== input.expectedPilotMicrogridId.toLowerCase()) {
    throw new PilotImportError("Target microgrid must match the explicitly configured synthetic pilot microgrid");
  }
  if (input.dryRun) return;
  if (!input.operatorConfirmed) throw new PilotImportError("An operator must explicitly confirm the import");

  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new PilotImportError("Database URL is invalid");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !localHosts.has(url.hostname)) {
    throw new PilotImportError("Pilot import writes are restricted to a local database target");
  }
}

/** Computes a reviewable, non-destructive reconciliation against current readings. */
export function reconcilePilotRows(
  incoming: PreparedPilotReading[],
  existing: ExistingPilotReading[],
): PilotReconciliation {
  const byIdentity = new Map<string, ExistingPilotReading>();
  for (const item of existing) byIdentity.set(identity(item), item);

  const inserts: PreparedPilotReading[] = [];
  const conflicts: PilotReconciliation["conflicts"] = [];
  let unchanged = 0;
  let duplicateSourceRows = 0;
  const seen = new Map<string, PreparedPilotReading>();

  for (const row of incoming) {
    const key = identity(row);
    const priorInFile = seen.get(key);
    if (priorInFile) {
      if (priorInFile.reading_kwh !== row.reading_kwh) conflicts.push({ meter_key: row.meter_key, read_at: row.read_at });
      else duplicateSourceRows += 1;
      continue;
    }
    seen.set(key, row);

    const prior = byIdentity.get(key);
    if (!prior) inserts.push(row);
    else if (prior.reading_kwh === row.reading_kwh) unchanged += 1;
    else conflicts.push({ meter_key: row.meter_key, read_at: row.read_at });
  }

  return { inserts, unchanged, conflicts, duplicate_source_rows: duplicateSourceRows };
}

function identity(item: Pick<PreparedPilotReading, "meter_key" | "read_at">): string {
  return `${item.meter_key}\u0000${item.read_at}`;
}
