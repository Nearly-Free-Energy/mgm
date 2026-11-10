/**
 * The kit: the only I/O a GUI has (GuiKit in ../contract.ts). Each part lives
 * in a "use client" module; this file only gathers them.
 *
 * KitView and RawView are not built yet, so the check below leaves out those
 * two names; when they land, it becomes `satisfies GuiKit`. `act` refuses
 * until the action host is mounted, and `useFeed` is inert.
 */
import type { GuiKit } from "../contract";
import { useManifest, useSignals, useView } from "../host/client/kit-provider";
import { act, loadView, open, search } from "../host/client/kit-runtime";
import { useFeed, useLive } from "../host/client/live";
import { Link, navigate, refresh, usePathname, useUiParam } from "../host/client/navigation";
import { SignOut } from "./sign-out";

export const kit = {
  useManifest,
  useView,
  useSignals,
  useLive,
  useFeed,
  loadView,
  search,
  Link,
  navigate,
  refresh,
  usePathname,
  useUiParam,
  act,
  open,
  SignOut,
} satisfies Omit<GuiKit, "KitView" | "RawView">;

export {
  useManifest,
  useView,
  useSignals,
  useLive,
  useFeed,
  loadView,
  search,
  Link,
  navigate,
  refresh,
  usePathname,
  useUiParam,
  act,
  open,
  SignOut,
};
