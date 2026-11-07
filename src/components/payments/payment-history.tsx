"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { DialogOverlay, DialogPanel } from "@/components/ui/dialog";
import type { PaymentAttempt, PaymentReceipt } from "@/lib/payments/repository";

export function PaymentHistory({ lineItemId }: { lineItemId: string }) {
 const router = useRouter();
 const [open, setOpen] = useState(false);
 const [attempts, setAttempts] = useState<PaymentAttempt[]>([]);
 const [receipts, setReceipts] = useState<PaymentReceipt[]>([]);
 const [balance, setBalance] = useState<{ currentTotal: number; received: number; difference: number; currency: string } | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState("");
 const [externalAmount, setAmount] = useState("");
 const [reference, setReference] = useState("");
 const [notes, setNotes] = useState("");
 async function load() {
  const response = await fetch(`/api/payments/attempts?lineItemId=${lineItemId}`);
  const value = await response.json(); if (!response.ok) throw new Error(value.error);
  setAttempts(value.attempts); setReceipts(value.receipts); setBalance(value);
 }
 async function show() {
  setBusy(true); setError(""); setOpen(true);
  try { await load(); } catch (error) { setError(error instanceof Error ? error.message : "History unavailable"); }
  finally { setBusy(false); }
 }
 async function act(attempt: PaymentAttempt, action: "refresh" | "accept_exact" | "record_external") {
  setBusy(true); setError("");
  try {
   if (action === "record_external" && (externalAmount.trim() === "" || !Number.isFinite(Number(externalAmount)))) throw new Error("Enter the actual externally collected amount, or a negative refund amount.");
   const response = await fetch(`/api/payments/attempts/${attempt.id}/${action === "refresh" ? "refresh" : "reconcile"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, externalAmount: Number(externalAmount), externalReference: reference, notes }) });
   const value = await response.json(); if (!response.ok) throw new Error(value.error);
   await load(); router.refresh();
  } catch (error) { setError(error instanceof Error ? error.message : "Payment action failed"); }
  finally { setBusy(false); }
 }
 // While a request runs the trigger is aria-disabled rather than disabled: closing the dialog returns focus to it, and a
 // disabled button cannot take focus, so Esc would leave focus on <body>. A click while busy does nothing. Its
 // preventDefault is what keeps Dialog.Trigger from opening the dialog, because Radix skips its own click handler on a
 // default-prevented event; if Radix stops doing that, the busy-click case in payments.test.tsx fails.
 return <span><Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><button className="text-xs underline" onClick={event => { if (busy) { event.preventDefault(); return; } void show(); }} aria-disabled={busy || undefined}>Payment history</button></Dialog.Trigger><Dialog.Portal><DialogOverlay /><DialogPanel className="w-[672px] p-6">
  <Dialog.Close asChild><button className="float-right underline">Close</button></Dialog.Close><Dialog.Title className="text-xl font-semibold">Payment history</Dialog.Title>
  <Dialog.Description>Receipts remain available when online payments are disabled.</Dialog.Description>
  {balance && <p className="my-3">Current bill: {balance.currentTotal} {balance.currency} · Received: {balance.received} {balance.currency} · Difference: {balance.difference} {balance.currency}</p>}
  {error && <p role="alert" className="my-2 text-destructive">{error}</p>}
  {busy && <p>Loading…</p>}{!busy && !attempts.length && <p>No online payment attempts.</p>}
  {attempts.map(attempt => <article className="my-3 space-y-2 rounded border p-3" key={attempt.id}>
   <p>{attempt.amount} {attempt.currency} · {attempt.status.replaceAll("_", " ")}</p><p className="break-all text-xs">{attempt.merchant_reference}</p>
   {attempt.failure_message && <p>{attempt.failure_message}</p>}
   <ul>{receipts.filter(r => r.attempt_id === attempt.id).map(r => <li key={r.id}>{r.provider_status}: {r.amount} {r.currency} · {r.confirmation_code ?? "No confirmation code"}</li>)}</ul>
   <button disabled={busy} className="rounded border p-2" onClick={() => act(attempt, "refresh")}>Refresh status</button>
   {attempt.status === "needs_reconciliation" && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void act(attempt, "record_external"); }}>
    <p>Record only an externally completed collection or refund. MGM does not execute refunds here.</p>
    <label className="block">External amount (negative for refund)<input className="block rounded border p-2" type="number" step="any" required value={externalAmount} onChange={event => setAmount(event.target.value)} /></label>
    <label className="block">External reference<input className="block rounded border p-2" required value={reference} onChange={event => setReference(event.target.value)} /></label>
    <label className="block">Notes<textarea className="block rounded border p-2" required value={notes} onChange={event => setNotes(event.target.value)} /></label>
    <button disabled={busy} className="rounded border p-2">Record completed adjustment</button><button type="button" disabled={busy} className="ml-2 rounded border p-2" onClick={() => act(attempt, "accept_exact")}>Accept exact receipts</button>
   </form>}
  </article>)}
 </DialogPanel></Dialog.Portal></Dialog.Root></span>;
}
