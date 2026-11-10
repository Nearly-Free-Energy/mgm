import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Per-file environment overrides (vitest 4.x equivalent of environmentMatchGlobs):
    // component tests run in jsdom, lib tests run in node.
    // Use @vitest-environment directive in test files or projects array in workspace config.
    projects: [
      {
        extends: true,
        test: {
          name: "components",
          include: ["src/components/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          // Multi-step wizard tests walk through 3-4 steps via
          // fireEvent + waitFor; the default 5s testTimeout occasionally
          // races under CI/local contention. 15s headroom — a legitimately
          // deadlocked test still fails fast.
          testTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: "lib",
          // Exclude RLS tests from the general lib project — they run in their own project.
          include: ["src/lib/**/*.test.{ts,tsx}"],
          exclude: [
            "src/lib/supabase/__tests__/rls.test.ts",
            "src/lib/supabase/__tests__/community_plugin.test.ts",
            "src/lib/supabase/__tests__/metering.test.ts",
            "src/lib/supabase/__tests__/ems_bearer_token.test.ts",
            "src/lib/supabase/__tests__/ems_keycloak_client.test.ts",
            "src/lib/supabase/__tests__/fn_list_visible_users.test.ts",
            "src/lib/supabase/__tests__/user_profiles_rls.test.ts",
            "src/lib/supabase/__tests__/dek-bootstrap.test.ts",
            "src/lib/supabase/__tests__/payment_state_machine.test.ts",
            "src/lib/supabase/__tests__/apply_payment_event_authz.test.ts",
            "src/lib/supabase/__tests__/billing_audit_log.test.ts",
            "src/lib/supabase/__tests__/audit_actor_kind.test.ts",
            "src/lib/supabase/__tests__/invoice_counters.test.ts",
            "src/lib/supabase/__tests__/invoice_logos_bucket.test.ts",
            "src/lib/supabase/__tests__/org_api_tokens_rls.test.ts",
            "src/lib/supabase/__tests__/ems_config_access.test.ts",
            "src/lib/supabase/__tests__/ems_basic_auth_credentials.test.ts",
            "src/lib/supabase/__tests__/billing_period_timezone.test.ts",
            "src/lib/supabase/__tests__/billing_period_delete_guard.test.ts",
            "src/lib/supabase/__tests__/keep_closed_and_paid_billing.test.ts",
            "src/lib/supabase/__tests__/payment_repeated_verification.test.ts",
            "src/lib/billing/__tests__/seed-reading.test.ts",
            "src/lib/__tests__/invite-user-rpc.test.ts",
            "src/lib/runtime/__tests__/gate.db.test.ts",
            "src/lib/gui/host/server/__tests__/entities.db.test.ts",
            "src/lib/gui/host/server/__tests__/manifest.db.test.ts",
            "src/lib/gui/host/server/__tests__/credential-canary.db.test.ts",
            "src/lib/supabase/__tests__/credential_key.test.ts",
            // Component tests of the interface kit and host run in the
            // "gui" project below, in jsdom. Without this line each would
            // also run here, in node, and fail.
            "src/lib/gui/**/*.test.tsx",
          ],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "gui",
          // Interface code: interface packages under src/gui, and the
          // component tests of the interface kit and host under src/lib/gui.
          // Node-only tests under src/lib/gui (*.test.ts) stay in "lib".
          include: ["src/gui/**/*.test.{ts,tsx}", "src/lib/gui/**/*.test.tsx"],
          environment: "jsdom",
          // Stand-ins for the browser APIs jsdom lacks, and a matchMedia
          // whose viewport width a test can set.
          setupFiles: ["src/test/gui-setup.ts"],
          // Same headroom as "components": these tests open menus, sheets
          // and dialogs through several fireEvent + waitFor steps.
          testTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: "rls",
          // RLS tests hit a live local Supabase — must be single-threaded to avoid
          // fixture-state collisions across test files sharing the same DB.
          // fileParallelism: false ensures tests within this project run sequentially.
          include: [
            "src/lib/supabase/__tests__/rls.test.ts",
            "src/lib/supabase/__tests__/community_plugin.test.ts",
            "src/lib/supabase/__tests__/metering.test.ts",
            "src/lib/supabase/__tests__/ems_bearer_token.test.ts",
            "src/lib/supabase/__tests__/ems_keycloak_client.test.ts",
            "src/lib/supabase/__tests__/fn_list_visible_users.test.ts",
            "src/lib/supabase/__tests__/user_profiles_rls.test.ts",
            "src/lib/supabase/__tests__/dek-bootstrap.test.ts",
            "src/lib/supabase/__tests__/payment_state_machine.test.ts",
            "src/lib/supabase/__tests__/apply_payment_event_authz.test.ts",
            "src/lib/supabase/__tests__/billing_audit_log.test.ts",
            "src/lib/supabase/__tests__/audit_actor_kind.test.ts",
            "src/lib/supabase/__tests__/invoice_counters.test.ts",
            "src/lib/supabase/__tests__/invoice_logos_bucket.test.ts",
            "src/lib/supabase/__tests__/org_api_tokens_rls.test.ts",
            "src/lib/supabase/__tests__/ems_config_access.test.ts",
            "src/lib/supabase/__tests__/ems_basic_auth_credentials.test.ts",
            "src/lib/supabase/__tests__/billing_period_timezone.test.ts",
            "src/lib/supabase/__tests__/billing_period_delete_guard.test.ts",
            "src/lib/supabase/__tests__/keep_closed_and_paid_billing.test.ts",
            "src/lib/supabase/__tests__/payment_repeated_verification.test.ts",
            "src/lib/billing/__tests__/seed-reading.test.ts",
            "src/lib/__tests__/invite-user-rpc.test.ts",
            "src/lib/runtime/__tests__/gate.db.test.ts",
            "src/lib/gui/host/server/__tests__/entities.db.test.ts",
            "src/lib/gui/host/server/__tests__/manifest.db.test.ts",
            "src/lib/gui/host/server/__tests__/credential-canary.db.test.ts",
            "src/lib/supabase/__tests__/credential_key.test.ts",
            "src/app/api/users/[id]/resend-invite/__tests__/rls-route.test.ts",
            "src/app/api/gui/view/__tests__/site-day.db.test.ts",
          ],
          environment: "node",
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "app",
          // Server-component tests (node environment) co-located with page files.
          include: ["src/app/**/*.test.{ts,tsx}"],
          // Exclude RLS-mode integration tests that live under src/app — they
          // run in the `rls` project (live local Supabase, sequential).
          exclude: [
            "src/app/api/users/[id]/resend-invite/__tests__/rls-route.test.ts",
            "src/app/api/gui/view/__tests__/site-day.db.test.ts",
          ],
          environment: "node",
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Next.js provides `server-only` as a compiler-level virtual module.
      // In vitest (no Next compiler) we alias to an empty stub so modules
      // guarded by `import 'server-only'` can be exercised in tests.
      "server-only": path.resolve(__dirname, "./src/test/server-only-stub.ts"),
    },
  },
});
