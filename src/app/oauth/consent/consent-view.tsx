"use client";

/**
 * The consent page's question and its two answers (#271). The server part
 * (./page.tsx) has already read the client from MGM's own table; nothing
 * here asks Supabase Auth anything until the person clicks Connect, because
 * Supabase Auth issues the code on its first look at a sign-in of a client
 * the person approved before (ADR-008 decision 3). Don't connect asks
 * nobody: with no record and no code, the sign-in expires on its own.
 */
import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import { AGENT_PROVIDER_NOTICE, CLIENT_KINDS, type ConsentClient } from "@/lib/auth/client-consent";
import { approveSignIn } from "./approve";
import { loadPage } from "./load-page";

type Phase = { kind: "ready" } | { kind: "working" } | { kind: "denied" } | { kind: "failed"; message: string };

export function ConsentView({
  authorizationId,
  client,
  email,
}: {
  authorizationId: string;
  client: ConsentClient;
  email: string | null;
}) {
  const [phase, setPhase] = React.useState<Phase>({ kind: "ready" });
  const kind = CLIENT_KINDS[client.kind];

  async function connect() {
    setPhase({ kind: "working" });
    const result = await approveSignIn(authorizationId, {
      fetch: (input, init) => fetch(input, init),
      oauth: createClient().auth.oauth,
      siteOrigin: window.location.origin,
    }).catch(() => ({ ok: false as const, message: "MGM could not finish connecting the app. Run mgm login again." }));
    if (!result.ok) {
      setPhase({ kind: "failed", message: result.message });
      return;
    }
    loadPage(result.redirectUrl);
  }

  if (phase.kind === "denied") {
    return (
      <div role="status" className="space-y-3">
        <h1 className="text-headline font-semibold text-foreground">Not connected</h1>
        <p className="text-body text-muted-foreground">
          {client.label} was not connected and gets nothing from MGM. You can close this tab.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-headline font-semibold text-foreground">Connect {client.label}?</h1>
        <p className="text-body text-muted-foreground">
          {client.label} wants to act as you in MGM
          {email ? (
            <>
              {" "}
              (<span className="break-all text-foreground">{email}</span>)
            </>
          ) : null}
          .
        </p>
      </div>

      <dl className="space-y-1 rounded-md bg-muted p-4">
        <dt className="text-caption font-medium text-subtle-foreground">Kind of app</dt>
        <dd className="text-body font-medium text-foreground">{kind.name}</dd>
        <dd className="text-dense text-muted-foreground">{kind.may}</dd>
        {client.kind === "agent" ? <dd className="text-dense text-muted-foreground">{AGENT_PROVIDER_NOTICE}</dd> : null}
      </dl>

      <div role="note" className="space-y-1 rounded-md border-l-4 border-warning bg-warning-muted p-4 text-warning-fg">
        <p className="text-body font-semibold">Did you run mgm login just now?</p>
        <p className="text-dense">
          A program on the computer that ran the command will act as you. Continue only if you ran{" "}
          <code className="font-mono">mgm login</code> yourself just now. If someone sent you this link, choose
          Don&apos;t connect.
        </p>
      </div>

      {phase.kind === "failed" ? (
        <p role="alert" className="rounded-md bg-destructive-muted p-3 text-dense text-destructive-fg">
          {phase.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <button
          type="button"
          onClick={() => void connect()}
          disabled={phase.kind === "working"}
          className="min-h-11 w-full rounded-md bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {phase.kind === "working" ? "Connecting..." : "Connect"}
        </button>
        <button
          type="button"
          onClick={() => setPhase({ kind: "denied" })}
          disabled={phase.kind === "working"}
          className="min-h-11 w-full rounded-md border border-border bg-card px-4 py-2 text-body font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          Don&apos;t connect
        </button>
      </div>
    </div>
  );
}
