export function isMgmReviewer(user: { id: string; email?: string | null }): boolean {
  const allowedId = process.env.MGM_REVIEW_ALLOWED_USER_ID;
  const allowedEmail = process.env.MGM_REVIEW_ALLOWED_EMAIL;
  if (allowedId) return user.id === allowedId;
  if (allowedEmail) return user.email?.toLowerCase() === allowedEmail.toLowerCase();
  // A missing allowlist must never make a production deployment public.
  return process.env.NODE_ENV !== "production";
}
