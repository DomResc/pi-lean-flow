# State reference — `.pi-lean-flow/state.json`

This document is the on-disk contract for pi-lean-flow's state file. It
exists so contributors (and CI tooling) can reason about the schema
without reading the TypeScript types.

The state file is **versioned** (`STATE_VERSION` in
[`state/project-state.ts`](state/project-state.ts)). Older versions are
upgraded in-place on load — see [AGENTS.md → State Migrations](AGENTS.md)
for the contract that contributors must follow.

## Top-level shape

```jsonc
{
  // Schema version. Migrators in MIGRATIONS upgrade older states.
  "version": 4,

  // Workflow phase the user is currently in.
  // One of: "brainstorm" | "plan" | "implement" | "review" | "done".
  "currentPhase": "implement",

  // Markdown bodies of the three workflow artifacts. Keys are optional;
  // missing keys mean "not produced yet". An empty string is treated as
  // "missing" by the dashboard and refused by lean_save_artifact.
  "artifacts": {
    "clarifiedProduct": "# Clarified Product: …\n\n## Vision\n…",
    "actionPlan":      "# Action Plan: …\n\n## Tasks\n…",
    "reviewReport":    "# Review Report: …"
  },

  // Quality-gate evaluations. The newest entry is the last in the array.
  // Older entries beyond MAX_EVALUATIONS_RETAINED (50) are dropped on save.
  "evaluations": [
    {
      "phase": "plan",
      "artifactType": "actionPlan",
      "score": 8,                   // integer in [1, 10]
      "rationale": "Solid plan; …",
      "suggestions": ["…"],
      "timestamp": 1734567890123,
      "source": "auto",             // "auto" (heuristic) or "llm" (self-eval)
      "orphan": false               // true if no saved artifact at time of eval
    }
  ],

  // Tasks for the implement phase. IDs are monotonically increasing and
  // never reused.
  "tasks": [
    {
      "id": 1,
      "description": "Wire the …",
      "acceptanceCriteria": "…",
      "notes": "…",
      "done": true
    }
  ],

  // Phase / save / task history. Capped at MAX_HISTORY_RETAINED (200).
  "history": [
    {
      "phase": "plan",
      "timestamp": 1734567000000,
      "note": "Saved actionPlan → transition plan → implement"
    }
  ],

  // The most recently saved artifact key. Used by /lean-quality as the
  // default target and by lean-import for post-import phase hints.
  // `null` when nothing has been saved yet (or the state was reset).
  "lastSavedArtifact": "actionPlan",

  // User acknowledgement of session-start coherence warnings. Set by
  // /lean-acknowledge. Cleared automatically by transitionPhase() so it
  // self-expires on the next phase change. `null` when never set.
  "coherenceAck": {
    "phase": "implement",
    "timestamp": 1734567890123
  }
}
```

## Sibling files

These live next to `state.json` under `.pi-lean-flow/`:

- **`audit.log`** — JSON-Lines record of every `lean_run_checks` invocation
  (check type, resolved command, status, duration, exit code). Rotated to
  `audit.log.1` when over `MAX_AUDIT_BYTES` (default 1 MB; configurable
  via `config.json` → `maxAuditBytes`). Secret-bearing patterns are
  redacted to `***` at write time.
- **`audit.log.1`** — previous rotation (overwritten on the next
  rotation; at most two generations are kept).
- **`exports/`** — created by `/lean-export`; holds one Markdown file per
  saved artifact plus a `state.json` snapshot. Atomic writes via temp +
  rename.
- **`config.json`** — optional, user-editable project overrides:
  ```jsonc
  {
    "checks":   { "test": "pnpm test --silent" },
    "timeouts": { "test": 300000 },
    "timeoutMs":   120000,
    "maxAuditBytes":       5000000,
    "maxCheckOutputChars": 8000,
    "maxCheckErrorChars":  2000
  }
  ```

## Defaults & caps (defined in code)

| Constant                    | Default     | Configurable via              |
|-----------------------------|-------------|-------------------------------|
| `STATE_VERSION`             | `4`         | — (bumped by migrations)      |
| `MAX_EVALUATIONS_RETAINED`  | `50`        | —                             |
| `MAX_HISTORY_RETAINED`      | `200`       | `maxHistoryRetained`          |
| `MAX_ARTIFACT_CHARS`        | `200_000`   | —                             |
| `MAX_RATIONALE_CHARS`       | `4_000`     | —                             |
| `MAX_SUGGESTIONS`           | `20`        | —                             |
| `MAX_SUGGESTION_CHARS`      | `500`       | —                             |
| `MAX_TASKS_INJECTED`        | `25`        | — (per-turn context cap)      |
| `MAX_HISTORY_INJECTED`      | `10`        | — (per-turn context cap)      |
| `MAX_ARTIFACT_INJECTION_CHARS` | `4_000`  | — (per-turn context cap)      |
| `MAX_CHECK_OUTPUT_CHARS`    | `3_000`     | `maxCheckOutputChars`         |
| `MAX_CHECK_ERROR_CHARS`     | `1_000`     | `maxCheckErrorChars`          |
| `MAX_AUDIT_BYTES`           | `1_000_000` | `maxAuditBytes`               |
| `DEFAULT_CHECK_TIMEOUT_MS`  | `60_000`    | `timeoutMs` / `timeouts[*]`   |

## Hand-editing the file

`state.json` is treated as untrusted input. `loadState` defensively
sanitises every field it reads:

- Unknown / out-of-range `evaluations[*].score` → clamped to `[1, 10]`
  and rounded to integer.
- Bogus `coherenceAck` shape (non-finite timestamp, non-canonical
  phase) → reset to `null`.
- Missing `evaluations[*].source` → defaulted to `"llm"`.
- Corrupt JSON → file renamed `state.json.corrupt-<timestamp>` and a
  fresh default state is returned.

Use `/lean-status --json` to inspect the file's structure as the
extension sees it.
