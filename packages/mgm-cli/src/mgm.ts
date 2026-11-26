#!/usr/bin/env node
/**
 * The `mgm` command (RFC #259 § 4). Wires the commands to this computer:
 * the network, the terminal, the browser and the token store.
 */
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { openBrowser } from "./browser.ts";
import { run } from "./cli.ts";
import { Store, configBase } from "./store.ts";

const store = new Store(configBase(process.env, process.platform, homedir()), process.getuid?.());

process.exitCode = await run(
  process.argv.slice(2),
  {
    fetch: (input, init) => fetch(input, init),
    store,
    now: Date.now,
    platform: process.platform,
    note: (line) => process.stderr.write(`${line}\n`),
    openBrowser: (url) => openBrowser(url, process.platform, process.env),
    prompt: async (question) => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await terminal.question(question);
      } finally {
        terminal.close();
      }
    },
  },
  {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
);
