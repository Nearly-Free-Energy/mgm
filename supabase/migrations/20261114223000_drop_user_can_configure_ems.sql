-- Drop the deprecated alias user_can_configure_ems.
--
-- 00053 kept it as a thin alias for user_can_access_microgrid so that code
-- deployed before #321 kept working. No released code calls it, no policy or
-- function body refers to it, and NFE's production database never had it.
-- Dropping it brings the chain to production's state.
--
-- IF EXISTS keeps this a no-op where it is absent. No CASCADE: nothing depends
-- on the function, and if something did, the drop should stop.

DROP FUNCTION IF EXISTS public.user_can_configure_ems(UUID);
