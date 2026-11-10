/**
 * The kit: the only I/O a GUI has (GuiKit in ../contract.ts). Each part lives
 * in a "use client" module; this file only gathers them.
 *
 * `act` reaches the ActionHost that KitProvider mounts, and `useFeed` is
 * inert. The write itself (host/client/invoke.ts) is not exported
 * (write-path.test.ts).
 */
import type { GuiKit } from "../contract";
import { useManifest, useSignals, useView } from "../host/client/kit-provider";
import { act, loadView, open, search } from "../host/client/kit-runtime";
import { useFeed, useLive } from "../host/client/live";
import { Link, navigate, refresh, usePathname, useUiParam } from "../host/client/navigation";
import { KitView } from "./kit-view";
import { RawView } from "./raw-view";
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
  KitView,
  RawView,
  SignOut,
} satisfies GuiKit;

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
  KitView,
  RawView,
  SignOut,
};
