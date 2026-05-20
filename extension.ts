/**
 * extension.ts — pi-lean-flow main entry point
 *
 * Registers:
 *  - Custom tools for state management (save/get artifact, set phase, manage tasks)
 *  - /lean-status command to display current state
 *  - /lean-reset command to reset all state
 *  - session_start hook for welcome/status + persistent status widget
 *  - before_agent_start hook to inject phase context
 *
 * The 4 phases (brainstorm, plan, implement, review) are implemented
 * as pi.dev skills (see skills/ directory), each with a curated system prompt
 * that instructs the LLM to use the tools registered here.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  loadState,
  saveState,
  resetState,
  formatStatus,
  phaseLabel,
  suggestNextPhase,
} from "./state/project-state.js";
import type {
  LeanPhase,
  LeanState,
  LeanEvaluation,
} from "./state/project-state.js";

import {
  checkRequiredFields,
  evaluateQuality,
  runExternalCheck,
  generateQualityReport,
  formatQualityReport,
} from "./quality/gate.js";
import type { QualityReport } from "./quality/gate.js";

// ─── State ───────────────────────────────────────────────────────────────────

async function reloadState(ctx: ExtensionContext): Promise<LeanState> {
  return loadState(ctx.cwd);
}

// ─── Phase descriptions ──────────────────────────────────────────────────────

const PHASE_DESCRIPTIONS: Record<LeanPhase, string> = {
  brainstorm: "Start: /skill:lean-brainstorm",
  plan: "Start: /skill:lean-plan",
  implement: "Start: /skill:lean-implement",
  review: "Start: /skill:lean-review",
  done: "Done! 🎉",
};

const ARTIFACT_LABELS: Record<string, string> = {
  clarifiedProduct: "📋 Clarified Product",
  actionPlan: "📐 Action Plan",
  reviewReport: "📊 Review Report",
};

// ─── Export ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── session_start: welcome + persistent status ─────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const state = await reloadState(ctx);
    const phase = phaseLabel(state.currentPhase);
    ctx.ui.notify(`🧠 pi-lean-flow — ${phase}`, "info");
    ctx.ui.setStatus("lean-flow", `🧠 pi-lean-flow: ${phase}`);

    if (
      Object.keys(state.artifacts).length === 0 &&
      state.currentPhase === "brainstorm"
    ) {
      ctx.ui.setEditorText(
        "🧠 pi-lean-flow — Ready to start!\n\n" +
          "Available commands:\n" +
          "  /skill:lean-brainstorm   — Start brainstorming\n" +
          "  /skill:lean-plan         — Go to planning\n" +
          "  /skill:lean-implement    — Start implementing\n" +
          "  /skill:lean-review       — Start review\n" +
          "  /lean-status             — Show current state\n" +
          "  /lean-reset              — Reset everything",
      );
    }
  });

  // ── before_agent_start: inject phase context ───────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    const state = await reloadState(ctx);
    let block = `\n\n[Lean Flow — Current State]\n`;
    block += `Current phase: ${phaseLabel(state.currentPhase)}\n`;

    if (state.artifacts.clarifiedProduct) {
      block += `\n--- Clarified Product ---\n${state.artifacts.clarifiedProduct}\n`;
    }
    if (state.artifacts.actionPlan) {
      block += `\n--- Action Plan ---\n${state.artifacts.actionPlan}\n`;
    }
    if (state.tasks.length > 0) {
      const done = state.tasks.filter((t) => t.done).length;
      block += `\nTasks: ${done}/${state.tasks.length} completed\n`;
      for (const t of state.tasks) {
        block += `  ${t.done ? "[x]" : "[ ]"} #${t.id}: ${t.description}\n`;
      }
    }
    if (state.evaluations.length > 0) {
      block += `\nQuality Gate evaluations:\n`;
      const last = state.evaluations[state.evaluations.length - 1];
      block += `  Latest: ${last.artifactType} — ${last.score}/10 (${last.rationale.slice(0, 100)})\n`;
    }
    if (state.history.length > 0) {
      block += `\nPhase history:\n`;
      for (const h of state.history) {
        block += `  • ${phaseLabel(h.phase)} — ${new Date(h.timestamp).toLocaleString()}${h.note ? ` (${h.note})` : ""}\n`;
      }
    }

    return { systemPrompt: event.systemPrompt + block };
  });

  // ── Helper: update status widget ───────────────────────────────────────────

  function updatePhaseStatus(ctx: ExtensionContext, newPhase: LeanPhase) {
    ctx.ui.setStatus("lean-flow", `🧠 pi-lean-flow: ${phaseLabel(newPhase)}`);
    if (newPhase !== "done") {
      ctx.ui.notify(
        `pi-lean-flow → ${phaseLabel(newPhase)}\n${PHASE_DESCRIPTIONS[newPhase]}`,
        "info",
      );
    }
  }

  // ── Tool: lean_save_artifact ───────────────────────────────────────────────

  pi.registerTool({
    name: "lean_save_artifact",
    label: "Lean Save Artifact",
    description:
      "Save an artifact for the current Lean Flow phase. " +
      "Use this at the end of each phase to persist the result. " +
      "Automatically advances to the next phase.",
    promptSnippet:
      "Save artifacts (Clarified Product, Action Plan, Review Report)",
    promptGuidelines: [
      "Use lean_save_artifact after completing a phase deliverable to persist it.",
      "Use lean_get_artifact to read previously saved artifacts.",
    ],
    parameters: Type.Object({
      type: StringEnum([
        "clarifiedProduct",
        "actionPlan",
        "reviewReport",
      ] as const),
      content: Type.String({
        description: "The full artifact content in Markdown",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      state.artifacts[params.type] = params.content;

      // V1 + V2: Quality evaluation (includes field check internally)
      const quality = evaluateQuality(params.type, params.content);
      const fieldCheck = checkRequiredFields(params.type, params.content);
      let qualityMsg = "";
      if (!fieldCheck.isValid) {
        qualityMsg = ` ⚠️ Missing fields: ${fieldCheck.missingFields.join(", ")}`;
      }
      if (fieldCheck.warnings.length > 0) {
        qualityMsg += ` ⚠️ ${fieldCheck.warnings[0]}`;
      }

      const phaseMap: Record<string, LeanPhase> = {
        clarifiedProduct: "brainstorm",
        actionPlan: "plan",
        reviewReport: "review",
      };
      const completedPhase = phaseMap[params.type];
      if (completedPhase) {
        state.history.push({
          phase: completedPhase,
          timestamp: Date.now(),
          note: `✅ ${params.type} saved (quality: ${quality.score}/10)`,
        });
        const next = suggestNextPhase(completedPhase);
        if (next) {
          state.currentPhase = next;
          state.history.push({
            phase: next,
            timestamp: Date.now(),
            note: `Transition from ${completedPhase} to ${next}`,
          });
        }
      }
      await saveState(ctx.cwd, state);

      if (phaseMap[params.type]) {
        updatePhaseStatus(ctx, state.currentPhase);
      }

      const label = ARTIFACT_LABELS[params.type] ?? params.type;
      return {
        content: [
          {
            type: "text",
            text: `✅ ${label} saved. Quality: ${quality.score}/10.${qualityMsg} Now in: ${phaseLabel(state.currentPhase)}.`,
          },
        ],
        details: {
          savedType: params.type,
          currentPhase: state.currentPhase,
          qualityScore: quality.score,
          missingFields: fieldCheck.missingFields,
        },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | { savedType?: string; currentPhase?: string }
        | undefined;
      const label = ARTIFACT_LABELS[d?.savedType ?? ""] ?? d?.savedType ?? "";
      return new Text(
        theme.fg("success", "✓ Saved ") +
          theme.fg("accent", label) +
          theme.fg("dim", ` → ${d?.currentPhase ?? ""}`),
        0,
        0,
      );
    },
  });

  // ── Tool: lean_get_artifact ────────────────────────────────────────────────

  pi.registerTool({
    name: "lean_get_artifact",
    label: "Lean Get Artifact",
    description:
      "Read a previously saved artifact to retrieve context from earlier phases.",
    promptSnippet: "Read previously saved artifacts",
    parameters: Type.Object({
      type: StringEnum([
        "clarifiedProduct",
        "actionPlan",
        "reviewReport",
      ] as const),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      const content = state.artifacts[params.type];
      if (!content) {
        return {
          content: [
            { type: "text", text: `⚠️ No artifact "${params.type}" found.` },
          ],
          details: { found: false, type: params.type },
        };
      }
      return {
        content: [{ type: "text", text: content }],
        details: { found: true, type: params.type, length: content.length },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | { found?: boolean; type?: string; length?: number }
        | undefined;
      if (!d?.found) return new Text(theme.fg("error", "✗ Not found"), 0, 0);
      const label = ARTIFACT_LABELS[d.type ?? ""] ?? d.type ?? "";
      return new Text(
        theme.fg("success", "✓ Loaded ") +
          theme.fg("accent", label) +
          theme.fg("dim", ` (${d.length} chars)`),
        0,
        0,
      );
    },
  });

  // ── Tool: lean_set_phase ───────────────────────────────────────────────────

  pi.registerTool({
    name: "lean_set_phase",
    label: "Lean Set Phase",
    description:
      "Manually set the current phase. Use to skip or restart phases.",
    promptSnippet: "Set the current phase",
    parameters: Type.Object({
      phase: StringEnum([
        "brainstorm",
        "plan",
        "implement",
        "review",
        "done",
      ] as const),
      note: Type.Optional(
        Type.String({ description: "Optional reason for the phase change" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      const previous = state.currentPhase;
      state.currentPhase = params.phase;
      state.history.push({
        phase: params.phase,
        timestamp: Date.now(),
        note: params.note ?? `From ${previous} to ${params.phase}`,
      });
      await saveState(ctx.cwd, state);
      updatePhaseStatus(ctx, params.phase);
      return {
        content: [
          {
            type: "text",
            text: `✅ Phase: ${phaseLabel(previous)} → ${phaseLabel(params.phase)}`,
          },
        ],
        details: { previous, current: params.phase },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | { previous?: string; current?: string }
        | undefined;
      if (!d) return new Text("", 0, 0);
      return new Text(
        theme.fg("warning", "⬆ ") +
          theme.fg("dim", d.previous ?? "") +
          theme.fg("muted", " → ") +
          theme.fg("accent", d.current ?? ""),
        0,
        0,
      );
    },
  });

  // ── Tool: lean_task_manage ─────────────────────────────────────────────────

  pi.registerTool({
    name: "lean_task_manage",
    label: "Lean Task Manage",
    description:
      "Manage tasks. Actions: list, add, toggle (done/undone), clear.",
    promptSnippet: "Manage implementation tasks",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "toggle", "clear"] as const),
      description: Type.Optional(
        Type.String({ description: "Task description (required for add)" }),
      ),
      acceptanceCriteria: Type.Optional(
        Type.String({ description: "Acceptance criteria (optional)" }),
      ),
      notes: Type.Optional(
        Type.String({ description: "Technical notes (optional)" }),
      ),
      taskId: Type.Optional(
        Type.Number({ description: "Task ID (required for toggle)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);

      switch (params.action) {
        case "list": {
          if (state.tasks.length === 0) {
            return {
              content: [{ type: "text", text: "No tasks defined." }],
              details: { action: "list", tasks: [] },
            };
          }
          const done = state.tasks.filter((t) => t.done).length;
          const lines = [`Tasks: ${done}/${state.tasks.length} completed`];
          for (const t of state.tasks) {
            let line = `${t.done ? "[x]" : "[ ]"} #${t.id}: ${t.description}`;
            if (t.acceptanceCriteria)
              line += `\n     Criteria: ${t.acceptanceCriteria}`;
            if (t.notes) line += `\n     Notes: ${t.notes}`;
            lines.push(line);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              action: "list",
              tasks: state.tasks,
              done,
              total: state.tasks.length,
            },
          };
        }

        case "add": {
          if (!params.description) {
            return {
              content: [{ type: "text", text: "Error: description required." }],
              details: {
                action: "add",
                error: "description required",
                tasks: state.tasks,
              },
            };
          }
          const maxId = state.tasks.reduce((m, t) => Math.max(m, t.id), 0);
          const newTask = {
            id: maxId + 1,
            description: params.description,
            acceptanceCriteria: params.acceptanceCriteria ?? "",
            notes: params.notes ?? "",
            done: false,
          };
          state.tasks.push(newTask);
          await saveState(ctx.cwd, state);
          return {
            content: [
              {
                type: "text",
                text: `✅ Task #${newTask.id}: ${newTask.description}`,
              },
            ],
            details: { action: "add", tasks: state.tasks, task: newTask },
          };
        }

        case "toggle": {
          if (params.taskId === undefined) {
            return {
              content: [{ type: "text", text: "Error: taskId required." }],
              details: {
                action: "toggle",
                error: "taskId required",
                tasks: state.tasks,
              },
            };
          }
          const task = state.tasks.find((t) => t.id === params.taskId);
          if (!task) {
            return {
              content: [
                { type: "text", text: `Task #${params.taskId} not found.` },
              ],
              details: {
                action: "toggle",
                error: "not found",
                tasks: state.tasks,
              },
            };
          }
          task.done = !task.done;

          // Auto-transition to review when all tasks are completed
          const allDone =
            state.tasks.length > 0 && state.tasks.every((t) => t.done);
          if (allDone && state.currentPhase === "implement") {
            state.currentPhase = "review";
            state.history.push({
              phase: "review",
              timestamp: Date.now(),
              note: "All tasks completed — auto-transition to review",
            });
          }

          await saveState(ctx.cwd, state);
          const status = task.done ? "completed" : "reopened";
          let allDoneMsg = "";
          if (allDone && task.done) {
            allDoneMsg =
              "\n🎯 All tasks completed! Phase advanced to: 🔍 Review. Use /skill:lean-review for the final review.";
            updatePhaseStatus(ctx, state.currentPhase);
          }
          return {
            content: [
              {
                type: "text",
                text: `✅ Task #${task.id} ${status}: ${task.description}${allDoneMsg}`,
              },
            ],
            details: { action: "toggle", tasks: state.tasks, allDone },
          };
        }

        case "clear": {
          const count = state.tasks.length;
          state.tasks = [];
          await saveState(ctx.cwd, state);
          return {
            content: [{ type: "text", text: `🗑️ ${count} task(s) cleared.` }],
            details: { action: "clear", tasks: [] },
          };
        }

        default:
          return {
            content: [
              { type: "text", text: `Unknown action: ${params.action}` },
            ],
            details: {
              action: params.action,
              error: "unknown action",
              tasks: state.tasks,
            },
          };
      }
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | {
            action?: string;
            done?: number;
            total?: number;
            task?: { id: number; description: string; done: boolean };
            error?: string;
          }
        | undefined;
      if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
      if (d?.action === "list")
        return new Text(
          theme.fg("muted", `${d.done ?? 0}/${d.total ?? 0} tasks completed`),
          0,
          0,
        );
      if (d?.action === "add" && d.task)
        return new Text(
          theme.fg("success", "✓ + ") +
            theme.fg("accent", `#${d.task.id}`) +
            theme.fg("dim", ` ${d.task.description}`),
          0,
          0,
        );
      if (d?.action === "toggle" && d.task)
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("accent", `#${d.task.id}`) +
            theme.fg("dim", d.task.done ? " done" : " reopened"),
          0,
          0,
        );
      if (d?.action === "clear")
        return new Text(theme.fg("warning", "🗑 Cleared"), 0, 0);
      return new Text("", 0, 0);
    },
  });

  // ── Tool: lean_evaluate_artifact (V2 Quality Gate) ──────────────────────────

  pi.registerTool({
    name: "lean_evaluate_artifact",
    label: "Lean Evaluate Artifact",
    description:
      "Self-evaluate the quality of an artifact at the end of a phase. " +
      "Assign a score 1-10 and provide rationale. Use this before lean_save_artifact " +
      "to record your quality assessment. The score and suggestions are stored in state.",
    promptSnippet: "Evaluate artifact quality (score 1-10)",
    promptGuidelines: [
      "Use lean_evaluate_artifact at the end of each phase to self-assess quality.",
      "Score 1-10: 1-3=poor, 4-6=adequate, 7-8=good, 9-10=excellent.",
      "Provide concrete suggestions for improvement.",
    ],
    parameters: Type.Object({
      artifactType: StringEnum([
        "clarifiedProduct",
        "actionPlan",
        "reviewReport",
      ] as const),
      score: Type.Number({ description: "Quality score 1-10" }),
      rationale: Type.String({
        description: "Why this score? What's good and what could be improved?",
      }),
      suggestions: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "List of concrete suggestions for improvement (optional)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);

      // Clamp score
      const score = Math.max(1, Math.min(10, params.score));

      const evaluation: LeanEvaluation = {
        phase: state.currentPhase,
        artifactType: params.artifactType,
        score,
        rationale: params.rationale,
        suggestions: params.suggestions ?? [],
        timestamp: Date.now(),
      };

      state.evaluations.push(evaluation);
      await saveState(ctx.cwd, state);

      const artifactLabel =
        ARTIFACT_LABELS[params.artifactType] ?? params.artifactType;
      const scoreEmoji = score >= 7 ? "✅" : score >= 4 ? "⚠️" : "❌";

      return {
        content: [
          {
            type: "text",
            text: `${scoreEmoji} ${artifactLabel} — Score: ${score}/10\n\n${params.rationale}${params.suggestions && params.suggestions.length > 0 ? `\n\nSuggestions:\n${params.suggestions.map((s: string) => `  - ${s}`).join("\n")}` : ""}`,
          },
        ],
        details: {
          artifactType: params.artifactType,
          score,
          rationale: params.rationale,
          suggestions: params.suggestions ?? [],
        },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | { artifactType?: string; score?: number }
        | undefined;
      if (!d) return new Text("", 0, 0);
      const label =
        ARTIFACT_LABELS[d.artifactType ?? ""] ?? d.artifactType ?? "";
      const scoreEmoji =
        (d.score ?? 5) >= 7 ? "✅" : (d.score ?? 5) >= 4 ? "⚠️" : "❌";
      return new Text(
        theme.fg("accent", `${scoreEmoji} `) +
          theme.fg("dim", label) +
          theme.fg("muted", " — ") +
          (d.score && d.score >= 7
            ? theme.fg("success", `${d.score}/10`)
            : d.score && d.score >= 4
              ? theme.fg("warning", `${d.score}/10`)
              : theme.fg("error", `${d.score}/10`)),
        0,
        0,
      );
    },
  });

  // ── Tool: lean_run_checks (V3 Quality Gate) ────────────────────────────────

  pi.registerTool({
    name: "lean_run_checks",
    label: "Lean Run Checks",
    description:
      "Run external validation checks on the project. " +
      "Supports: compile (npm run build), lint (npm run lint), " +
      "test (npm test), typecheck (tsc --noEmit). " +
      "Use after implementation tasks to validate changes.",
    promptSnippet:
      "Run project validation checks (compile, lint, test, typecheck)",
    promptGuidelines: [
      "Use lean_run_checks after completing implementation tasks to validate changes.",
      "Run 'compile' first to ensure the project builds.",
      "Run 'test' to verify existing tests still pass.",
      "Run 'lint' to check code style.",
    ],
    parameters: Type.Object({
      checkType: StringEnum(["compile", "lint", "test", "typecheck"] as const),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runExternalCheck(params.checkType, ctx.cwd);

      const statusIcon = result.passed ? "✅" : "❌";
      const output = result.output.slice(0, 3000); // truncate for LLM context
      const errors = result.errors.join("\n").slice(0, 1000);

      let text = `${statusIcon} ${params.checkType}: ${result.passed ? "OK" : "FAILED"} (${result.durationMs}ms)\n`;
      if (output) text += `\nOutput:\n${output}\n`;
      if (errors) text += `\nErrors:\n${errors}\n`;

      return {
        content: [{ type: "text", text }],
        details: {
          checkType: params.checkType,
          passed: result.passed,
          output: result.output,
          errors: result.errors,
          durationMs: result.durationMs,
        },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | { checkType?: string; passed?: boolean; durationMs?: number }
        | undefined;
      if (!d) return new Text("", 0, 0);
      const icon = d.passed ? theme.fg("success", "✓") : theme.fg("error", "✗");
      return new Text(
        icon +
          theme.fg("dim", ` ${d.checkType} `) +
          theme.fg("muted", `(${d.durationMs ?? 0}ms)`),
        0,
        0,
      );
    },
  });

  // ── Command: /lean-quality ─────────────────────────────────────────────────

  pi.registerCommand("lean-quality", {
    description: "Generate a quality report for the last saved artifact.",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);

      // Find the last artifact and its evaluation
      const artifactKeys = Object.keys(state.artifacts);
      if (artifactKeys.length === 0) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No artifacts present. Complete at least one phase.",
            "warning",
          );
        return;
      }

      const lastKey = artifactKeys[artifactKeys.length - 1];
      const lastContent = state.artifacts[lastKey];
      const lastEvaluation = [...state.evaluations]
        .reverse()
        .find((e) => e.artifactType === lastKey);

      const report = generateQualityReport(
        lastKey,
        lastContent,
        lastEvaluation
          ? {
              score: lastEvaluation.score,
              rationale: lastEvaluation.rationale,
              suggestions: lastEvaluation.suggestions,
            }
          : undefined,
      );

      const formatted = formatQualityReport(report);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `${report.artifactName}: ${report.heuristicScore.score}/10`,
          "info",
        );
        ctx.ui.setEditorText(formatted);
      }
    },
  });

  // ── Command: /lean-status ──────────────────────────────────────────────────

  pi.registerCommand("lean-status", {
    description:
      "Show the current Lean Flow phase, artifacts, task progress, and quality scores.",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);
      const report = formatStatus(state);
      if (ctx.hasUI) {
        ctx.ui.notify(report.split("\n")[0], "info");
        ctx.ui.setEditorText(report);
      }
    },
  });

  // ── Command: /lean-reset ───────────────────────────────────────────────────

  pi.registerCommand("lean-reset", {
    description:
      "Reset all Lean Flow state (clear artifacts, tasks, history, set phase to brainstorm).",
    handler: async (_args, ctx) => {
      let confirmed = true;
      if (ctx.hasUI) {
        confirmed = await ctx.ui.confirm(
          "Reset Lean Flow?",
          "This will delete all artifacts, tasks, and history. Are you sure?",
        );
      }
      if (confirmed) {
        await resetState(ctx.cwd);
        ctx.ui.notify(
          "🧹 Lean Flow state reset. Phase: Brainstorming.",
          "info",
        );
      }
    },
  });
}
