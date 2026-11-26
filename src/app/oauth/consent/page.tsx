/**
 * /oauth/consent — where Supabase Auth sends a person who runs `mgm login`
 * (RFC #259 § 1, ADR-008 decision 3, #271). supabase/config.toml and a hosted
 * project's authorization path point here.
 *
 * It names the client, its kind and what that kind may do, warns that a
 * program on the computer that ran the command will act as the person, and
 * waits for a click. It shows all of this even for a client the person
 * approved before, which Supabase Auth would approve without asking: the
 * client is read from MGM's own records (fn_client_authorization_read), and
 * Supabase Auth is asked nothing until the person clicks (./consent-view.tsx).
 *
 * Outside the (gui) group, like /login and /auth/confirm, so it serves staff
 * and a person whose rows are all tenant rows alike: no interface shell, no
 * organization, no role read. A signed-out person is sent to /login and back
 * here once signed in. The read runs as the service role only after
 * getUser() has checked the cookie session, for that user's id; it tells
 * nothing about a sign-in Supabase Auth has bound to someone else.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { RETURN_PATH_PARAM } from "@/lib/auth/return-path";
import {
  CONSENT_PATH,
  CONSENT_PROBLEMS,
  isAuthorizationId,
  readClientAuthorization,
} from "@/lib/auth/client-consent";
import { ConsentView } from "./consent-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect an app",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-8">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-elev-1 sm:p-8">{children}</div>
    </main>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <Frame>
      <div className="space-y-4">
        <h1 className="text-headline font-semibold text-foreground">Connect an app</h1>
        <p role="alert" className="rounded-md bg-destructive-muted p-3 text-body text-destructive-fg">
          {message}
        </p>
        <Link
          href="/"
          className="flex min-h-11 w-full items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-body font-medium text-foreground hover:bg-muted"
        >
          Go to MGM
        </Link>
      </div>
    </Frame>
  );
}

export default async function ClientConsentPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).authorization_id;
  const authorizationId = typeof raw === "string" ? raw : null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Middleware sends a signed-out request to /login first; this catches a
    // session Supabase Auth has ended elsewhere, which middleware's claims
    // check still passes.
    const back = authorizationId
      ? `${CONSENT_PATH}?${new URLSearchParams({ authorization_id: authorizationId })}`
      : CONSENT_PATH;
    redirect(`/login?${new URLSearchParams({ [RETURN_PATH_PARAM]: back })}`);
  }

  if (!isAuthorizationId(authorizationId)) {
    return <Problem message="This sign-in link is incomplete. Run mgm login again." />;
  }

  const read = await readClientAuthorization(createServiceClient(), authorizationId, user.id);
  if (read.outcome !== "ok") {
    return <Problem message={CONSENT_PROBLEMS[read.outcome].message} />;
  }

  return (
    <Frame>
      <ConsentView authorizationId={authorizationId} client={read.client} email={user.email ?? null} />
    </Frame>
  );
}
