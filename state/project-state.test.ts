import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";

import {
  loadState,
  saveState,
  resetState,
  withState,
  clampScore,
  suggestNextPhase,
  phaseLabel,
  formatStatus,
  computePhaseAfterTaskToggle,
  computePhaseAfterTaskRemove,
  transitionPhase,
  isCoherenceAcked,
  ARTIFACT_TO_PHASE,
  STATE_VERSION,
  MAX_EVALUATIONS_RETAINED,
  MAX_HISTORY_RETAINED,
} from "./project-state.js";
import type { LeanState, LeanTask } from "./project-state.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stateDir(base: string) {
  return join(base, ".pi-lean-flow");
}

function stateFile(base: string) {
  return join(stateDir(base), "state.json");
}

async function writeRawState(base: string, content: string) {
  await mkdir(stateDir(base), { recursive: true });
  await writeFile(stateFile(base), content, "utf-8");
}

// ─── loadState ───────────────────────────────────────────────────────────────

describe("loadState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-test-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns default state when file does not exist", async () => {
    const state = await loadState(dir);
    expect(state.currentPhase).toBe("brainstorm");
    expect(state.tasks).toEqual([]);
    expect(state.artifacts).toEqual({});
    expect(state.evaluations).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.version).toBe(STATE_VERSION);
  });

  it("returns default state when JSON is corrupt", async () => {
    await writeRawState(dir, "{ invalid json }");
    const state = await loadState(dir);
    expect(state.currentPhase).toBe("brainstorm");
    expect(state.tasks).toEqual([]);
  });

  it("loads a valid saved state", async () => {
    const saved: LeanState = {
      version: STATE_VERSION,
      currentPhase: "plan",
      artifacts: { clarifiedProduct: "# Product\n## Vision\ntest" },
      evaluations: [],
      history: [{ phase: "brainstorm", timestamp: 1000, note: "done" }],
      tasks: [
        {
          id: 1,
          description: "Task one",
          acceptanceCriteria: "passes",
          done: false,
        },
      ],
      lastSavedArtifact: "clarifiedProduct",
    };
    await saveState(dir, saved);
    const loaded = await loadState(dir);
    expect(loaded.currentPhase).toBe("plan");
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0].description).toBe("Task one");
    expect(loaded.artifacts.clarifiedProduct).toContain("# Product");
    expect(loaded.history).toHaveLength(1);
  });

  it("fills missing fields from an older state (no version)", async () => {
    await writeRawState(
      dir,
      JSON.stringify({ currentPhase: "implement" }),
    );
    const state = await loadState(dir);
    expect(state.currentPhase).toBe("implement");
    expect(state.tasks).toEqual([]);
    expect(state.evaluations).toEqual([]);
    expect(state.version).toBe(STATE_VERSION);
  });

  it("stamps STATE_VERSION even when loaded from older file", async () => {
    await writeRawState(dir, JSON.stringify({ version: 0, currentPhase: "plan" }));
    const state = await loadState(dir);
    expect(state.version).toBe(STATE_VERSION);
  });

  it("populates lastSavedArtifact:null when migrating from a v1 state", async () => {
    await writeRawState(
      dir,
      JSON.stringify({ version: 1, currentPhase: "plan" }),
    );
    const state = await loadState(dir);
    expect(state.lastSavedArtifact).toBeNull();
    expect(state.version).toBe(STATE_VERSION);
  });

  it("backs up the file when JSON is corrupt instead of overwriting silently", async () => {
    await writeRawState(dir, "{ totally not json");
    const state = await loadState(dir);
    expect(state.currentPhase).toBe("brainstorm");
    // The original corrupt file should have been renamed with a `.corrupt-*` suffix.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(stateDir(dir));
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(true);
  });
});

// ─── saveState / resetState ──────────────────────────────────────────────────

