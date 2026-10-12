"use client";
import { useCallback, useEffect, useState } from "react";
import type { MerchantAccountPublic } from "@/lib/payments/repository";

export function MerchantSettings({ orgId, communityId }: { orgId: string; communityId?: string }) {
  const [accounts, setAccounts] = useState<(MerchantAccountPublic & { is_default: boolean })[]>([]);
  const [selected, setSelected] = useState("");
  const [consumerKey, setKey] = useState("");
  const [consumerSecret, setSecret] = useState("");
  const [sandbox, setSandbox] = useState(true);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [createOverride, setCreateOverride] = useState(false);
  const load = useCallback(async () => {
    const urls = [`/api/organizations/${orgId}/payment-accounts`, ...(communityId ? [`/api/communities/${communityId}/payment/override`] : [])];
    const responses = await Promise.all(urls.map(url => fetch(url)));
    const values = await Promise.all(responses.map(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; }));
    setAccounts(values[0].accounts);
    if (communityId) setSelected(values[1].override?.merchant_account_id ?? "");
    setReady(true);
  }, [orgId, communityId]);
  useEffect(() => { load().catch(error => setErrorMessage(error.message)); }, [load]);
  async function save() {
    setBusy(true); setMessage(""); setErrorMessage("");
    try {
      const response = await fetch(`/api/organizations/${orgId}/payment-accounts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consumerKey, consumerSecret, sandbox, createOverride, ...(accountId ? { accountId } : {}) }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setSecret(""); setMessage(value.message); await load();
    } catch (error) { setMessage(""); setErrorMessage(error instanceof Error ? error.message : "Configuration failed"); }
    finally { setBusy(false); }
  }
  async function setOverride() {
    setBusy(true); setMessage(""); setErrorMessage("");
    try {
      const response = await fetch(`/api/communities/${communityId}/payment/override`, { method: selected ? "PUT" : "DELETE", headers: { "Content-Type": "application/json" }, ...(selected ? { body: JSON.stringify({ merchantAccountId: selected }) } : {}) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error);
      setMessage("Community payment account updated."); await load();
    } catch (error) { setMessage(""); setErrorMessage(error instanceof Error ? error.message : "Override failed"); }
    finally { setBusy(false); }
  }
  return <section className="max-w-2xl space-y-4">
    <h1 className="text-2xl font-semibold">Payment accounts</h1>
    <p>New online payments require Payments and Pesapal to be enabled in Settings → Plugins. Manual payments and existing receipt reconciliation remain available.</p>
    {errorMessage && <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900"><h2 className="font-semibold">Payment configuration failed</h2><p className="mt-1">{errorMessage}</p></div>}
    {message && <p role="status" className="rounded-md border border-green-300 bg-green-50 p-4 text-green-900">{message}</p>}
    {!ready && <p>Loading accounts…</p>}
    <ul>{accounts.map(account => <li key={account.id}>{account.display_name} · {account.is_default ? "Organization default" : "Optional override"} · {account.sandbox ? "Sandbox" : "Live"} · {account.disabled ? "Disabled" : account.last_test_status ?? "Not tested"}</li>)}</ul>
    {communityId && <div className="space-y-2"><label>Community account<select aria-label="Community account" value={selected} onChange={event => setSelected(event.target.value)} className="ml-2 rounded border p-2"><option value="">Inherit organization default</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.display_name} ({account.sandbox ? "Sandbox" : "Live"})</option>)}</select></label><button disabled={busy || !ready} onClick={setOverride} className="rounded border p-2">Save community selection</button></div>}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="block">Account to configure<select aria-label="Account to configure" className="ml-2 rounded border p-2" value={createOverride ? "new" : accountId} onChange={event => { const id = event.target.value; setCreateOverride(id === "new"); setAccountId(id === "new" ? "" : id); const account = accounts.find(a => a.id === id); setKey(account?.consumer_key ?? ""); setSandbox(account?.sandbox ?? true); setSecret(""); }}><option value="">Organization default</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.display_name}</option>)}<option value="new">Create optional override account</option></select></label>
      <label className="block">Consumer key<input required value={consumerKey} onChange={event => setKey(event.target.value)} className="block w-full rounded border p-2" /></label>
      <label className="block">Consumer secret<input type="password" autoComplete="new-password" value={consumerSecret} onChange={event => setSecret(event.target.value)} className="block w-full rounded border p-2" /></label>
      <p>Leave the secret blank to preserve an existing account’s secret. Failed tests preserve its active configuration.</p>
      <label className="block"><input type="checkbox" checked={sandbox} onChange={event => setSandbox(event.target.checked)} /> Sandbox</label>
      <button disabled={busy || !ready} className="rounded bg-primary px-4 py-2 text-primary-foreground">{busy ? "Testing…" : "Save and test connection"}</button>
    </form>
  </section>;
}
