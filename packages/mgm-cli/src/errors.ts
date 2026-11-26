/** A failure the CLI explains to the person: `message` is what they read, `code` what `--json` reports. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** A request that got no answer: the network failed, it timed out, or the server answered 5xx. */
export class Unreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unreachable";
  }
}

/** The message of an error that may not be an Error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
