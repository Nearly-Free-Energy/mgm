/**
 * The cookie that remembers the organization a person last used, so the next
 * page opens there. It is a hint only: pickOrganization (../server/organization.ts)
 * ignores it unless it names an organization the person can see. If that
 * check moves, revisit.
 *
 * HostKitProvider (../client/host-kit-provider.tsx) writes it from the
 * browser whenever the manifest's organization changes. Sign-out
 * (../../kit/sign-out.tsx) expires it from the browser at Path=/ with no
 * Domain, so whatever writes it must use Path=/, no Domain and no HttpOnly.
 * If it becomes HttpOnly, sign-out needs a server route to clear it.
 */
export const ORG_COOKIE = "mgm-org";
