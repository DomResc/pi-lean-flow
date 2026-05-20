# AGENTS.md

Instructions for AI coding agents working on the pi-lean-flow project.

## Project Overview

pi-lean-flow is a [pi.dev](https://pi.dev) extension that implements a 4-phase agile
workflow (Brainstorm → Plan → Implement → Review) using a single LLM agent that
switches roles. It is distributed as an npm package (`pi-lean-flow`).

## Architecture

```
extension.ts          — Extension entry point. Registers tools, commands, hooks.
state/project-state.ts — Persistent state in ~/.pi-lean-flow/state.json.
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

Currently a placeholder. Add real tests before publishing versions beyond 0.1.x.

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
4. Add to `PHASE_DESCRIPTIONS` and `PHASE_ARTIFACTS` if it produces an artifact.
5. Create a skill file in `skills/`.
6. Update `extension.ts` hooks and commands if needed.
7. Update `README.md` phase diagram and descriptions.

## Quality Gate

- **V1:** `checkRequiredFields()` validates Markdown headers against `REQUIRED_FIELDS`.
  Keep `REQUIRED_FIELDS` in sync with skill templates.
- **V2:** `evaluateQuality()` does heuristic scoring. Intended as automated baseline;
  the LLM self-evaluation via `lean_evaluate_artifact` provides the richer score.
- **V3:** `runExternalCheck()` runs shell commands (compile, lint, test, typecheck).
  Fallback commands are in `resolveCheckCommand()` — keep them generic enough to work
  across project types.

## Publishing

1. Bump version in `package.json`.
2. Verify `tsc --noEmit` passes.
3. Ensure `author` and `repository.url` are set.
4. `npm publish`

The `.npmignore` already excludes `.git/`, `node_modules/`, and `.pi-lean-flow/`.