describe("saveState / resetState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-test-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates state dir if it does not exist", async () => {
    const nested = join(dir, "subproject");
    await mkdir(nested);
    const state = await loadState(nested);
    state.currentPhase = "review";
    await saveState(nested, state);
    const reloaded = await loadState(nested);
    expect(reloaded.currentPhase).toBe("review");
  });

  it("persists tasks and reloads them correctly", async () => {
    const state = await loadState(dir);
    state.tasks.push({
      id: 1,
      description: "write tests",
      acceptanceCriteria: "vitest passes",
      done: true,
    });
    await saveState(dir, state);
    const reloaded = await loadState(dir);
    expect(reloaded.tasks[0].done).toBe(true);
    expect(reloaded.tasks[0].description).toBe("write tests");
  });

  it("resetState restores phase to brainstorm and empties arrays", async () => {
    const state = await loadState(dir);
    state.currentPhase = "done";
    state.tasks.push({
      id: 1,
      description: "t",
      acceptanceCriteria: "",
      done: true,
    });
    await saveState(dir, state);

    await resetState(dir);
    const reset = await loadState(dir);
    expect(reset.currentPhase).toBe("brainstorm");
    expect(reset.tasks).toEqual([]);
    expect(reset.artifacts).toEqual({});
    expect(reset.evaluations).toEqual([]);
  });

  it("resetState is safe when state file does not exist", async () => {
    await expect(resetState(dir)).resolves.not.toThrow();
  });

  it("resetState creates the state directory if it does not exist yet", async () => {
    const nested = join(dir, "fresh-subproject");
    await mkdir(nested);
    await resetState(nested);
    const reloaded = await loadState(nested);
    expect(reloaded.currentPhase).toBe("brainstorm");
    expect(reloaded.tasks).toEqual([]);
    expect(reloaded.artifacts).toEqual({});
  });

  it("serialises concurrent saves so the last value wins without truncation", async () => {
    const baseline = await loadState(dir);
    // Fire many concurrent saves with monotonically growing payloads — without
    // the write queue the atomic-rename step would race and produce truncated
    // or partially-overwritten state files.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        saveState(dir, {
          ...baseline,
          currentPhase: "implement",
          history: [
            ...baseline.history,
            { phase: "implement", timestamp: i, note: `iter-${i}` },
          ],
        }),
      ),
    );
    const reloaded = await loadState(dir);
    expect(reloaded.currentPhase).toBe("implement");
    expect(reloaded.history.length).toBeGreaterThan(0);
    // The file must remain valid JSON regardless of which write won the race.
    expect(reloaded.history[reloaded.history.length - 1].note).toMatch(
      /^iter-\d+$/,
    );
  });

  it("caps history to MAX_HISTORY_RETAINED on save", async () => {
    const state = await loadState(dir);
    for (let i = 0; i < MAX_HISTORY_RETAINED + 25; i++) {
      state.history.push({
        phase: "implement",
        timestamp: i,
        note: `hist-${i}`,
      });
    }
    await saveState(dir, state);
    const reloaded = await loadState(dir);
    expect(reloaded.history.length).toBe(MAX_HISTORY_RETAINED);
    // Newest entries survive; oldest get dropped.
    expect(reloaded.history[reloaded.history.length - 1].note).toBe(
      `hist-${MAX_HISTORY_RETAINED + 24}`,
    );
  });

  it("honors maxHistoryRetained override from config.json", async () => {
    // Power user wants a 5-entry history (e.g. for a noisy debug project).
    // Verify the cap kicks in at the configured value, not the default.
    await mkdir(join(dir, ".pi-lean-flow"), { recursive: true });
    await writeFile(
      join(dir, ".pi-lean-flow", "config.json"),
      JSON.stringify({ maxHistoryRetained: 5 }),
      "utf-8",
    );
    const state = await loadState(dir);
    for (let i = 0; i < 12; i++) {
      state.history.push({
        phase: "implement",
        timestamp: i,
        note: `h-${i}`,
      });
    }
    await saveState(dir, state);
    const reloaded = await loadState(dir);
    expect(reloaded.history.length).toBe(5);
    expect(reloaded.history[reloaded.history.length - 1].note).toBe("h-11");
  });

  it("ignores invalid maxHistoryRetained values", async () => {
    // Hand-edited config with garbage: parser must fall back to the default.
    await mkdir(join(dir, ".pi-lean-flow"), { recursive: true });
    await writeFile(
      join(dir, ".pi-lean-flow", "config.json"),
      JSON.stringify({ maxHistoryRetained: -1 }),
      "utf-8",
    );
    const state = await loadState(dir);
    for (let i = 0; i < MAX_HISTORY_RETAINED + 5; i++) {
      state.history.push({
        phase: "implement",
        timestamp: i,
        note: `h-${i}`,
      });
    }
    await saveState(dir, state);
    const reloaded = await loadState(dir);
    expect(reloaded.history.length).toBe(MAX_HISTORY_RETAINED);
  });

  it("caps evaluations to MAX_EVALUATIONS_RETAINED on save", async () => {
    const state = await loadState(dir);
    for (let i = 0; i < MAX_EVALUATIONS_RETAINED + 25; i++) {
      state.evaluations.push({
        phase: "plan",
        artifactType: "actionPlan",
        score: 5,
        rationale: `r-${i}`,
        suggestions: [],
        timestamp: i,
      });
    }
    await saveState(dir, state);
    const reloaded = await loadState(dir);
    expect(reloaded.evaluations.length).toBe(MAX_EVALUATIONS_RETAINED);
    // The newest evaluations must survive — the oldest get dropped.
    expect(reloaded.evaluations[reloaded.evaluations.length - 1].rationale)
      .toBe(`r-${MAX_EVALUATIONS_RETAINED + 24}`);
  });
});

