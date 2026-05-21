# pi-lean-flow

A [pi.dev](https://pi.dev) extension that implements a minimal 4-phase
agile workflow using a single agent that switches "hats"
(Product Owner, Architect, Developer, Reviewer).

Inspired by the BMAD-METHOD but reduced to the essentials: installable with a single command,
composable with other skills, no complex sub-agents.

## Vision and Principles

| Principle | Description |
|---|---|
| **Methodological minimalism** | Only 4 essential phases, not a monolithic process |
| **Single agent, multiple roles** | The LLM switches perspective depending on the phase |
| **Modularity and composability** | Each phase is an independent skill, invocable individually |
| **Guided but flexible state** | Progression between phases is tracked but not forced |
| **Zero-friction installation** | `pi install git:github.com/DomResc/pi-lean-flow` |

## Installation

```bash
# From npm (when published)
pi install npm:pi-lean-flow

# Or from a git repository
pi install git:github.com/DomResc/pi-lean-flow

# For development, from a local folder
pi install ./pi-lean-flow
```

## Quick Start

1. Open pi.dev in a project directory
2. Start the **Brainstorming** phase:
   ```
   /skill:lean-brainstorm
   ```
3. Follow the conversation with the agent (acting as Product Owner)
4. When done, move to the next phase:
   ```
   /skill:lean-plan
   ```
5. Implement the tasks:
   ```
   /skill:lean-implement
   ```
6. Close the loop with the review:
   ```
   /skill:lean-review
   ```

## Commands

| Command | Description |
|---------|-------------|
| `/skill:lean-brainstorm` | Start Brainstorming phase (hat: Product Owner) |
| `/skill:lean-plan` | Start Planning phase (hat: Architect) |
| `/skill:lean-implement` | Start Implementation phase (hat: Developer) |
| `/skill:lean-review` | Start Review phase (hat: Reviewer) |
| `/lean-status [--json]` | Show current phase and produced artifacts. `--json` emits a machine-readable summary (incl. coherence issues, orphan eval list, state file size). |
| `/lean-reset` | Reset all state (phase, artifacts, tasks) |
| `/lean-quality` | Generate quality report for the last artifact |
| `/lean-revalidate [type] [--dry-run]` | Recompute V1+V2 auto-score for one or all saved artifacts; `--dry-run` previews without writing |
| `/lean-next` | Suggest the next skill to invoke for the current phase |
| `/lean-task <id>` | Show full details of a single task (read-only; includes hints to edit/remove) |
| `/lean-task-add description=… [criteria=…] [notes=…]` | Add a new task |
| `/lean-task-edit <id> field=value …` | Update description / criteria / notes of a single task |
| `/lean-task-toggle <id>` | Flip the done/undone status of a single task |
| `/lean-task-remove <id>` | Remove a single task |
| `/lean-export` | Export artifacts + state snapshot to `.pi-lean-flow/exports/` |
| `/lean-import [--dry-run]` | Re-import artifacts from `.pi-lean-flow/exports/`; `--dry-run` reports without writing |
| `/lean-clean [--audit]` | Remove orphan `.tmp` files; with `--audit` also wipe `audit.log` and `audit.log.1` |
| `/lean-history [N] [--phase <name>]` | Show recent phase history; filter by phase if requested |
| `/lean-audit [N] [--full] [--json] [--grep <pat>] [--since <iso>] [--status passed\|failed\|skipped]` | Tail audit log with quoted patterns, date range, and status filter |
| `/lean-acknowledge` | Silence session-start coherence warnings until the next phase change |

> The agent uses the `lean_task_manage` tool for the full CRUD (list, add,
> toggle, edit, remove, clear). The slash commands above mirror the
> non-conversational subset (`edit`, `remove`) for direct user control.

> **Phase changes** are also available as the `lean_set_phase` tool, callable by the agent — not as a slash command. Use it from within a skill to manually move the workflow.

## Phases

```
[Brainstorm] → [Plan] → [Implement] ⇄ [Review]
     ↑                         ↓ (issues)
     └─────────────────────────┘
```

### 1. Brainstorming (`/skill:lean-brainstorm`)
The agent becomes a **Product Owner** and guides you through a dialogue to clarify
the idea. At the end, it produces a **Clarified Product Card**.

### 2. Planning (`/skill:lean-plan`)
The agent becomes an **Architect** and translates the card into an **Action Plan**
with tasks, acceptance criteria, and technical notes.

### 3. Implementation (`/skill:lean-implement`)
The agent becomes a **Developer** and implements the tasks one by one, writing
code and validating the result.

### 4. Review (`/skill:lean-review`)
The agent becomes a **Reviewer** and evaluates the completed work, producing
a **Review Report** with issues and suggestions.

## Architecture

### `extension.ts`
Extension entry point. Registers:
- **4 state tools** (`lean_save_artifact`, `lean_get_artifact`, `lean_set_phase`, `lean_task_manage`) for state management
- **2 quality tools** (`lean_evaluate_artifact`, `lean_run_checks`) for validation and self-evaluation
- **7 commands** (`/lean-status`, `/lean-reset`, `/lean-quality`, `/lean-next`, `/lean-task`, `/lean-export`, `/lean-import`)
- **Hooks** `session_start` and `before_agent_start` for persistent widget and automatic context injection
- **Custom TUI rendering** for each tool

### `state/project-state.ts`
Persistent state management in `.pi-lean-flow/state.json`:
- `loadState()` / `saveState()` / `resetState()` for CRUD
- Types `LeanState`, `LeanPhase`, `LeanTask`, `LeanEvaluation`
- Helpers: `formatStatus()`, `phaseLabel()`, `suggestNextPhase()`

### `quality/gate.ts`
Three-level quality gate:
- **V1**: required field validation (`checkRequiredFields`)
- **V2**: automatic heuristic scoring (`evaluateQuality`)
- **V3**: external command execution — compile, lint, test, typecheck (`runExternalCheck`)
- Combined report with `generateQualityReport()` / `formatQualityReport()`

### Skills `.md`
Each phase is defined as a Markdown skill with YAML frontmatter and detailed system prompt (role, personality, conversation flow, artifact template).

## Project Structure

```
pi-lean-flow/
├── extension.ts            # Entry point: registers tools, commands, events
├── package.json            # Pi package metadata
├── README.md               # This documentation
├── state/
│   └── project-state.ts    # State management (JSON file)
├── skills/
│   ├── brainstorm.md       # Brainstorming skill
│   ├── plan.md             # Planning skill
│   ├── implement.md        # Implementation skill
│   └── review.md           # Review skill
└── quality/
    └── gate.ts             # Quality gate (field validation, scoring, external checks)
```

## State

The flow state is saved in `.pi-lean-flow/state.json` in the project
directory. It includes:
- Current phase
- Produced artifacts (Clarified Product, Action Plan, Review Report)
- Tasks with completion status
- Quality evaluations (scores, rationale, suggestions)
- Phase history

## Quality Gate

### V1 — Field validation
Each artifact is automatically validated on save:
- Required fields present (Markdown headers)
- Minimum content length
- Presence of list items / specifications

### V2 — LLM self-evaluation
Before saving an artifact, the agent calls `lean_evaluate_artifact`
to self-assess quality:
- Score 1-10 with rationale
- Improvement suggestions
- Browsable evaluation history

### V3 — External checks
After each implementation task, the agent runs:
- `lean_run_checks compile` — project build
- `lean_run_checks lint` — code style check
- `lean_run_checks test` — test execution
- `lean_run_checks typecheck` — type checking
- `lean_run_checks format` — formatter (prettier/dprint/biome) check

Commands and timeouts can be overridden in `.pi-lean-flow/config.json`:

```json
{
  "checks": {
    "test": "pnpm test --silent"
  },
  "timeouts": {
    "test": 300000
  },
  "timeoutMs": 120000
}
```

- `checks[type]` overrides the auto-detected command for that check type.
- `timeouts[type]` sets a per-check timeout in milliseconds.
- `timeoutMs` sets the default timeout for any check without its own override.
- The default fallback is 60s.

## Publishing to npm

```bash
# 1. Update the version in package.json (semantic versioning)
npm version patch   # or minor / major

# 2. Verify the package contents (uses .npmignore)
npm pack --dry-run

# 3. Publish
npm publish --access public
```

### `.pi-lean-flow/config.json` (project overrides)

Optional per-project configuration:

```json
{
  "checks": {
    "compile": "yarn build",
    "lint": "eslint . --max-warnings 0",
    "test": "pnpm test --silent",
    "typecheck": "tsc --noEmit -p .",
    "format": "prettier --check ."
  },
  "timeouts": {
    "test": 300000,
    "compile": 180000
  },
  "timeoutMs": 120000,
  "maxAuditBytes": 5000000,
  "maxCheckOutputChars": 8000,
  "maxCheckErrorChars": 2000
}
```

- `maxAuditBytes` (default `1_000_000`) — rotate `audit.log` when it grows past this.
- `maxCheckOutputChars` (default `3000`) — cap stdout returned by `lean_run_checks`.
- `maxCheckErrorChars` (default `1000`) — cap stderr returned by `lean_run_checks`.
- `maxRationaleChars` (default `4000`) — cap `lean_evaluate_artifact.rationale`.
- `maxSuggestionChars` (default `500`) — cap each `lean_evaluate_artifact.suggestions[i]`.
- `maxSuggestions` (default `20`) — cap number of suggestions kept per eval.
- `maxHistoryRetained` (default `200`) — cap on `state.history` entries; oldest are dropped on save.

> **Security note:** the `checks` field is executed as a shell command in the
> project working directory. Treat `.pi-lean-flow/config.json` as **executable
> code** — review any change committed to your repo with the same care you'd
> apply to a script in `package.json`.

## Audit Log

Every invocation of `lean_run_checks` appends one JSON line to
`.pi-lean-flow/audit.log` with the check type, the resolved command,
status, duration, and exit code. Use it to investigate which commands were
executed (useful if `config.json` is committed across teams), or via
`/lean-audit [N]` to view the last N entries.

```jsonl
{"timestamp":"2026-05-21T10:00:00.000Z","checkType":"test","command":"npm test","status":"passed","durationMs":1234,"exitCode":0,"timedOut":false}
```

- **Rotation:** when the file exceeds ~1 MB, it is rotated to
  `audit.log.1` (overwriting any previous rotation). Two generations are
  kept; copy the file out if you need durable history.
- **Race-safety:** writes are serialised per-cwd via an in-memory queue,
  so concurrent `runExternalCheck` calls cannot interleave records on any
  platform.
- **Redaction:** secret-bearing patterns in the recorded command are
  replaced with `***` before being written. The redactor recognises
  `--token=…`, `--password=…`, `--secret=…`, `--api-key=…`, `--auth=…`,
  `--bearer=…`, env-style assignments (`TOKEN=…`, `PASSWORD=…`, etc.) and
  `Authorization: Bearer …` headers. Custom flag names are NOT redacted —
  audit the project's check commands before sharing the log.
- **Privacy:** the redactor is best-effort. Treat `audit.log` as
  potentially sensitive and exclude it from any artefact you publish.
  `.pi-lean-flow/` is already covered by the default `.gitignore`.

The file is best-effort: a failed append never blocks the actual check.

## Command sanity check

Before invoking a command resolved by `detectAvailableCommand`, the gate
refuses to spawn the shell when the command matches dangerous patterns:

- `rm -rf` of a root-like path
- classic fork bomb (`:(){ :|:& };:`)
- `curl … | sh` / `wget … | sh` drive-by installs

This is a safety net for typos in `config.json` — it is **not** a sandbox.
Legitimate build scripts may include pipes and redirects, so the check
is intentionally narrow.

## Debug Mode

Set the environment variable `PI_LEAN_DEBUG=1` to enable verbose stderr logging
for state management, quality gate, and tool execution:

```bash
PI_LEAN_DEBUG=1 pi dev
```

Log lines are prefixed:
- `[pi-lean-flow:state]` — state load/save/migration events
- `[pi-lean-flow:gate]` — external check commands and results
- `[pi-lean-flow:ext]` — tool calls and phase transitions

## Distribution

- **Publication:** npm as `pi-lean-flow`
- **Versioning:** semantic (`major.minor.patch`)
- **Platform:** [pi.dev](https://pi.dev) — requires `@earendil-works/pi-coding-agent`

## License

MIT — see [LICENSE](./LICENSE)
