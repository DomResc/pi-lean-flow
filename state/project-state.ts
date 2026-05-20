/**
 * project-state.ts — State management for pi-lean-flow
 *
 * Manages the progression between Lean Flow phases and persists
 * artifacts (Clarified Product, Action Plan, Review Report)
 * as a JSON file in .pi-lean-flow/state.json.
 *
 * The state file is read/written by the extension tools and commands.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type LeanPhase = "brainstorm" | "plan" | "implement" | "review" | "done";

export interface LeanEvaluation {
  phase: LeanPhase;
  artifactType: string;
  score: number;
  rationale: string;
  suggestions: string[];
  timestamp: number;
}

export interface LeanState {
  currentPhase: LeanPhase;
  artifacts: Record<string, string>;
  evaluations: LeanEvaluation[];
  history: Array<{
    phase: LeanPhase;
    timestamp: number;
    note?: string;
  }>;
  tasks: LeanTask[];
}

export interface LeanTask {
  id: number;
  description: string;
  acceptanceCriteria: string;
  notes?: string;
  done: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_STATE: LeanState = {
  currentPhase: "brainstorm",
  artifacts: {},
  evaluations: [],
  history: [],
  tasks: [],
};

// ─── Path helpers ────────────────────────────────────────────────────────────

function getStateDir(cwd: string): string {
  return join(cwd, ".pi-lean-flow");
}

function getStateFile(cwd: string): string {
  return join(getStateDir(cwd), "state.json");
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

/**
 * Load the current Lean Flow state from .pi-lean-flow/state.json.
 * Returns the default state if the file doesn't exist or is corrupt.
 */
export async function loadState(cwd: string): Promise<LeanState> {
  const file = getStateFile(cwd);
  try {
    const raw = await readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LeanState>;

    // Merge with defaults to handle missing fields gracefully
    return {
      currentPhase: parsed.currentPhase ?? DEFAULT_STATE.currentPhase,
      artifacts: parsed.artifacts ?? {},
      evaluations: parsed.evaluations ?? [],
      history: parsed.history ?? [],
      tasks: parsed.tasks ?? [],
    };
  } catch {
    return { ...DEFAULT_STATE, artifacts: {}, history: [], tasks: [] };
  }
}

/**
 * Save the Lean Flow state to .pi-lean-flow/state.json.
 * Creates the directory if needed.
 */
export async function saveState(cwd: string, state: LeanState): Promise<void> {
  const dir = getStateDir(cwd);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(getStateFile(cwd), JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Reset the state to defaults by deleting the state file.
 */
export async function resetState(cwd: string): Promise<void> {
  const file = getStateFile(cwd);
  try {
    await writeFile(file, JSON.stringify(DEFAULT_STATE, null, 2), "utf-8");
  } catch {
    // File may not exist, that's fine
  }
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

// ─── Display helpers ─────────────────────────────────────────────────────────

const PHASE_LABELS: Record<LeanPhase, string> = {
  brainstorm: "🧠 Brainstorming",
  plan: "📋 Planning",
  implement: "💻 Implementation",
  review: "🔍 Review",
  done: "✅ Done",
};

export function phaseLabel(phase: LeanPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

export function formatStatus(state: LeanState): string {
  const lines: string[] = [];
  lines.push(`Current phase: ${phaseLabel(state.currentPhase)}`);
  lines.push("");

  const artifactKeys = Object.keys(state.artifacts);
  if (artifactKeys.length > 0) {
    lines.push("Artifacts produced:");
    for (const key of artifactKeys) {
      const preview = state.artifacts[key].slice(0, 80).replace(/\n/g, " ");
      lines.push(`  • ${key}: ${preview}...`);
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
    for (const ev of state.evaluations) {
      const date = new Date(ev.timestamp).toLocaleString();
      lines.push(`  • ${ev.artifactType}: ${ev.score}/10 — ${date}`);
    }
  }

  if (state.history.length > 0) {
    lines.push("");
    lines.push("Phase history:");
    for (const h of state.history) {
      const date = new Date(h.timestamp).toLocaleString();
      lines.push(
        `  • ${phaseLabel(h.phase)} — ${date}${h.note ? ` (${h.note})` : ""}`,
      );
    }
  }

  return lines.join("\n");
}
