-- Retire the community-level payment configuration accessor.
--
-- Payments read merchant credentials from payment_merchant_accounts through
-- fn_get_payment_merchant_secret (00065) and fn_payment_account_version
-- (20261010202643), both executable by service_role only.
-- fn_get_community_payment_secret (00020, re-issued by 00030) belonged to the
-- community-level configuration those replaced, and nothing calls it any
-- more. Drop it.
--
-- IF EXISTS keeps this a no-op on a database that never had the function.
-- No CASCADE: nothing in the schema depends on it, and if something did, the
-- drop should stop rather than take that object with it.
--
-- The communities.payment_provider* columns stay. 00065 copied their values
-- into payment_merchant_accounts and deletes nothing; clearing them is left
-- to operators.

DROP FUNCTION IF EXISTS public.fn_get_community_payment_secret(UUID);
