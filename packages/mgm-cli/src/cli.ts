/**
 * The `mgm` command line: reads the arguments, runs a command, and prints
 * what it found, as text or, with `--json`, as one JSON object on stdout.
 * Prompts and progress go to stderr, so stdout carries only the answer.
 */
import { parseArgs } from "node:util";
import { type Deps, type LoggedOut, type SignedIn, login, logout, whoami } from "./commands.ts";
import { CliError, Unreachable, messageOf } from "./errors.ts";
import { CLI_CONTRACT, kindLabel } from "./identity.ts";

export type Output = { out: (text: string) => void; err: (text: string) => void };

export const USAGE = `Usage: mgm <command> [options]

Commands:
  login    Sign in to an MGM installation in your browser
  whoami   Say which installation and person this terminal is signed in as
  logout   End this terminal's session and delete its token file

Options:
  --url <address>   The address you open MGM at (login needs it the first time)
  --json            Print the answer as JSON
  --no-browser      Print the sign-in address without opening a browser (login)
  -h, --help        Show this help

mgm speaks GUI contract ${CLI_CONTRACT}.`;

function signedInText(answer: SignedIn, opening: string): string[] {
  const lines = [
    `${opening} ${answer.installation} as ${answer.email ?? answer.user_id}.`,
    `Client:     ${kindLabel(answer.client_kind)}`,
    `Token file: ${answer.token_file} (readable only by you)`,
    `Contract:   ${answer.contract.cli} (this mgm), ${answer.contract.installation ?? "not reported"} (installation)`,
  ];
  if (answer.contract_note) lines.push("", answer.contract_note);
  return lines;
}

function loggedOutText(answer: LoggedOut): string[] {
  switch (answer.session) {
    case "not_signed_in":
      return [`Not signed in to ${answer.installation}.`];
    case "ended":
      return [`Signed out of ${answer.installation}. The token file is deleted.`];
    case "already_ended":
      return [`Signed out of ${answer.installation}: the session had already ended. The token file is deleted.`];
    case "not_confirmed":
      return [`The token file for ${answer.installation} is deleted, but the session may still be signed in.`, answer.advice ?? ""];
  }
}

/** Runs `mgm` with `argv` (the arguments after the command name) and answers the exit code. */
export async function run(argv: string[], deps: Deps, output: Output): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        url: { type: "string" },
        json: { type: "boolean", default: false },
        "no-browser": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    output.err(`mgm: ${messageOf(error)}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (values.help || command === undefined || command === "help") {
    output.out(`${USAGE}\n`);
    return command === undefined && !values.help ? 2 : 0;
  }
  const json = values.json === true;
  const print = (answer: object, lines: string[]) => output.out(json ? `${JSON.stringify(answer, null, 2)}\n` : `${lines.join("\n")}\n`);

  try {
    if (extra.length > 0) throw new CliError("usage", `Unexpected argument: ${extra[0]}`, 2);
    const options = { url: values.url };
    switch (command) {
      case "login": {
        const loginDeps = values["no-browser"] ? { ...deps, openBrowser: async () => false } : deps;
        const answer = await login(loginDeps, options);
        print(answer, signedInText(answer, "Signed in to"));
        return 0;
      }
      case "whoami": {
        const answer = await whoami(deps, options);
        print(answer, signedInText(answer, "Signed in to"));
        return 0;
      }
      case "logout": {
        const answer = await logout(deps, options);
        print(answer, loggedOutText(answer));
        return answer.session === "not_confirmed" ? 1 : 0;
      }
      default:
        throw new CliError("usage", `Unknown command: ${command}. Run mgm --help.`, 2);
    }
  } catch (error) {
    const failure =
      error instanceof CliError
        ? { message: error.message, code: error.code, exit: error.exitCode }
        : error instanceof Unreachable
          ? { message: `${error.message}. Check the address and your connection, then try again.`, code: "unreachable", exit: 1 }
          : { message: `Something went wrong: ${messageOf(error)}`, code: "unexpected", exit: 1 };
    if (json) output.out(`${JSON.stringify({ error: failure.message, code: failure.code }, null, 2)}\n`);
    else output.err(`mgm: ${failure.message}\n`);
    return failure.exit;
  }
}
