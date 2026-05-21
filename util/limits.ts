/**
 * limits.ts — Central registry of size/cap constants used across the
 * extension. Centralising these makes them easier to discover, tune, and
 * (where relevant) override from `.pi-lean-flow/config.json`.
 *
 * Each constant is documented inline with its rationale so a future bump is
 * a one-line change with context.
 */

import { readConfigPositiveInt } from "../quality/gate.js";

// ─── Hard caps (no config override) ──────────────────────────────────────────

/**
 * Maximum size (in characters) of any single artifact persisted by
 * `lean_save_artifact`. ~200 KB of Markdown is already an enormous spec —
 * past that we refuse to save to keep `.pi-lean-flow/state.json` bounded.
 */
export const MAX_ARTIFACT_CHARS = 200_000;

/**
 * Truncation limit for each artifact injected into the system prompt at
 * `before_agent_start`. A long Action Plan can easily blow the context
 * window if pasted on every turn.
 */
export const MAX_ARTIFACT_INJECTION_CHARS = 4_000;

/** Maximum number of recent history entries injected on each turn. */
export const MAX_HISTORY_INJECTED = 10;

/**
 * Maximum number of tasks injected verbatim per turn. Above this we paste
 * a summary line ("N more hidden") so a 200-task plan doesn't blow context.
 */
export const MAX_TASKS_INJECTED = 25;

// ─── Configurable caps (with sensible defaults) ──────────────────────────────

/** Default cap on stdout returned by `lean_run_checks`. */
export const DEFAULT_MAX_CHECK_OUTPUT_CHARS = 3_000;
/** Default cap on stderr returned by `lean_run_checks`. */
export const DEFAULT_MAX_CHECK_ERROR_CHARS = 1_000;
/** Default cap on an LLM-supplied rationale before truncation. */
export const DEFAULT_MAX_RATIONALE_CHARS = 4_000;
/** Default cap on a single LLM-supplied suggestion before truncation. */
export const DEFAULT_MAX_SUGGESTION_CHARS = 500;
/** Default cap on the number of LLM-supplied suggestions retained. */
export const DEFAULT_MAX_SUGGESTIONS = 20;

export function maxCheckOutputChars(cwd: string): number {
  return (
    readConfigPositiveInt(cwd, "maxCheckOutputChars") ??
    DEFAULT_MAX_CHECK_OUTPUT_CHARS
  );
}

export function maxCheckErrorChars(cwd: string): number {
  return (
    readConfigPositiveInt(cwd, "maxCheckErrorChars") ??
    DEFAULT_MAX_CHECK_ERROR_CHARS
  );
}

export function maxRationaleChars(cwd: string): number {
  return (
    readConfigPositiveInt(cwd, "maxRationaleChars") ??
    DEFAULT_MAX_RATIONALE_CHARS
  );
}

export function maxSuggestionChars(cwd: string): number {
  return (
    readConfigPositiveInt(cwd, "maxSuggestionChars") ??
    DEFAULT_MAX_SUGGESTION_CHARS
  );
}

export function maxSuggestions(cwd: string): number {
  return (
    readConfigPositiveInt(cwd, "maxSuggestions") ?? DEFAULT_MAX_SUGGESTIONS
  );
}
