/**
 * Errors crossing from a metering integration into the billing domain.
 * Provider-specific error types must be translated before they reach billing.
 */
export type MeteringErrorCode =
  | "METERING_UNAVAILABLE"
  | "METERING_UNAUTHORIZED"
  | "METERING_CONFIGURATION"
  | "METERING_INVALID_DATA"
  /**
   * A site read refused because most of the instants the source sent could
   * not be read, so the day cannot be placed on its bins. Its own code so it
   * is told apart from other data the source sent that MGM could not use.
   */
  | "METERING_UNREADABLE_TIMESTAMPS";

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
