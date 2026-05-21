/**
 * project-state.ts — State management for pi-lean-flow
 *
 * Manages the progression between Lean Flow phases and persists
 * artifacts (Clarified Product, Action Plan, Review Report)
 * as a JSON file in .pi-lean-flow/state.json.
 *
 * The state file is read/written by the extension tools and commands.
 */

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { makeDebug } from "../util/debug.js";

export const STATE_VERSION = 4;

/** Maximum number of evaluations retained — older ones are dropped on save. */
export const MAX_EVALUATIONS_RETAINED = 50;

/**
 * Default maximum number of history entries retained. Without this cap, a
 * long-running project accumulates phase transitions, saves, and task
 * toggles indefinitely, bloating `.pi-lean-flow/state.json` to MBs.
 *
 * 200 covers months of normal use; the oldest entries are dropped on save.
 * Override via `.pi-lean-flow/config.json` → `maxHistoryRetained`.
 */
export const MAX_HISTORY_RETAINED = 200;

/**
 * Resolve the effective history retention cap for `cwd`, defaulting to
 * `MAX_HISTORY_RETAINED`. Reads `maxHistoryRetained` from
 * `.pi-lean-flow/config.json` if present, accepting only positive finite
 * integers (hand-edited zero / negative / NaN values are ignored).
 *
 * Inline parse to avoid an import cycle with `quality/gate.ts`.
 */
function readMaxHistoryRetained(cwd: string): number {
  try {
    const configPath = join(cwd, ".pi-lean-flow", "config.json");
    if (!existsSync(configPath)) return MAX_HISTORY_RETAINED;
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return MAX_HISTORY_RETAINED;
    }
    const v = (parsed as Record<string, unknown>).maxHistoryRetained;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return Math.floor(v);
    }
    return MAX_HISTORY_RETAINED;
  } catch {
    return MAX_HISTORY_RETAINED;
  }
}

const dbg = makeDebug("state");

// ─── Types ───────────────────────────────────────────────────────────────────

export type LeanPhase = "brainstorm" | "plan" | "implement" | "review" | "done";

/** Discriminated union of all artifact keys the workflow can produce. */
export type LeanArtifactKey =
  | "clarifiedProduct"
  | "actionPlan"
  | "reviewReport";

export const LEAN_ARTIFACT_KEYS: readonly LeanArtifactKey[] = [
  "clarifiedProduct",
  "actionPlan",
  "reviewReport",
] as const;

/**
 * Human-readable artifact names without decoration. Single source of truth —
 * `extension.ts` decorates these with emoji for the UI; `quality/gate.ts`
 * uses the raw form in reports.
 */
export const ARTIFACT_NAMES: Record<LeanArtifactKey, string> = {
  clarifiedProduct: "Clarified Product",
  actionPlan: "Action Plan",
  reviewReport: "Review Report",
};

/**
 * Single source of truth: which phase produces which artifact.
 * Used both for phase-advance on save and for picking the default artifact
 * when none is requested (e.g. `/lean-quality`).
 */
export const ARTIFACT_TO_PHASE: Record<LeanArtifactKey, LeanPhase> = {
  clarifiedProduct: "brainstorm",
  actionPlan: "plan",
  reviewReport: "review",
};

