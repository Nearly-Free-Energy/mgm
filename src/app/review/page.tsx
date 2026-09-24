import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMgmReviewer } from "@/lib/mgm/access";
import { ReviewBills } from "./review-bills";

export const runtime = "nodejs";

export default async function ReviewPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!isMgmReviewer(user)) redirect("/no-access");

  const [{ data: periods, error: periodError }, { data: households, error: householdError }] =
    await Promise.all([
      supabase.from("billing_periods")
        .select("id,microgrid_id,start_date,end_date,timezone")
        .order("start_date", { ascending: false }),
      supabase.from("households")
        .select("id,microgrid_id"),
    ]);

  if (periodError || householdError) {
    return <main className="mx-auto max-w-5xl p-8 text-red-700">Could not load pilot billing data. Check your access and try again.</main>;
  }

  return (
    <main className="mx-auto max-w-6xl p-6 sm:p-10">
      <header className="mb-8 border-b border-gray-200 pb-6">
        <p className="mb-2 text-sm font-medium tracking-wide text-slate-500">MICRO GRID MANAGER</p>
        <h1 className="text-3xl font-semibold text-slate-900">Review bills</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Compare saved bills with a fresh calculation from live meter readings. This review does not issue or change bills.
        </p>
      </header>
      <ReviewBills periods={periods ?? []} households={households ?? []} />
    </main>
  );
}
