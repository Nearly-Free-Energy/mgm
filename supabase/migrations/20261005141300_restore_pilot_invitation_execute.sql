-- The curated pilot overlay revoked this RPC from authenticated callers,
-- while POST /api/users/invite finalizes through the inviter's JWT. The
-- function checks auth.uid() and the inviter's organization access itself.
-- Restore the grant from 00045 without exposing it to anonymous callers.
REVOKE EXECUTE ON FUNCTION public.fn_finalize_user_invitation(
  UUID, TEXT, TEXT, TEXT, public.user_role, UUID
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_finalize_user_invitation(
  UUID, TEXT, TEXT, TEXT, public.user_role, UUID
) TO authenticated;
