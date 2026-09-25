"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Banner } from "@/components/ui/banner";

/**
 * OpeningRegisterDialog — record an explicit opening register for a meter
 * (issue #4). Posts to POST /api/meter-readings/opening, which validates
 * the value, timestamp, device scope, and duplicate evidence server-side.
 * Imports and live reads never invent this row.
 */
export function OpeningRegisterDialog({
  deviceId,
  deviceName,
  open,
  onOpenChange,
}: {
  deviceId: string;
  deviceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [reading, setReading] = React.useState("");
  const [readAt, setReadAt] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setReading("");
      setReadAt("");
      setError(null);
      setSubmitting(false);
    }
  }, [open ]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const readingKwh = Number(reading);
    if (!Number.isFinite(readingKwh) || readingKwh < 0) {
      setError("Enter a register reading in kWh (0 or more).");
      return;
    }
    if (!readAt) {
      setError("Choose the date and time the register was read.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/meter-readings/opening", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: deviceId,
          reading_kwh: readingKwh,
          read_at: new Date(readAt).toISOString(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? `Could not save (HTTP ${res.status}).`);
        setSubmitting(false);
        return;
      }
      router.refresh();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
        <Dialog.Content
          aria-modal
          className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[94%] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-card p-6 shadow-elev-3 outline-none"
        >
          <Dialog.Title className="text-lg font-semibold text-foreground">
            Record opening register
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
            {deviceName} — the meter&apos;s register at the start of its first
            billable period. This becomes the baseline every later reading is
            compared against.
          </Dialog.Description>
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {error && (
              <Banner tone="destructive" title="Could not save">
                {error}
              </Banner>
            )}
            <div>
              <label
                htmlFor="opening-reading"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Register reading (kWh)
              </label>
              <input
                id="opening-reading"
                type="number"
                min={0}
                step="any"
                value={reading}
                onChange={(e) => setReading(e.target.value)}
                disabled={submitting}
                required
                className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label
                htmlFor="opening-read-at"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Read at
              </label>
              <input
                id="opening-read-at"
                type="datetime-local"
                value={readAt}
                onChange={(e) => setReadAt(e.target.value)}
                disabled={submitting}
                required
                max={new Date().toISOString().slice(0, 16)}
                className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Save register"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