// ─── suggestNextPhase ─────────────────────────────────────────────────────────

describe("suggestNextPhase", () => {
  it("returns the correct next phase for each step", () => {
    expect(suggestNextPhase("brainstorm")).toBe("plan");
    expect(suggestNextPhase("plan")).toBe("implement");
    expect(suggestNextPhase("implement")).toBe("review");
    expect(suggestNextPhase("review")).toBe("done");
  });

  it("returns null when already at the last phase", () => {
    expect(suggestNextPhase("done")).toBeNull();
  });
});

// ─── phaseLabel ──────────────────────────────────────────────────────────────

// ─── computePhaseAfterTaskToggle ─────────────────────────────────────────────

describe("computePhaseAfterTaskToggle", () => {
  const task = (id: number, done: boolean): LeanTask => ({
    id,
    description: `t${id}`,
    acceptanceCriteria: "",
    done,
  });

  it("advances from implement to review when the last task is completed", () => {
    const tasks = [task(1, true), task(2, true)];
    const t = computePhaseAfterTaskToggle("implement", tasks, true);
    expect(t.nextPhase).toBe("review");
    expect(t.reason).toBe("all-tasks-completed");
  });

  it("does not advance to review when not all tasks are done", () => {
    const tasks = [task(1, true), task(2, false)];
    const t = computePhaseAfterTaskToggle("implement", tasks, true);
    expect(t.nextPhase).toBeNull();
    expect(t.reason).toBeNull();
  });

  it("does not advance to review when phase is not implement", () => {
    const tasks = [task(1, true)];
    expect(computePhaseAfterTaskToggle("plan", tasks, true).nextPhase).toBeNull();
    expect(
      computePhaseAfterTaskToggle("brainstorm", tasks, true).nextPhase,
    ).toBeNull();
  });

  it("reverts to implement when a task is reopened from review", () => {
    const tasks = [task(1, false), task(2, true)];
    const t = computePhaseAfterTaskToggle("review", tasks, false);
    expect(t.nextPhase).toBe("implement");
    expect(t.reason).toBe("task-reopened");
  });

  it("reverts to implement when a task is reopened from done", () => {
    const tasks = [task(1, false)];
    const t = computePhaseAfterTaskToggle("done", tasks, false);
    expect(t.nextPhase).toBe("implement");
    expect(t.reason).toBe("task-reopened");
  });

  it("does not revert when reopening a task while already in implement", () => {
    const tasks = [task(1, false)];
    const t = computePhaseAfterTaskToggle("implement", tasks, false);
    expect(t.nextPhase).toBeNull();
    expect(t.reason).toBeNull();
  });

  it("does not revert when reopening a task during brainstorm/plan (no forced move)", () => {
    const tasks = [task(1, false)];
    expect(
      computePhaseAfterTaskToggle("brainstorm", tasks, false).nextPhase,
    ).toBeNull();
    expect(computePhaseAfterTaskToggle("plan", tasks, false).nextPhase).toBeNull();
  });

  it("returns no transition when there are zero tasks", () => {
    expect(computePhaseAfterTaskToggle("implement", [], true).nextPhase).toBeNull();
  });
});

// ─── computePhaseAfterTaskRemove ─────────────────────────────────────────────