export function isLeanArtifactKey(value: unknown): value is LeanArtifactKey {
  return (
    typeof value === "string" &&
    (LEAN_ARTIFACT_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Provenance of a quality evaluation.
 *
 *   - "auto": produced by the heuristic in `quality/gate.ts` at save time.
 *   - "llm":  produced by the LLM via the `lean_evaluate_artifact` tool.
 *
 * Older states didn't track this. After the v2→v3 migration, pre-existing
 * evaluations are tagged `"llm"` because that was the only source recorded
 * before the heuristic started persisting too.
 */
export type LeanEvaluationSource = "auto" | "llm";

export interface LeanEvaluation {
  phase: LeanPhase;
  artifactType: LeanArtifactKey;
  score: number;
  rationale: string;
  suggestions: string[];
  timestamp: number;
  source: LeanEvaluationSource;
  /**
   * True when the evaluation was recorded against an artifact that wasn't
   * saved yet. Dashboards can filter these out to avoid "ghost" scores.
   * Defaults to false on save.
   */
  orphan?: boolean;
  /**
   * True when one or more of `rationale` / `suggestions` was truncated
   * because the LLM exceeded the configured caps. Lets the dashboard show a
   * "this evaluation was clipped" badge without scanning for the inline
   * ellipsis marker.
   */
  truncated?: boolean;
}

export interface LeanState {
  version: number;
  currentPhase: LeanPhase;
  artifacts: Partial<Record<LeanArtifactKey, string>>;
  evaluations: LeanEvaluation[];
  history: Array<{
    phase: LeanPhase;
    timestamp: number;
    note?: string;
  }>;
  tasks: LeanTask[];
  /** Most recently saved artifact key — used for `/lean-quality` default. */
  lastSavedArtifact: LeanArtifactKey | null;
  /**
   * Timestamp of the last time the user explicitly acknowledged a
   * state-coherence warning at `session_start`. While set, repeated warnings
   * for the same situation are suppressed until the phase changes (the ack
   * is reset whenever `currentPhase` changes).
   */
  coherenceAck: { phase: LeanPhase; timestamp: number } | null;
}

export interface LeanTask {
  id: number;
  description: string;
  acceptanceCriteria: string;
  notes?: string;
  done: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

function freshDefaultState(): LeanState {
  return {
    version: STATE_VERSION,
    currentPhase: "brainstorm",
    artifacts: {},
    evaluations: [],
    history: [],
    tasks: [],
    lastSavedArtifact: null,
    coherenceAck: null,
  };
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function getStateDir(cwd: string): string {
  return join(cwd, ".pi-lean-flow");
}

function getStateFile(cwd: string): string {
  return join(getStateDir(cwd), "state.json");
}

// ─── Schema migrations ───────────────────────────────────────────────────────

type Migrator = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Per-version migrators. `MIGRATIONS[n]` upgrades a state at version `n` to
 * version `n+1`. Each migrator MUST return an object whose `version` field
 * is `n+1`. Missing fields are merged from defaults at the end of load.
 */
const MIGRATIONS: Record<number, Migrator> = {
  // v0 → v1: no schema change between v0 and v1; just stamp the version.
  0: (raw) => ({ ...raw, version: 1 }),
  // v1 → v2: introduce `lastSavedArtifact` (null when unknown).
  1: (raw) => ({
    ...raw,
    lastSavedArtifact: raw.lastSavedArtifact ?? null,
    version: 2,
  }),
  // v2 → v3: introduce `source` on each evaluation. Pre-existing entries all
  // came from the LLM-driven `lean_evaluate_artifact` tool — the heuristic
  // didn't persist anything before v3.
  2: (raw) => {
    const evals = Array.isArray(raw.evaluations) ? raw.evaluations : [];
    return {
      ...raw,
      evaluations: evals.map((ev) => {
        if (ev && typeof ev === "object" && !("source" in ev)) {
          return { ...ev, source: "llm" };
        }
        return ev;
      }),
      version: 3,
    };
  },
  // v3 → v4: introduce `coherenceAck` (null when never acknowledged).
  3: (raw) => ({
    ...raw,
    coherenceAck: raw.coherenceAck ?? null,
    version: 4,
  }),
};

function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let state = raw;
  let version = typeof state.version === "number" ? state.version : 0;
  while (version < STATE_VERSION) {
    const migrator = MIGRATIONS[version];
    if (!migrator) {
      dbg(
        `no migrator for v${version}, stamping STATE_VERSION and bailing out`,
      );
      state = { ...state, version: STATE_VERSION };
      break;
    }
    dbg(`migrating state v${version} → v${version + 1}`);
    state = migrator(state);
    const nextVersion =
      typeof state.version === "number" ? state.version : version + 1;
    if (nextVersion <= version) {
      dbg(
        `migrator for v${version} did not bump version; forcing to v${version + 1}`,
      );
      state = { ...state, version: version + 1 };
      version += 1;
    } else {
      version = nextVersion;
    }
  }
  return state;
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

interface NodeError extends Error {
  code?: string;
}

function isNodeError(value: unknown): value is NodeError {
  return (
    value instanceof Error && typeof (value as NodeError).code === "string"
  );
}

/**
 * Load the current Lean Flow state from .pi-lean-flow/state.json.
 *
 * - Missing file → returns default state (no warning).
 * - Corrupt JSON or unreadable file → backs up the file as `state.json.corrupt-<ts>`
 *   and returns defaults, so the user can recover manually.
 * - Permission/IO errors → re-thrown so the caller can surface them.
 */
export async function loadState(cwd: string): Promise<LeanState> {
  const file = getStateFile(cwd);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      dbg("state file does not exist, using defaults");
      return freshDefaultState();
    }
    // Unexpected IO error — let the caller decide what to do.
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // Corrupt JSON: rename the broken file so it isn't silently overwritten.
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      await rename(file, backup);
      dbg(
        `state JSON corrupt (${(err as Error).message}); backed up to ${backup}`,
      );
    } catch (renameErr) {
      dbg(
        `state JSON corrupt and backup failed (${(renameErr as Error).message}); falling back to defaults`,
      );
    }
    return freshDefaultState();
  }

  const migrated = migrate(parsed);

  // Merge with defaults so any field still missing is populated safely.
  const def = freshDefaultState();
  const lastSavedArtifact = isLeanArtifactKey(migrated.lastSavedArtifact)
    ? migrated.lastSavedArtifact
    : null;

  // Sanitise evaluations: a hand-edited state.json could set score=99 or NaN.
  // Also default `source` to "llm" when missing — the migrator covers most
  // cases, but a future schema or manual edit could still slip an entry in
  // without a source.
  const rawEvaluations = Array.isArray(migrated.evaluations)
    ? (migrated.evaluations as LeanEvaluation[])
    : [];
  const evaluations: LeanEvaluation[] = rawEvaluations.map((ev) => ({
    ...ev,
    score: clampScore(ev?.score),
    source: ev?.source === "auto" || ev?.source === "llm" ? ev.source : "llm",
  }));

  // Defensive: coherenceAck must be either null or a { phase, timestamp }
  // object with a valid phase. Hand-edited state.json could otherwise inject
  // bogus values that the snooze logic in session_start would dereference.
  // `typeof x === "number"` accepts NaN and ±Infinity, so we require
  // `Number.isFinite()` too — `new Date(NaN).toLocaleString()` returns
  // "Invalid Date" and `<NaN>` comparisons break any ordering logic.
  let coherenceAck: LeanState["coherenceAck"] = null;
  if (
    migrated.coherenceAck &&
    typeof migrated.coherenceAck === "object" &&
    typeof (migrated.coherenceAck as Record<string, unknown>).phase ===
      "string" &&
    Number.isFinite(
      (migrated.coherenceAck as Record<string, unknown>).timestamp,
    )
  ) {
    const phase = (migrated.coherenceAck as { phase: string }).phase;
    if (["brainstorm", "plan", "implement", "review", "done"].includes(phase)) {
      coherenceAck = {
        phase: phase as LeanPhase,
        timestamp: (migrated.coherenceAck as { timestamp: number }).timestamp,
      };
    }
  }

  return {
    version: STATE_VERSION,
    currentPhase: (migrated.currentPhase as LeanPhase) ?? def.currentPhase,
    artifacts: (migrated.artifacts as LeanState["artifacts"]) ?? {},
    evaluations,
    history: (migrated.history as LeanState["history"]) ?? [],
    tasks: (migrated.tasks as LeanTask[]) ?? [],
    lastSavedArtifact,
    coherenceAck,
  };
}

/**
 * True when the user has already acknowledged a coherence warning for the
 * current phase. The ack auto-expires whenever the phase changes (the
 * comparison checks both fields), so a future re-entry into the same phase
 * with a coherent state will not re-warn either.
 */
export function isCoherenceAcked(state: LeanState): boolean {
  return (
    state.coherenceAck !== null &&
    state.coherenceAck.phase === state.currentPhase
  );
}

/**
 * Mutate `state` to enter `newPhase`. Centralises the side-effects that
 * accompany a phase change so callers don't have to remember them:
 *   - clears `coherenceAck` (a fresh phase has fresh coherence semantics)
 *
 * Returns the previous phase for convenience.
 */
export function transitionPhase(
  state: LeanState,
  newPhase: LeanPhase,
): LeanPhase {
  const prev = state.currentPhase;
  state.currentPhase = newPhase;
  if (prev !== newPhase) {
    state.coherenceAck = null;
  }
  return prev;
}

/**
 * Clamp a score to the integer range [1,10].
 *
 *   - Non-finite or non-numeric inputs fall back to 5.
 *   - Fractional inputs are rounded to the nearest integer (banker's-style
 *     `Math.round`). The score is exposed as an integer everywhere
 *     (status, history, JSON), so persisting `7.5` would have surfaced
 *     inconsistencies between formatted output and the stored value.
 */
export function clampScore(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 5;
  return Math.round(Math.max(1, Math.min(10, n)));
}

// ─── Write serialisation ─────────────────────────────────────────────────────

/**
 * In-memory write queue per cwd. Prevents two concurrent `saveState` calls
 * from racing on the same atomic-rename path.
 */
const writeQueues = new Map<string, Promise<void>>();

async function doSave(cwd: string, state: LeanState): Promise<void> {
  const dir = getStateDir(cwd);
  // mkdir with recursive:true is idempotent and avoids the existsSync race.
  await mkdir(dir, { recursive: true });

  // Cap evaluations to keep the file (and any future context injection) bounded.
  if (state.evaluations.length > MAX_EVALUATIONS_RETAINED) {
    const dropped = state.evaluations.length - MAX_EVALUATIONS_RETAINED;
    dbg(
      `dropping ${dropped} oldest evaluation(s) to respect MAX_EVALUATIONS_RETAINED=${MAX_EVALUATIONS_RETAINED}`,
    );
    state.evaluations = state.evaluations.slice(-MAX_EVALUATIONS_RETAINED);
  }
  // Cap history likewise. Phase progression and task toggles each push an
  // entry — unbounded growth would balloon state.json over a long session.
  // The cap is configurable: a power user with `maxHistoryRetained: 1000`
  // in config.json can keep more history if storage isn't a concern.
  const historyCap = readMaxHistoryRetained(cwd);
  if (state.history.length > historyCap) {
    const dropped = state.history.length - historyCap;
    dbg(
      `dropping ${dropped} oldest history entr(ies) to respect maxHistoryRetained=${historyCap}`,
    );
    state.history = state.history.slice(-historyCap);
  }

  const finalPath = getStateFile(cwd);
  const tmpPath = `${finalPath}.tmp`;
  const data = JSON.stringify(state, null, 2);
  await writeFile(tmpPath, data, "utf-8");
  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Save the Lean Flow state to .pi-lean-flow/state.json.
 *
 * Writes are serialised per-cwd via an in-memory queue: concurrent callers in
 * the same process can never interleave the rename step.
 *
 * Note: this only protects the *write* step. For correct read-modify-write
 * semantics, use `withState` instead.
 */
export async function saveState(cwd: string, state: LeanState): Promise<void> {
  const prev = writeQueues.get(cwd) ?? Promise.resolve();
  // Chain on the previous write, but don't propagate its failure into this one —
  // if the prior call rejected we still want to attempt this save.
  const next = prev.catch(() => undefined).then(() => doSave(cwd, state));
  writeQueues.set(
    cwd,
    next.finally(() => {
      if (writeQueues.get(cwd) === next) writeQueues.delete(cwd);
    }),
  );
  return next;
}

// ─── Atomic read-modify-write ────────────────────────────────────────────────

/**
 * Per-cwd serialisation queue for full load→mutate→save sequences. Without
 * this, two tool calls firing concurrently could each `loadState`, each
 * mutate their own copy, and the second `saveState` would overwrite the
 * first one's changes silently.
 */
const stateQueues = new Map<string, Promise<unknown>>();

/**
 * Run a mutator against the latest state and persist the result, serialised
 * per-cwd. The mutator receives the freshly-loaded state, can mutate it in
 * place (or return a new one), and its return value is passed back to the
 * caller alongside the persisted state.
 *
 * Use this for every tool that does `loadState` + mutate + `saveState`.
 */
export async function withState<T>(
  cwd: string,
  mutator: (state: LeanState) => T | Promise<T>,
): Promise<{ state: LeanState; result: T }> {
  const prev = stateQueues.get(cwd) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const state = await loadState(cwd);
      const result = await mutator(state);
      await saveState(cwd, state);
      return { state, result };
    });
  stateQueues.set(
    cwd,
    next.finally(() => {
      if (stateQueues.get(cwd) === next) stateQueues.delete(cwd);
    }),
  );
  return next;
}

/**
 * Reset the state to defaults. Ensures the state directory exists and
 * overwrites the state file with a fresh default payload.
 */
export async function resetState(cwd: string): Promise<void> {
  await saveState(cwd, freshDefaultState());
}

// ─── Phase helpers ─────────────────────────────────────────────────────────

/**
 * Suggest the next phase after completing a given phase.
 */
export function suggestNextPhase(current: LeanPhase): LeanPhase | null {
  const sequence: LeanPhase[] = [
    "brainstorm",
    "plan",
    "implement",
    "review",
    "done",
  ];
  const idx = sequence.indexOf(current);
  if (idx === -1 || idx >= sequence.length - 1) return null;
  return sequence[idx + 1];
}

/** Outcome of a task mutation, describing the phase transition (if any). */
export type PhaseTransitionReason =
  | "all-tasks-completed"
  | "task-reopened"
  | null;

export interface PhaseTransition {
  /** The phase the workflow should move to, or null to stay put. */
  nextPhase: LeanPhase | null;
  reason: PhaseTransitionReason;
}

/**
 * Pure function: decide the next phase after toggling a task.
 *
 *   - If every task is now done and we are in `implement`, advance to `review`.
 *   - If a task was just *reopened* (i.e. moved back to undone) and the
 *     workflow had already moved past implementation (review/done), drop back
 *     to `implement` so the user can resume work.
 *   - If a task is reopened while we are still in `brainstorm`/`plan`/
 *     `implement`, no transition is forced — the state is either already
 *     correct (`implement`) or inconsistent (planning phases with tasks),
 *     in which case `lean_set_phase` is the right escape hatch.
 *
 * Exported so the tool handler and the unit tests share the same logic.
 */
export function computePhaseAfterTaskToggle(
  currentPhase: LeanPhase,
  tasks: ReadonlyArray<LeanTask>,
  toggledTaskNowDone: boolean,
): PhaseTransition {
  const allDone = tasks.length > 0 && tasks.every((t) => t.done);

  if (toggledTaskNowDone && allDone && currentPhase === "implement") {
    return { nextPhase: "review", reason: "all-tasks-completed" };
  }

  if (
    !toggledTaskNowDone &&
    (currentPhase === "review" || currentPhase === "done")
  ) {
    return { nextPhase: "implement", reason: "task-reopened" };
  }

  return { nextPhase: null, reason: null };
}

/**
 * Pure function: decide the next phase after *removing* a task. The semantics
 * are deliberately different from a toggle:
 *
 *   - If the remaining task list is fully done (and non-empty) while in
 *     `implement`, the workflow can advance to `review` — the user has
 *     effectively shrunk the scope to what was already complete.
 *   - Removal never reverts phase. Even if you're in `review` and remove
 *     all tasks, the deletion is a deliberate user act — they're not
 *     "reopening" anything.
 *   - An empty task list never triggers a transition: zero tasks doesn't
 *     match the "all done" semantics of the implementation phase.
 *
 * Previously the toggle helper was called from the remove path with a
 * synthetic `toggledTaskNowDone: true`. That worked by coincidence but made
 * the semantics unclear; this dedicated function documents the intent.
 */
export function computePhaseAfterTaskRemove(
  currentPhase: LeanPhase,
  remainingTasks: ReadonlyArray<LeanTask>,
): PhaseTransition {
  const allDone =
    remainingTasks.length > 0 && remainingTasks.every((t) => t.done);
  if (allDone && currentPhase === "implement") {
    return { nextPhase: "review", reason: "all-tasks-completed" };
  }
  return { nextPhase: null, reason: null };
}

// ─── Display helpers ─────────────────────────────────────────────────────────

const PHASE_LABELS: Record<LeanPhase, string> = {
  brainstorm: "Brainstorming",
  plan: "Planning",
  implement: "Implementation",
  review: "Review",
  done: "Done",
};

export function phaseLabel(phase: LeanPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

export function formatStatus(
  state: LeanState,
  options: { stateFileBytes?: number; coherenceIssues?: string[] } = {},
): string {
  const lines: string[] = [];
  lines.push(`Current phase: ${phaseLabel(state.currentPhase)}`);
  // Coherence + ack info is best surfaced near the phase line — that's
  // where users look to understand "where am I" at a glance.
  if (options.coherenceIssues && options.coherenceIssues.length > 0) {
    const acked = isCoherenceAcked(state);
    lines.push(
      `⚠ Coherence: ${options.coherenceIssues.length} issue(s)${acked ? " — acknowledged" : " — run /lean-acknowledge to silence"}`,
    );
    for (const issue of options.coherenceIssues) {
      lines.push(`  • ${issue}`);
    }
  } else if (state.coherenceAck) {
    // Ack with no issues = stale ack. Surface it so the user knows it's
    // hanging around (it'll auto-clear on next phase change anyway).
    lines.push("ℹ Coherence: all issues resolved (ack still on file)");
  }
  lines.push("");

  // Only count keys whose value is a non-empty string. An entry can exist with
  // an empty value (e.g. after a hand-edited state.json) — that must not show
  // up as a produced artifact.
  const artifactKeys = (
    Object.keys(state.artifacts) as LeanArtifactKey[]
  ).filter((k) => Boolean(state.artifacts[k]));
  if (artifactKeys.length > 0) {
    lines.push("Artifacts produced:");
    for (const key of artifactKeys) {
      const content = state.artifacts[key];
      if (!content) continue;
      const preview = content.slice(0, 80).replace(/\n/g, " ");
      const name = ARTIFACT_NAMES[key] ?? key;
      lines.push(`  • ${name}: ${preview}...`);
    }
  } else {
    lines.push("No artifacts produced yet.");
  }

  if (state.tasks.length > 0) {
    lines.push("");
    const done = state.tasks.filter((t) => t.done).length;
    lines.push(`Tasks: ${done}/${state.tasks.length} completed`);
  }

  if (state.evaluations.length > 0) {
    lines.push("");
    lines.push("Quality Gate:");
    // Show only the latest evaluation per (artifactType, source) pair plus
    // a count of how many earlier ones were recorded. With deduplication of
    // consecutive auto-evals this is usually one auto + one llm per artifact,
    // but a long iteration session can still pile up llm self-evals.
    const groups = new Map<string, { latest: LeanEvaluation; count: number }>();
    for (const ev of state.evaluations) {
      const key = `${ev.artifactType}:${ev.source}`;
      const existing = groups.get(key);
      if (!existing || ev.timestamp >= existing.latest.timestamp) {
        groups.set(key, {
          latest: ev,
          count: (existing?.count ?? 0) + 1,
        });
      } else {
        existing.count += 1;
      }
    }
    for (const { latest, count } of groups.values()) {
      const date = new Date(latest.timestamp).toLocaleString();
      const countSuffix = count > 1 ? ` (${count} entries)` : "";
      const orphanTag = latest.orphan ? " [orphan]" : "";
      lines.push(
        `  • ${latest.artifactType}: ${latest.score}/10 (${latest.source})${orphanTag} — ${date}${countSuffix}`,
      );
    }
  }

  if (state.history.length > 0) {
    lines.push("");
    // Mirror what before_agent_start does: show the last 10 entries inline
    // and tell the user how to see the rest. A 200-entry status dump is
    // unreadable and the editor pane can scroll.
    const SHOWN = 10;
    const recent = state.history.slice(-SHOWN);
    const omitted = state.history.length - recent.length;
    lines.push(
      `Phase history${omitted > 0 ? ` (last ${recent.length} of ${state.history.length}; use /lean-history N for more)` : ""}:`,
    );
    for (const h of recent) {
      const date = new Date(h.timestamp).toLocaleString();
      lines.push(
        `  • ${phaseLabel(h.phase)} — ${date}${h.note ? ` (${h.note})` : ""}`,
      );
    }
  }

  if (
    typeof options.stateFileBytes === "number" &&
    options.stateFileBytes > 0
  ) {
    lines.push("");
    // Friendly format: KB rounded to two decimals, then MB above 1024 KB.
    // We don't bother with i18n; the unit suffix is enough.
    const kb = options.stateFileBytes / 1024;
    const formatted =
      kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(2)} KB`;
    lines.push(
      `Storage: state.json = ${formatted} (${options.stateFileBytes} bytes)`,
    );
  }

  return lines.join("\n");
}
