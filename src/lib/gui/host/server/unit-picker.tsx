import "server-only";

/**
 * What a tenant view's page shows a person with several units who opened
 * it without naming one (RFC mgm#197 § 4): their units, each linking to the
 * same page for that unit, as /go/<nav> offers places (./go-picker.tsx). It
 * renders inside the (gui) layout's shell with the pages' own components
 * and tokens. render-view.tsx draws it.
 */
import Link from "next/link";
import type { Href } from "../../contract";

export type UnitChoice = { label: string; detail: string | null; href: Href };

export function UnitPicker({ choices }: { choices: readonly UnitChoice[] }) {
  return (
    <div>
      <div className="mb-6 mt-4">
        <h1 className="text-headline font-semibold text-foreground">Your units</h1>
        <p className="mt-1 text-dense text-muted-foreground">Choose which unit to show.</p>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border bg-card">
        {choices.map((choice) => (
          <li key={choice.href}>
            <Link
              href={choice.href}
              className="flex min-h-11 flex-col justify-center px-4 py-2 text-body text-foreground hover:bg-muted"
            >
              <span>{choice.label}</span>
              {choice.detail && <span className="text-caption text-muted-foreground">{choice.detail}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