describe("computePhaseAfterTaskRemove", () => {
  const task = (id: number, done: boolean): LeanTask => ({
    id,
    description: `t${id}`,
    acceptanceCriteria: "",
    done,
  });

  it("advances from implement to review when removing leaves only done tasks", () => {
    const remaining = [task(1, true), task(2, true)];
    const t = computePhaseAfterTaskRemove("implement", remaining);
    expect(t.nextPhase).toBe("review");
    expect(t.reason).toBe("all-tasks-completed");
  });

  it("does not advance when remaining tasks still have pending ones", () => {
    const remaining = [task(1, true), task(2, false)];
    const t = computePhaseAfterTaskRemove("implement", remaining);
    expect(t.nextPhase).toBeNull();
  });

  it("never advances from non-implement phases", () => {
    const remaining = [task(1, true)];
    expect(computePhaseAfterTaskRemove("plan", remaining).nextPhase).toBeNull();
    expect(
      computePhaseAfterTaskRemove("brainstorm", remaining).nextPhase,
    ).toBeNull();
    expect(computePhaseAfterTaskRemove("review", remaining).nextPhase).toBeNull();
    expect(computePhaseAfterTaskRemove("done", remaining).nextPhase).toBeNull();
  });

  it("never reverts phase (unlike toggle)", () => {
    // Toggle reverts when undoing a task in review/done. Remove never does:
    // deleting a task is a deliberate user action, not a "reopen".
    const remaining = [task(1, false)];
    expect(computePhaseAfterTaskRemove("review", remaining).nextPhase).toBeNull();
    expect(computePhaseAfterTaskRemove("done", remaining).nextPhase).toBeNull();
  });

  it("does not advance when the task list becomes empty", () => {
    // Removing the only task: zero-task implement is not "all done", it's
    // "no work defined". Leave the user in implement so they can plan.
    expect(computePhaseAfterTaskRemove("implement", []).nextPhase).toBeNull();
  });
});

describe("phaseLabel", () => {
  it("returns a non-empty label for every known phase", () => {
    const phases = ["brainstorm", "plan", "implement", "review", "done"] as const;
    for (const phase of phases) {
      expect(phaseLabel(phase).length).toBeGreaterThan(0);
    }
  });

  it("contains a recognisable keyword", () => {
    expect(phaseLabel("brainstorm")).toMatch(/brainstorm/i);
    expect(phaseLabel("done")).toMatch(/done/i);
  });
});

// ─── formatStatus ─────────────────────────────────────────────────────────────

// ─── withState (atomic read-modify-write) ────────────────────────────────────

describe("withState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-test-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the mutator result alongside the persisted state", async () => {
    const { state, result } = await withState(dir, (s) => {
      s.currentPhase = "plan";
      return 42;
    });
    expect(result).toBe(42);
    expect(state.currentPhase).toBe("plan");
    const reloaded = await loadState(dir);
    expect(reloaded.currentPhase).toBe("plan");
  });

  it("serialises concurrent read-modify-write so no mutation is lost", async () => {
    // Without serialisation, two concurrent withState calls would each load
    // the same snapshot and one would overwrite the other's task. With the
    // queue, both task additions must end up in the file.
    await Promise.all([
      withState(dir, (s) => {
        s.tasks.push({
          id: 1,
          description: "from-a",
          acceptanceCriteria: "",
          done: false,
        });
      }),
      withState(dir, (s) => {
        const next = s.tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
        s.tasks.push({
          id: next,
          description: "from-b",
          acceptanceCriteria: "",
          done: false,
        });
      }),
    ]);
    const reloaded = await loadState(dir);
    expect(reloaded.tasks).toHaveLength(2);
    const descriptions = reloaded.tasks.map((t) => t.description).sort();
    expect(descriptions).toEqual(["from-a", "from-b"]);
  });

  it("still honors mutations made after a previous withState rejected", async () => {
    await expect(
      withState(dir, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { state } = await withState(dir, (s) => {
      s.currentPhase = "review";
    });
    expect(state.currentPhase).toBe("review");
  });
});

// ─── clampScore ──────────────────────────────────────────────────────────────

