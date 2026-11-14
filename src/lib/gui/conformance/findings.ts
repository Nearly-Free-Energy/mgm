/** What a check reports, and the widths every check renders at. */
export type CheckId =
  | "version"
  | "manifests"
  | "kinds"
  | "targeted"
  | "proposals"
  | "writes"
  | "unknowns"
  | "a11y"
  | "frames";
export interface Finding {
  check: CheckId;
  fixture: string;
  message: string;
}

export const WIDTHS = [360, 800, 1366] as const;
