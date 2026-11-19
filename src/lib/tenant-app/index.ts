// The composer is not re-exported: callers import it from ./compose, which
// scope-dispose.test.ts tracks (a barrel re-exporting it must be listed there).
export * from "./types";