describe("clampScore", () => {
  it("clamps values into the [1,10] range", () => {
    expect(clampScore(-5)).toBe(1);
    expect(clampScore(0)).toBe(1);
    expect(clampScore(1)).toBe(1);
    expect(clampScore(5)).toBe(5);
    expect(clampScore(10)).toBe(10);
    expect(clampScore(11)).toBe(10);
    expect(clampScore(100)).toBe(10);
  });

  it("falls back to 5 for non-finite or non-numeric values", () => {
    // Number.isFinite rejects ±Infinity and NaN, so they all collapse to the
    // 5 baseline. Strings, undefined, null follow the same path.
    expect(clampScore(NaN)).toBe(5);
    expect(clampScore(Infinity)).toBe(5);
    expect(clampScore(-Infinity)).toBe(5);
    expect(clampScore("9")).toBe(5);
    expect(clampScore(undefined)).toBe(5);
    expect(clampScore(null)).toBe(5);
  });

  it("rounds fractional inputs to the nearest integer", () => {
    expect(clampScore(7.5)).toBe(8);
    expect(clampScore(7.49)).toBe(7);
    expect(clampScore(1.4)).toBe(1);
    expect(clampScore(10.6)).toBe(10); // clamped THEN rounded
    expect(clampScore(0.4)).toBe(1);   // clamped to 1
  });
});

// ─── LeanEvaluation.truncated + orphan persistence ──────────────────────────

describe("loadState — evaluation flags", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-test-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loadState alone does not create state.json (dry-run contract)", async () => {
    // The `--dry-run` slash variants must rely on `loadState` only — never
    // `saveState`/`withState`. This test pins the contract that loadState
    // doesn't have a write-on-read side effect, so a slash command that
    // sticks to it can never accidentally mutate state.
    const before = await loadState(dir);
    expect(before.currentPhase).toBe("brainstorm");
    // The state file must NOT exist on disk yet.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, ".pi-lean-flow", "state.json"))).toBe(false);

    // A second loadState is still pure.
    await loadState(dir);
    expect(existsSync(join(dir, ".pi-lean-flow", "state.json"))).toBe(false);
  });

  it("round-trips orphan and truncated flags through save/load", async () => {
    const state = await loadState(dir);
    state.evaluations.push({
      phase: "plan",
      artifactType: "actionPlan",
      score: 7,
      rationale: "long…[truncated]",
      suggestions: [],
      timestamp: 1,
      source: "llm",
      orphan: true,
      truncated: true,
    });
    await saveState(dir, state);
    const reloaded = await loadState(dir);
    expect(reloaded.evaluations[0].orphan).toBe(true);
    expect(reloaded.evaluations[0].truncated).toBe(true);
  });
});

// ─── ARTIFACT_TO_PHASE ───────────────────────────────────────────────────────

describe("ARTIFACT_TO_PHASE", () => {
  it("covers every artifact key with its producing phase", () => {
    expect(ARTIFACT_TO_PHASE.clarifiedProduct).toBe("brainstorm");
    expect(ARTIFACT_TO_PHASE.actionPlan).toBe("plan");
    expect(ARTIFACT_TO_PHASE.reviewReport).toBe("review");
  });
});

// ─── loadState: evaluations sanitised ────────────────────────────────────────

describe("loadState — evaluation sanitisation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-test-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back source='llm' when hand-edited to an arbitrary string", async () => {
    await writeRawState(
      dir,
      JSON.stringify({
        version: STATE_VERSION,
        currentPhase: "plan",
        artifacts: {},
        history: [],
        tasks: [],
        lastSavedArtifact: null,
        evaluations: [
          {
            phase: "plan",
            artifactType: "actionPlan",
            score: 5,
            rationale: "r",
            suggestions: [],
            timestamp: 1,
            source: "unknown-tool",
          },
          {
            phase: "plan",
            artifactType: "actionPlan",
            score: 5,
            rationale: "r",
            suggestions: [],
            timestamp: 2,
            source: "auto",
          },
        ],
      }),
    );
    const state = await loadState(dir);
    expect(state.evaluations[0].source).toBe("llm");
    expect(state.evaluations[1].source).toBe("auto");
  });

  it("clamps hand-edited out-of-range evaluation scores into [1,10]", async () => {
    await writeRawState(
      dir,
      JSON.stringify({
        version: STATE_VERSION,
        currentPhase: "review",
        artifacts: {},
        history: [],
        tasks: [],
        lastSavedArtifact: null,
        evaluations: [
          {
            phase: "plan",
            artifactType: "actionPlan",
            score: 99,
            rationale: "tampered",
            suggestions: [],
            timestamp: 1,
          },
          {
            phase: "plan",
            artifactType: "actionPlan",
            score: -3,
            rationale: "tampered",
            suggestions: [],
            timestamp: 2,
          },
        ],
      }),
    );
    const state = await loadState(dir);
    expect(state.evaluations).toHaveLength(2);
    expect(state.evaluations[0].score).toBe(10);
    expect(state.evaluations[1].score).toBe(1);
  });
});

