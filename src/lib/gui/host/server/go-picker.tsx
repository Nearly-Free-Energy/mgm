import "server-only";

/**
 * What /go/<nav> shows when it cannot send the person straight on: the
 * places to choose from, or, when there is none, says so. It renders inside
 * the (gui) layout's shell with the pages' own components and tokens.
 */
import Link from "next/link";
import type { CoreEntityKind } from "@/lib/plugins/bundled";
import { EmptyState } from "@/components/ui/empty-state";
import type { GoTarget } from "./go";

/** "billingPeriod" → "billing period". */
const words = (kind: CoreEntityKind) => kind.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
const article = (word: string) => (/^[aeiou]/.test(word) ? "an" : "a");
const phrase = (kinds: readonly CoreEntityKind[]) => {
  const text = kinds.map(words).join(" and ");
  return `${article(text)} ${text}`;
};

const LINK = "text-sm font-medium text-primary hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";

export function GoPicker({ target }: { target: Extract<GoTarget, { kind: "choose" | "none" }> }) {
  return (
    <div>
      <div className="mb-6 mt-4">
        <h1 className="text-2xl font-semibold text-foreground">{target.title}</h1>
        {target.kind === "choose" && (
          <p className="mt-1 text-sm text-muted-foreground">Choose {phrase(target.needs)} to open it in.</p>
        )}
      </div>
      {target.kind === "choose" ? (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {target.choices.map((choice) => (
            <li key={choice.href}>
              <Link
                href={choice.href}
                className="flex min-h-11 items-center px-4 py-2 text-sm text-foreground hover:bg-muted"
              >
                {choice.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <section>
          <h2 className="sr-only">Where to open it</h2>
          <EmptyState
            title={
              target.listed && target.missing
                ? `Add ${article(words(target.missing))} ${words(target.missing)} first`
                : "Open it from the page that leads to it"
            }
            body={
              target.listed
                ? `${target.title} opens in ${phrase(target.needs)}, and there is none to open it in yet.`
                : target.missing
                  ? `${target.title} opens in ${phrase(target.needs)}, which this link cannot choose.`
                  : `${target.title} opens in ${phrase(target.needs)}, and none of yours fits this link.`
            }
            cta={
              target.list && (
                <Link href={target.list.href} className={LINK}>
                  {target.list.label}
                </Link>
              )
            }
          />
        </section>
      )}
    </div>
  );
}
