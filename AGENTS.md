# AGENTS.md

Instructions for AI coding agents working on the pi-lean-flow project.

## Project Overview

pi-lean-flow is a [pi.dev](https://pi.dev) extension that implements a 4-phase agile
workflow (Brainstorm → Plan → Implement → Review) using a single LLM agent that
switches roles. It is distributed as an npm package (`pi-lean-flow`).

## Architecture

```
extension.ts          — Extension entry point. Registers tools, commands, hooks.
state/project-state.ts — Persistent state in <cwd>/.pi-lean-flow/state.json (per-project).
quality/gate.ts      — Quality gate: field validation (V1), heuristic scoring (V2),
                        external command execution (V3).
skills/*.md          — One skill per phase. YAML frontmatter + system prompt.
```

- **Tools** are registered via `pi.registerTool()` in `extension.ts`.
- **Commands** are registered via `pi.registerCommand()`.
- **Hooks** (`session_start`, `before_agent_start`) manage UI status and context injection.
- **State** is per-project, stored as JSON in `.pi-lean-flow/state.json`.
- **Skills** are pure Markdown files with YAML frontmatter declaring `allowed-tools`.

## Development

### Type-check

```bash
npx tsc --noEmit
```

The project targets `ES2022` with `moduleResolution: "bundler"`. Imports use
explicit `.js` extensions (e.g. `./state/project-state.js`).

### Testing

```bash
npm test
```

Vitest tests live alongside the modules (`state/project-state.test.ts`,
`quality/gate.test.ts`). Add new tests for every new tool/command or migrator.

### Running locally in pi

```bash
pi install ./pi-lean-flow
```

Then use `/skill:lean-brainstorm`, `/lean-status`, etc.

## Conventions

- **Language:** All code, comments, and user-facing strings are in English.
- **Artifact keys:** `clarifiedProduct`, `actionPlan`, `reviewReport` (camelCase).
- **Phase values:** `brainstorm`, `plan`, `implement`, `review`, `done`.
- **State shape:** Defined by `LeanState` interface in `state/project-state.ts`.
  Always merge with defaults on load — never assume all fields are present.
- **Error handling:** Tools return structured results with `content` and `details`,
  never throw. Use `details.error` for error states.
- **TUI rendering:** Every tool has a `renderResult` callback that returns a `Text`
  component. Use theme colors: `success`, `error`, `warning`, `accent`, `muted`, `dim`.

## State Migrations

The state file at `.pi-lean-flow/state.json` is versioned by `STATE_VERSION`
in `state/project-state.ts`. When you add a field to `LeanState` (or to any
nested type like `LeanEvaluation`):

1. Bump `STATE_VERSION` by 1.
2. Add a migrator entry to the `MIGRATIONS` record. Each migrator upgrades
   from version `n` to `n+1` and **must** stamp `version: n+1` on the
   returned object.
3. Backfill new required fields with a sane default that reflects what
   pre-migration entries semantically meant (e.g. v2→v3 tags pre-existing
   evaluations as `source: "llm"` because the heuristic didn't persist
   anything before v3).
4. Update `loadState`'s post-migration sanitiser to defensively guard
   against hand-edited values for the new field.
5. Add a test in `state/project-state.test.ts` covering both:
   - migration from the previous version's schema
   - hand-edited current-version state with the field missing/invalid

Existing migrators:
- **v0 → v1**: stamped version only.
- **v1 → v2**: added `lastSavedArtifact: LeanArtifactKey | null`.
- **v2 → v3**: added `source: "auto" | "llm"` to each `LeanEvaluation`.
  Pre-existing evaluations are tagged `"llm"` because the heuristic didn't
  persist anything before v3.
- **v3 → v4**: added `coherenceAck: { phase, timestamp } | null` to track
  user acknowledgement of session-start coherence warnings. Pre-existing
  states get `null` (no ack recorded).

> When you bump `STATE_VERSION` in code, update this list at the same time.
> A drift between code and docs has caused real bugs (see CHANGELOG v0.2).

## Slash commands vs tools

The extension exposes the same workflow surface in two ways:

- **Tools** (e.g. `lean_task_manage`, `lean_save_artifact`,
  `lean_evaluate_artifact`, `lean_set_phase`, `lean_get_artifact`,
  `lean_run_checks`) are the *agent-facing* API. They are called by the LLM
  during the conversation, are typed via TypeBox, and are documented in each
  skill's `allowed-tools` frontmatter.
- **Slash commands** (e.g. `/lean-status`, `/lean-task-edit`,
  `/lean-acknowledge`, `/lean-audit`, `/lean-revalidate`, `/lean-export`,
  `/lean-clean`) are the *user-facing* API. They are typed by the user in
  pi.dev, parsed by argument-string handlers, and produce UI side-effects
  (notify + editor pane).

Pick one or the other when adding new functionality:

- **Use a tool** if the LLM must invoke the behaviour in the middle of a
  conversation as part of the workflow logic. Tools should return a result
  the LLM can reason about; the TUI display is secondary.
- **Use a slash command** if the behaviour is administrative, interactive,
  or diagnostic — something the user wants direct control over without
  going through the agent. Slash commands should not be exposed in skill
  `allowed-tools` lists.
- **Use both** only when the same operation is genuinely useful from both
  sides. `lean_task_manage` (tool) + `/lean-task-add` / `/lean-task-edit` /
  `/lean-task-remove` / `/lean-task-toggle` (slash) is the canonical
  example: the LLM uses the tool during the implement phase, the user uses
  the slash variants for direct intervention.

When adding a slash command:
1. Register with `pi.registerCommand("lean-<name>", { description, handler })`.
2. Argument parsing is your responsibility — use `parseTaskFields` for
   the `field=value` pattern, or a hand-rolled tokeniser respecting shell
   quoting (see `/lean-audit`).
3. Surface no-op or error cases through `ctx.ui.notify` with a clear
   message; do not throw.
4. Update [README.md](./README.md) commands table.

## Adding a New Tool

1. Define parameters with `Type.Object()` from `typebox`.
2. Implement `execute` — load state, mutate, save, return result.
3. Add `renderResult` for TUI display.
4. Update `extension.ts` comments and the relevant skill's `allowed-tools` frontmatter
   if the skill should use it.

## Adding a New Phase

1. Add the phase value to `LeanPhase` in `state/project-state.ts`.
2. Add its label to `PHASE_LABELS`.
3. Add it to the sequence in `suggestNextPhase()`.
4. Add to `PHASE_DESCRIPTIONS` in `extension.ts` and, if the phase produces an
   artifact, also to `ARTIFACT_LABELS` and `REQUIRED_FIELDS` (in `quality/gate.ts`).
5. Create a skill file in `skills/`.
6. Update `extension.ts` hooks and commands if needed.
7. Update `README.md` phase diagram and descriptions.

## Quality Gate

- **V1:** `checkRequiredFields()` validates Markdown headers against `REQUIRED_FIELDS`.
  Keep `REQUIRED_FIELDS` in sync with skill templates.
- **V2:** `evaluateQuality()` does heuristic scoring. Intended as automated baseline;
  the LLM self-evaluation via `lean_evaluate_artifact` provides the richer score.
- **V3:** `runExternalCheck()` runs shell commands (compile, lint, test, typecheck, format).
  Fallback commands are in `detectAvailableCommand()` — keep them generic enough to work
  across project types. Project-level overrides live in `.pi-lean-flow/config.json`.

## Publishing

1. Bump version in `package.json`.
2. Verify `tsc --noEmit` passes.
3. Ensure `author` and `repository.url` are set.
4. `npm publish`

The `.npmignore` already excludes `.git/`, `node_modules/`, and `.pi-lean-flow/`.
