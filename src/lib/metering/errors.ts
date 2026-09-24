/**
 * Errors crossing from a metering integration into the billing domain.
 * Provider-specific error types must be translated before they reach billing.
 */
export type MeteringErrorCode =
  | "METERING_UNAVAILABLE"
  | "METERING_UNAUTHORIZED"
  | "METERING_CONFIGURATION"
  | "METERING_INVALID_DATA";

export class MeteringError extends Error {
  constructor(
    message: string,
    public readonly code: MeteringErrorCode,
    public readonly statusCode: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "MeteringError";
  }
}

