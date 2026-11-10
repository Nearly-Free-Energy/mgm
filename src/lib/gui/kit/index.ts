/**
 * The kit: the only I/O a GUI has (GuiKit in ../contract.ts). Each part lives
 * in a "use client" module; this file only gathers them.
 *
 * `act` reaches the ActionHost that KitProvider mounts, and `useFeed` is
 * inert. The write itself (host/client/invoke.ts) is not exported
 * (write-path.test.ts).
 *
 * ActionForm and Overlay are not members of GuiKit (../contract.ts): the host
 * uses them when a GUI brings no form or frame, and a GUI may name them as
 * its own. If GuiKit gains them, export them through `kit` instead.
 */
import type { FormProps, GuiKit, OverlayProps, SyncComponent } from "../contract";
import { useManifest, useSignals, useView } from "../host/client/kit-provider";
import { act, loadView, open, search } from "../host/client/kit-runtime";
import { useFeed, useLive } from "../host/client/live";
import { Link, navigate, refresh, usePathname, useUiParam } from "../host/client/navigation";
import { ActionForm as KitActionForm } from "./action-form";
import { KitView } from "./kit-view";
import { Overlay as KitOverlay } from "./overlay";
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

export const ActionForm: SyncComponent<FormProps> = KitActionForm;
export const Overlay: SyncComponent<OverlayProps> = KitOverlay;

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
