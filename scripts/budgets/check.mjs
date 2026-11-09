// Checks first-load byte budgets after `npm run build`.
//   node scripts/budgets/check.mjs [--next .next] [--limits scripts/budgets/limits.json]
// Prints a table, appends it to GITHUB_STEP_SUMMARY when that is set, and
// exits 1 when a budget is exceeded, listing the over-budget files.

import { appendFileSync, readFileSync } from "node:fs";
import { compare, measure } from "./measure.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function main() {
  const nextDir = arg("--next", ".next");
  const limitsFile = arg("--limits", "scripts/budgets/limits.json");
  const limits = JSON.parse(readFileSync(limitsFile, "utf8"));
  const measurement = measure(nextDir, { shellLayout: limits.shell.layout });
  const result = compare(measurement, limits);

  const table = [
    "| Budget | Measured | Limit | Headroom | Largest files |",
    "|---|---:|---:|---:|---|",
    ...result.rows.map((r) =>
      `| ${r.ok ? "" : "**Over:** "}${r.budget} | ${n(r.measured)} | ${n(r.limit)} | ${n(r.limit - r.measured)} | ${r.files.slice(0, 3).join("<br>")} |`,
    ),
  ];
  const routes = [
    "Heaviest routes above the framework and shell (report only):",
    "",
    "| Route | Bytes |",
    "|---|---:|",
    ...measurement.routes.map((r) => `| ${r.route} | ${n(r.bytes)} |`),
  ];
  const text = [
    "## First-load byte budgets",
    "",
    "Bytes are gzip -9 of the build output; limits are in scripts/budgets/limits.json.",
    "",
    ...table,
    "",
    ...routes,
    "",
  ].join("\n");

  process.stdout.write(text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");

  if (!result.ok) {
    for (const r of result.rows.filter((row) => !row.ok)) {
      console.error(`Over budget: ${r.budget}: ${n(r.measured)} > ${n(r.limit)}`);
      for (const f of r.files) console.error(`  ${f}`);
    }
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
