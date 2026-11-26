/**
 * The per-inviter limit on invitations (invite-limit.ts): up to
 * INVITATIONS_PER_WINDOW an hour per inviter, then refused with the seconds
 * to wait; each inviter counted apart; allowed again after the hour. The
 * route's use of it is tested in src/app/api/users/invite/__tests__.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  INVITATIONS_PER_WINDOW,
  INVITATION_WINDOW_MS,
  _resetInvitationLimiterForTests,
  checkInvitation,
} from "../invite-limit";

const INVITER = "11111111-1111-4000-8000-000000000001";
const OTHER = "11111111-1111-4000-8000-000000000002";
const T0 = Date.parse("2026-11-26T08:00:00Z");

const fill = (id: string) => {
  for (let i = 0; i < INVITATIONS_PER_WINDOW; i++) expect(checkInvitation(id, T0 + i).ok).toBe(true);
};

beforeEach(() => _resetInvitationLimiterForTests());

describe("checkInvitation", () => {
  it("allows up to the limit in an hour, then refuses with the seconds to wait", () => {
    fill(INVITER);
    const refused = checkInvitation(INVITER, T0 + 60_000);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfter).toBe(Math.ceil((INVITATION_WINDOW_MS - 60_000) / 1000));
  });

  it("counts each inviter apart", () => {
    fill(INVITER);
    expect(checkInvitation(OTHER, T0 + 60_000).ok).toBe(true);
  });

  it("allows invitations again once the hour has passed", () => {
    fill(INVITER);
    expect(checkInvitation(INVITER, T0 + INVITATION_WINDOW_MS + INVITATIONS_PER_WINDOW).ok).toBe(true);
  });

  it("starts again from nothing after the reset for tests", () => {
    fill(INVITER);
    _resetInvitationLimiterForTests();
    expect(checkInvitation(INVITER, T0 + 60_000).ok).toBe(true);
  });
});
