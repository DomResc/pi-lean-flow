/**
 * debug.ts — Shared debug logger.
 *
 * Returns a no-op when `PI_LEAN_DEBUG` is unset. Each module passes its own
 * scope tag so the prefix in stderr stays consistent (`[pi-lean-flow:<scope>]`).
 */

export type DebugFn = (...args: unknown[]) => void;

export function makeDebug(scope: string): DebugFn {
  if (!process.env.PI_LEAN_DEBUG) return () => {};
  return (...args: unknown[]) => {
    process.stderr.write(
      `[pi-lean-flow:${scope}] ${args.map(String).join(" ")}\n`,
    );
  };
}
