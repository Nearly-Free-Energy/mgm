# Payments rollout

Apply the complete migration chain, including `00065_payments_capability.sql` and `20261010202643_payments_integrity.sql`, before deploying the application. Existing community merchants remain separate accounts with community overrides; historical attempts keep their original account version. The integrity migration is safe to reapply.

Set `NEXT_PUBLIC_APP_URL` to the canonical HTTPS application origin. Configure a strong random `PAYMENTS_WORKER_SECRET` in the server environment. Store the same secret in Supabase Vault as `payments_worker_secret`, and the HTTPS `/api/payments/reconcile-worker` URL as `payments_worker_url`, using secure administrative tooling. Never commit these values. The migration schedules `mgm-payments-reconcile` every five minutes; without Vault configuration its database runner reports a configuration error, and without the application secret the endpoint fails closed. Monitor cron run details and application worker responses. Failed notifications back off and eventually become `dead_letter`; investigate these records rather than starting another checkout blindly.

In Organization → Payment accounts, configure and test a Pesapal sandbox merchant first. Enable Payments and Pesapal in plugin settings. A community inherits the organization default unless its Payment accounts page selects an override. Failed credential tests preserve the active configuration. No automatic payment email is sent; use the stable MGM payment link in an invoice or copy it manually.

Before enabling live payments, have the operator perform a sandbox checkout and confirm all of the following:

- The callback displays confirmation only after a server-side status lookup, and the bill, receipt, and audit event agree.
- Repeated IPNs, repeated clicks, and worker delivery do not duplicate accounting or create another outstanding checkout.
- A draft total correction flags any old payment for reconciliation. Payment history shows the current total, received amount, and difference.
- Plugin disablement blocks new checkout while keeping history and verification available. Manual payment recording remains independent.
- A verified reversal updates accounting. Any external reconciliation records the actual signed collection/refund amount, reference, and notes; MGM does not execute refunds.
- Notifications recover after a worker interruption, and persistent failures remain visible for investigation.

Local verification uses synthetic records and rolls back all rehearsal writes. Run `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/rehearse-payments.sql` against a scratch database. This exercises reservation, settlement rollback, duplicate events, reversal, correction, external settlement, organization isolation, and scheduler presence. It does not replace the operator's Pesapal sandbox transaction or deployment configuration checks.
