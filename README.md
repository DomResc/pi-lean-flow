# pi-lean-flow 🧠➡️💻

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
| **Zero-friction installation** | `pi install npm:pi-lean-flow` |

## Installation

```bash
# From npm (when published)
pi install npm:pi-lean-flow

# Or from a git repository
pi install git:github.com/domresc/pi-lean-flow

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
| `/lean-status` | Show current phase and produced artifacts |
| `/lean-reset` | Reset all state (phase, artifacts, tasks) |
| `/lean-quality` | Generate quality report for the last artifact |

## Phases

```
[Brainstorm] → [Plan] → [Implement] ⇄ [Review]
     ↑                         ↓ (issues)
     └─────────────────────────┘
```

### 1. 🧠 Brainstorming (`/skill:lean-brainstorm`)
The agent becomes a **Product Owner** and guides you through a dialogue to clarify
the idea. At the end, it produces a **Clarified Product Card**.

### 2. 📋 Planning (`/skill:lean-plan`)
The agent becomes an **Architect** and translates the card into an **Action Plan**
with tasks, acceptance criteria, and technical notes.

### 3. 💻 Implementation (`/skill:lean-implement`)
The agent becomes a **Developer** and implements the tasks one by one, writing
code and validating the result.

### 4. 🔍 Review (`/skill:lean-review`)
The agent becomes a **Reviewer** and evaluates the completed work, producing
a **Review Report** with issues and suggestions.

## Architecture

### `extension.ts`
Extension entry point. Registers:
- **4 state tools** (`lean_save_artifact`, `lean_get_artifact`, `lean_set_phase`, `lean_task_manage`) for state management
- **2 quality tools** (`lean_evaluate_artifact`, `lean_run_checks`) for validation and self-evaluation
- **3 commands** (`/lean-status`, `/lean-reset`, `/lean-quality`)
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

## Distribution

- **Publication:** npm as `pi-lean-flow`
- **Versioning:** semantic (`major.minor.patch`)
- **Platform:** [pi.dev](https://pi.dev) — requires `@earendil-works/pi-coding-agent`

## License

MIT — see [LICENSE](./LICENSE)
