"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

export function SetupForm() {
  const router = useRouter();
  const [bootstrapToken, setBootstrapToken] = React.useState("");
  const [name, setName] = React.useState("");
  const [city, setCity] = React.useState("");
  const [country, setCountry] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/mgm/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bootstrap_token: bootstrapToken,
          organization: {
            name,
            address_city: city,
            address_country: country,
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? "Could not complete setup. Please try again.");
        setSubmitting(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Please retry.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="setup-token"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Bootstrap token
        </label>
        <input
          id="setup-token"
          type="password"
          value={bootstrapToken}
          onChange={(event) => setBootstrapToken(event.target.value)}
          required
          autoComplete="off"
          className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="From the MGM_BOOTSTRAP_TOKEN environment variable"
        />
      </div>
      <div>
        <label
          htmlFor="setup-org-name"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Organization name
        </label>
        <input
          id="setup-org-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="New Frontiers Energy"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="setup-city"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            City
          </label>
          <input
            id="setup-city"
            type="text"
            value={city}
            onChange={(event) => setCity(event.target.value)}
            required
            className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Kampala"
          />
        </div>
        <div>
          <label
            htmlFor="setup-country"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Country
          </label>
          <input
            id="setup-country"
            type="text"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            required
            className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Uganda"
          />
        </div>
      </div>
      {error ? (
        <div
          role="alert"
          className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg"
        >
          {error}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Creating organization…" : "Create organization"}
      </button>
    </form>
  );
}
