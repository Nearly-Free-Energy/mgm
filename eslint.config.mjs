import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The (gui) catch-all page makes every same-site path a page to this rule,
  // so a test's plain <a href="/x"> fixture would be refused. Application
  // code still uses next/link. If the catch-all goes, this can go too.
  {
    files: ["**/__tests__/**", "**/*.test.{ts,tsx}"],
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