// ─── Migration: explicit version bump ────────────────────────────────────────

describe("migration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-test-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("explicitly bumps version through every step (v0 → current)", async () => {
    await writeRawState(
      dir,
      JSON.stringify({ version: 0, currentPhase: "implement" }),
    );
    const state = await loadState(dir);
    expect(state.version).toBe(STATE_VERSION);
    expect(state.lastSavedArtifact).toBeNull();
    expect(state.currentPhase).toBe("implement");
    expect(state.coherenceAck).toBeNull();
  });

  it("v3 → v4: backfills coherenceAck=null", async () => {
    await writeRawState(
      dir,
      JSON.stringify({
        version: 3,
        currentPhase: "plan",
        artifacts: {},
        history: [],
        tasks: [],
        lastSavedArtifact: null,
        evaluations: [],
      }),
    );
    const state = await loadState(dir);
    expect(state.version).toBe(STATE_VERSION);
    expect(state.coherenceAck).toBeNull();
  });

  it("loadState sanitises bogus coherenceAck shape to null", async () => {
    await writeRawState(
      dir,
      JSON.stringify({
        version: STATE_VERSION,
        currentPhase: "plan",
        artifacts: {},
        history: [],
        tasks: [],
        lastSavedArtifact: null,
        evaluations: [],
        coherenceAck: { phase: "not-a-phase", timestamp: 123 },
      }),
    );
    const state = await loadState(dir);
    expect(state.coherenceAck).toBeNull();
  });

  it("loadState preserves a valid coherenceAck round-trip", async () => {
    await writeRawState(
      dir,
      JSON.stringify({
        version: STATE_VERSION,
        currentPhase: "implement",
        artifacts: {},
        history: [],
        tasks: [],
        lastSavedArtifact: null,
        evaluations: [],
        coherenceAck: { phase: "implement", timestamp: 42 },
      }),
    );
    const state = await loadState(dir);
    expect(state.coherenceAck).toEqual({ phase: "implement", timestamp: 42 });
  });

  it("loadState rejects coherenceAck with non-numeric timestamp", async () => {
    // Hand-edited file with a string timestamp. The old guard accepted
    // `typeof === "number"`; the Number.isFinite tightening here also
    // covers what was the typical hand-edit mistake.
    await writeRawState(
      dir,
      JSON.stringify({
        version: STATE_VERSION,
        currentPhase: "plan",
        artifacts: {},
        history: [],
        tasks: [],
        lastSavedArtifact: null,
        evaluations: [],
        coherenceAck: { phase: "plan", timestamp: "not a number" },
      }),
    );
    const state = await loadState(dir);
    expect(state.coherenceAck).toBeNull();
  });
});

// ─── transitionPhase ────────────────────────────────────────────────────────

describe("transitionPhase", () => {
  it("changes phase and returns the previous one", () => {
    const s: any = {
      version: STATE_VERSION,
      currentPhase: "brainstorm",
      artifacts: {},
      evaluations: [],
      history: [],
      tasks: [],
      lastSavedArtifact: null,
      coherenceAck: null,
    };
    const prev = transitionPhase(s, "plan");
    expect(prev).toBe("brainstorm");
    expect(s.currentPhase).toBe("plan");
  });

  it("clears coherenceAck on phase change", () => {
    const s: any = {
      version: STATE_VERSION,
      currentPhase: "implement",
      artifacts: {},
      evaluations: [],
      history: [],
      tasks: [],
      lastSavedArtifact: null,
      coherenceAck: { phase: "implement", timestamp: 1 },
    };
    transitionPhase(s, "review");
    expect(s.coherenceAck).toBeNull();
  });

  it("preserves coherenceAck on no-op (same phase)", () => {
    const ack = { phase: "implement" as const, timestamp: 1 };
    const s: any = {
      version: STATE_VERSION,
      currentPhase: "implement",
      artifacts: {},
      evaluations: [],
      history: [],
      tasks: [],
      lastSavedArtifact: null,
      coherenceAck: ack,
    };
    transitionPhase(s, "implement");
    expect(s.coherenceAck).toBe(ack);
  });
});

// ─── isCoherenceAcked ───────────────────────────────────────────────────────

describe("isCoherenceAcked", () => {
  it("returns false when ack is null", () => {
    const s: any = {
      currentPhase: "plan",
      coherenceAck: null,
    };
    expect(isCoherenceAcked(s)).toBe(false);
  });

  it("returns true only when ack.phase matches currentPhase", () => {
    const s: any = {
      currentPhase: "plan",
      coherenceAck: { phase: "plan", timestamp: 1 },
    };
    expect(isCoherenceAcked(s)).toBe(true);
  });

  it("returns false when ack is for a different phase", () => {
    const s: any = {
      currentPhase: "review",
      coherenceAck: { phase: "implement", timestamp: 1 },
    };
    expect(isCoherenceAcked(s)).toBe(false);
  });
});

// ─── Migration: explicit version bump (extra cases) ─────────────────────────

describe("migration: source backfill", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-test-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("v2 → v3: tags pre-existing evaluations as source 'llm'", async () => {
    // A v2 state has evaluations without a `source` field. The migrator must
    // backfill them with "llm" — only the LLM tool persisted evaluations
    // before v3.
    await writeRawState(
      dir,
      JSON.stringify({
        version: 2,
        currentPhase: "plan",
        artifacts: {},
        history: [],
        tasks: [],
        lastSavedArtifact: null,
        evaluations: [
          {
            phase: "brainstorm",
            artifactType: "clarifiedProduct",
            score: 8,
            rationale: "good",
            suggestions: [],
            timestamp: 1,
          },
        ],
      }),
    );
    const state = await loadState(dir);
    expect(state.version).toBe(STATE_VERSION);
    expect(state.evaluations).toHaveLength(1);
    expect(state.evaluations[0].source).toBe("llm");
  });

  it("loadState defaults missing source to 'llm' even past migration", async () => {
    // Even on a v3+ file, a hand-edited entry without source must default.
    await writeRawState(
      dir,
      JSON.stringify({
        version: STATE_VERSION,
        currentPhase: "review",
        artifacts: {},
        history: [],
        tasks: [],
        lastSavedArtifact: null,
        evaluations: [
          {
            phase: "plan",
            artifactType: "actionPlan",
            score: 7,
            rationale: "ok",
            suggestions: [],
            timestamp: 2,
          },
        ],
      }),
    );
    const state = await loadState(dir);
    expect(state.evaluations[0].source).toBe("llm");
  });
});

describe("formatStatus", () => {
  it("shows current phase", () => {
    const state: LeanState = {
      version: STATE_VERSION,
      currentPhase: "implement",
      artifacts: {},
      evaluations: [],
      history: [],
      tasks: [],
      lastSavedArtifact: null,
    };
    const output = formatStatus(state);
    expect(output).toContain("Implementation");
  });

  it("shows task progress when tasks are present", () => {
    const state: LeanState = {
      version: STATE_VERSION,
      currentPhase: "implement",
      artifacts: {},
      evaluations: [],
      history: [],
      tasks: [
        { id: 1, description: "t1", acceptanceCriteria: "", done: true },
        { id: 2, description: "t2", acceptanceCriteria: "", done: false },
      ],
      lastSavedArtifact: null,
    };
    const output = formatStatus(state);
    expect(output).toContain("1/2");
  });

  it("ignores artifact keys with empty/undefined content", () => {
    // Hand-edited state.json could leave `artifacts.actionPlan = ""`. The
    // status block must not print a "Artifacts produced:" header for that.
    const state: LeanState = {
      version: STATE_VERSION,
      currentPhase: "plan",
      artifacts: { actionPlan: "" },
      evaluations: [],
      history: [],
      tasks: [],
      lastSavedArtifact: null,
    };
    const output = formatStatus(state);
    expect(output).toContain("No artifacts produced yet.");
    expect(output).not.toContain("Action Plan:");
  });

  it("shows quality evaluations when present", () => {
    const state: LeanState = {
      version: STATE_VERSION,
      currentPhase: "review",
      artifacts: {},
      evaluations: [
        {
          phase: "plan",
          artifactType: "actionPlan",
          score: 8,
          rationale: "solid",
          suggestions: [],
          timestamp: Date.now(),
        },
      ],
      history: [],
      tasks: [],
      lastSavedArtifact: null,
    };
    const output = formatStatus(state);
    expect(output).toContain("actionPlan");
    expect(output).toContain("8/10");
  });
});
