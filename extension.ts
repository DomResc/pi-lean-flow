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

import { mkdir, writeFile, readdir, readFile, rename, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  loadState,
  resetState,
  withState,
  formatStatus,
  phaseLabel,
  suggestNextPhase,
  computePhaseAfterTaskToggle,
  computePhaseAfterTaskRemove,
  clampScore,
  transitionPhase,
  isCoherenceAcked,
  ARTIFACT_NAMES,
  ARTIFACT_TO_PHASE,
  LEAN_ARTIFACT_KEYS,
  isLeanArtifactKey,
} from "./state/project-state.js";
import type {
  LeanPhase,
  LeanState,
  LeanEvaluation,
  LeanArtifactKey,
} from "./state/project-state.js";

import {
  checkRequiredFields,
  evaluateQuality,
  runExternalCheck,
  generateQualityReport,
  formatQualityReport,
  SUPPORTED_CHECK_TYPES,
} from "./quality/gate.js";
import { makeDebug } from "./util/debug.js";
import { clearAuditLog, redactCommand } from "./util/audit.js";
import { parseTaskFields } from "./util/parse.js";
import {
  MAX_ARTIFACT_CHARS,
  MAX_ARTIFACT_INJECTION_CHARS,
  MAX_HISTORY_INJECTED,
  MAX_TASKS_INJECTED,
  maxCheckErrorChars,
  maxCheckOutputChars,
  maxRationaleChars,
  maxSuggestionChars,
  maxSuggestions,
} from "./util/limits.js";

const dbg = makeDebug("ext");

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

const ARTIFACT_EMOJI: Record<LeanArtifactKey, string> = {
  clarifiedProduct: "📋",
  actionPlan: "📐",
  reviewReport: "📊",
};

const ARTIFACT_LABELS: Record<LeanArtifactKey, string> = {
  clarifiedProduct: `${ARTIFACT_EMOJI.clarifiedProduct} ${ARTIFACT_NAMES.clarifiedProduct}`,
  actionPlan: `${ARTIFACT_EMOJI.actionPlan} ${ARTIFACT_NAMES.actionPlan}`,
  reviewReport: `${ARTIFACT_EMOJI.reviewReport} ${ARTIFACT_NAMES.reviewReport}`,
};

function artifactLabel(key: string): string {
  return (ARTIFACT_LABELS as Record<string, string>)[key] ?? key;
}

// All size/cap constants live in util/limits.ts. They're imported here so
// extension.ts stays a registry of behaviour, not a registry of magic
// numbers. See util/limits.ts for rationale on each cap and which ones are
// configurable via .pi-lean-flow/config.json.

function truncateForInjection(content: string): string {
  if (content.length <= MAX_ARTIFACT_INJECTION_CHARS) return content;
  const overflow = content.length - MAX_ARTIFACT_INJECTION_CHARS;
  return (
    content.slice(0, MAX_ARTIFACT_INJECTION_CHARS) +
    `\n\n[truncated — ${overflow} more chars; use lean_get_artifact for the full content]`
  );
}

/**
 * Detect state-coherence issues — situations where the recorded phase
 * disagrees with the artifacts present. Returns a list of short human
 * descriptions (empty when the state is coherent). Pure: doesn't touch
 * the filesystem, safe to call from any context.
 */
function computeCoherenceIssues(state: LeanState): string[] {
  const issues: string[] = [];
  if (state.currentPhase === "implement" && state.tasks.length === 0) {
    issues.push("phase is Implementation but no tasks are defined");
  }
  if (
    (state.currentPhase === "implement" ||
      state.currentPhase === "review") &&
    !state.artifacts.actionPlan
  ) {
    issues.push("no Action Plan present");
  }
  if (
    (state.currentPhase === "plan" ||
      state.currentPhase === "implement" ||
      state.currentPhase === "review") &&
    !state.artifacts.clarifiedProduct
  ) {
    issues.push("no Clarified Product present");
  }
  return issues;
}

// ─── Export ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── session_start: welcome + persistent status ─────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const state = await reloadState(ctx);
    // Initialise the persistent status widget so it is visible from the start
    // of the session, not only after the first phase transition. The shared
    // helper formats it consistently (incl. task progress when present).
    updatePhaseStatus(ctx, state.currentPhase, state, { notify: false });

    // Detect common state-coherence issues so the user knows the workflow
    // isn't aligned with the data. We only warn — never auto-fix — because
    // the user might have manual edits in flight.
    const coherenceIssues = computeCoherenceIssues(state);
    const phase = phaseLabel(state.currentPhase);
    if (coherenceIssues.length > 0 && !isCoherenceAcked(state)) {
      ctx.ui.notify(
        `pi-lean-flow — ${phase}\n⚠️ ${coherenceIssues.join("; ")}. Run /lean-acknowledge to silence until the next phase change.`,
        "warning",
      );
    } else {
      ctx.ui.notify(`pi-lean-flow — ${phase}`, "info");
    }
  });

  // ── before_agent_start: inject phase context ───────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    const state = await reloadState(ctx);
    let block = `\n\n[Lean Flow — Current State]\n`;
    block += `Current phase: ${phaseLabel(state.currentPhase)}\n`;

    if (state.artifacts.clarifiedProduct) {
      block += `\n--- Clarified Product ---\n${truncateForInjection(state.artifacts.clarifiedProduct)}\n`;
    }
    if (state.artifacts.actionPlan) {
      block += `\n--- Action Plan ---\n${truncateForInjection(state.artifacts.actionPlan)}\n`;
    }
    if (state.artifacts.reviewReport) {
      block += `\n--- Review Report ---\n${truncateForInjection(state.artifacts.reviewReport)}\n`;
    }
    if (state.tasks.length > 0) {
      const done = state.tasks.filter((t) => t.done).length;
      block += `\nTasks: ${done}/${state.tasks.length} completed\n`;
      // Cap how many tasks we paste in full. For a 200-task plan we'd
      // otherwise re-inject the whole list on every single turn. Prefer to
      // show the *pending* ones first, since those are what the agent is
      // actually working on.
      const pending = state.tasks.filter((t) => !t.done);
      const completed = state.tasks.filter((t) => t.done);
      const visible = [...pending, ...completed].slice(0, MAX_TASKS_INJECTED);
      for (const t of visible) {
        block += `  ${t.done ? "[x]" : "[ ]"} #${t.id}: ${t.description}\n`;
      }
      if (state.tasks.length > MAX_TASKS_INJECTED) {
        const hidden = state.tasks.length - MAX_TASKS_INJECTED;
        block += `  … ${hidden} more task(s) hidden — use lean_task_manage list for the full list.\n`;
      }
    }
    if (state.evaluations.length > 0) {
      block += `\nQuality Gate evaluations:\n`;
      // Prefer the most recent LLM self-evaluation tied to a saved artifact —
      // it's the qualitative signal the agent should care about. Skip orphan
      // evaluations to stay consistent with how /lean-quality presents them.
      // Fall back to the latest non-orphan entry (auto or llm) only if no
      // such self-eval exists.
      const lastLlm = [...state.evaluations]
        .reverse()
        .find((e) => e.source === "llm" && !e.orphan);
      const lastNonOrphan = [...state.evaluations]
        .reverse()
        .find((e) => !e.orphan);
      const last =
        lastLlm ??
        lastNonOrphan ??
        state.evaluations[state.evaluations.length - 1];
      // Collapse newlines in rationale so the single-line "Latest:" prefix
      // stays readable. A 100-char slice was already used for length cap;
      // we keep that but also strip whitespace runs.
      const rationale = last.rationale
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);
      block += `  Latest (${last.source}): ${last.artifactType} — ${last.score}/10 (${rationale})\n`;
    }
    if (state.history.length > 0) {
      // History grows unbounded over a long session — only the most recent
      // entries are worth pasting on every turn.
      const recent = state.history.slice(-MAX_HISTORY_INJECTED);
      const omitted = state.history.length - recent.length;
      block += `\nPhase history${omitted > 0 ? ` (last ${recent.length} of ${state.history.length})` : ""}:\n`;
      for (const h of recent) {
        block += `  • ${phaseLabel(h.phase)} — ${new Date(h.timestamp).toLocaleString()}${h.note ? ` (${h.note})` : ""}\n`;
      }
    }

    return { systemPrompt: event.systemPrompt + block };
  });

  // ── Helper: update status widget ───────────────────────────────────────────

  /**
   * Refresh the status widget. Pass `notify: true` (default) to also push a
   * toast when the phase changes. The widget itself is always rewritten —
   * idempotent calls (no-op `lean_set_phase`) should pass `notify: false` so
   * the user doesn't see a spurious "→ phase" toast.
   */
  function updatePhaseStatus(
    ctx: ExtensionContext,
    newPhase: LeanPhase,
    state?: LeanState,
    options: { notify?: boolean } = {},
  ) {
    if (!ctx.hasUI) return;
    const { notify = true } = options;
    // Enrich the status line with task progress when we have it. Keeps the
    // widget useful at a glance ("Implementation · 3/12") without forcing the
    // user to run /lean-status. Also append a warning marker when the state
    // has unacknowledged coherence issues, so the user notices something
    // wrong without opening /lean-status.
    let widgetText = `🧠 pi-lean-flow: ${phaseLabel(newPhase)}`;
    if (state && state.tasks.length > 0) {
      const done = state.tasks.filter((t) => t.done).length;
      widgetText += ` · ${done}/${state.tasks.length}`;
    }
    if (state) {
      const issues = computeCoherenceIssues(state);
      if (issues.length > 0 && !isCoherenceAcked(state)) {
        widgetText += " ⚠️";
      }
    }
    ctx.ui.setStatus("lean-flow", widgetText);
    if (!notify) return;
    if (newPhase === "done") {
      // Earlier versions silently skipped the notification for `done`, which
      // meant the user got no acknowledgement at the end of the workflow.
      ctx.ui.notify(
        `🎉 pi-lean-flow → ${phaseLabel(newPhase)}\nWorkflow completed. Use /lean-export to archive artifacts or /lean-reset to start over.`,
        "info",
      );
    } else {
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
      strict: Type.Optional(
        Type.Boolean({
          description:
            "If true, refuse to save when required fields are missing (V1 gate).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Reject empty / whitespace-only content up front — a blank artifact is
      // never what the caller wants and would only pollute the state.
      if (!params.content || params.content.trim().length === 0) {
        return {
          content: [
            { type: "text", text: "❌ Refused to save: content is empty." },
          ],
          details: { error: "empty content", savedType: params.type },
        };
      }

      // Bound artifact size so a runaway LLM can't blow up state.json.
      if (params.content.length > MAX_ARTIFACT_CHARS) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Refused to save: artifact is ${params.content.length} chars, exceeds the ${MAX_ARTIFACT_CHARS}-char limit. Trim before saving.`,
            },
          ],
          details: {
            error: "artifact too large",
            savedType: params.type,
            size: params.content.length,
            limit: MAX_ARTIFACT_CHARS,
          },
        };
      }

      // V1 + V2: Quality evaluation (includes field check internally)
      const quality = evaluateQuality(params.type, params.content);
      const fieldCheck = checkRequiredFields(params.type, params.content);

      // Opt-in V1 strict mode: refuse to save when required fields are missing
      // so the caller is forced to fix the artifact instead of advancing phase.
      // Cast through Boolean() because TypeBox does not validate at runtime —
      // an LLM that sends the string "true" would otherwise sneak past the
      // type-level check and `params.strict && …` would behave non-obviously
      // ("false" is also truthy as a string).
      const strict = params.strict === true;
      if (strict && !fieldCheck.isValid) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Strict mode: artifact not saved. Missing fields: ${fieldCheck.missingFields.join(", ")}.`,
            },
          ],
          details: {
            error: "missing required fields",
            savedType: params.type,
            missingFields: fieldCheck.missingFields,
          },
        };
      }

      const { state, result: phaseChanged } = await withState(ctx.cwd, (s) => {
        s.artifacts[params.type] = params.content;
        s.lastSavedArtifact = params.type;

        // Persist the heuristic evaluation under `source: "auto"`. We
        // deduplicate against the previous entry: if the *most recent*
        // evaluation is already an auto-eval for the same artifact, replace
        // it in place rather than appending a near-identical record. This
        // matters because an LLM may save the same artifact several times
        // in a row while iterating, and we don't want N copies of the same
        // heuristic score crowding out genuine history.
        //
        // We don't dedupe across LLM evaluations: those are different signals
        // (user-driven self-eval) and worth preserving individually.
        const newEval = {
          phase: s.currentPhase,
          artifactType: params.type,
          score: quality.score,
          rationale: quality.summary,
          suggestions: quality.suggestions,
          timestamp: Date.now(),
          source: "auto" as const,
        };
        const last = s.evaluations[s.evaluations.length - 1];
        if (
          last &&
          last.source === "auto" &&
          last.artifactType === params.type
        ) {
          s.evaluations[s.evaluations.length - 1] = newEval;
        } else {
          s.evaluations.push(newEval);
        }

        const completedPhase = ARTIFACT_TO_PHASE[params.type];
        // Auto-advance now requires the field check to pass. Saving an
        // incomplete artifact still persists it (so the LLM can iterate),
        // but the workflow stays on the current phase until the missing
        // sections are filled in.
        const advance =
          s.currentPhase === completedPhase && fieldCheck.isValid;

        // Single history entry per save. The heuristic score is already in
        // s.evaluations (source: "auto") and the saved content is in
        // s.artifacts, so we don't restate them here.
        const next = advance ? suggestNextPhase(completedPhase) : null;
        if (advance && next) {
          transitionPhase(s, next);
          s.history.push({
            phase: next,
            timestamp: Date.now(),
            note: `Saved ${params.type} → transition ${completedPhase} → ${next}`,
          });
        } else {
          // Either:
          //   - the field check failed (no advance),
          //   - the save happened off-phase (no advance), or
          //   - we're at the end of the sequence so there's no next phase.
          // In every case we still record a history entry so /lean-status
          // shows the activity. Without this fallback the save would be
          // silent — a regression risk if `ARTIFACT_TO_PHASE` ever maps a
          // key to a terminal phase.
          const reason = !fieldCheck.isValid
            ? `missing: ${fieldCheck.missingFields.join(", ")}`
            : !advance
              ? `off-phase (current=${s.currentPhase})`
              : "no next phase";
          s.history.push({
            phase: completedPhase,
            timestamp: Date.now(),
            note: `Saved ${params.type} (${reason})`,
          });
          dbg(
            `lean_save_artifact: ${params.type} saved without phase advance (current=${s.currentPhase}, valid=${fieldCheck.isValid}, hasNext=${Boolean(next)})`,
          );
        }
        return advance && Boolean(next);
      });

      let qualityMsg = "";
      if (!fieldCheck.isValid) {
        qualityMsg = ` ⚠️ Missing fields: ${fieldCheck.missingFields.join(", ")} — phase not advanced.`;
      }
      if (fieldCheck.warnings.length > 0) {
        qualityMsg += ` ⚠️ ${fieldCheck.warnings[0]}`;
      }

      // Always refresh the widget (the task counter may have shifted even
      // without a phase change). `updatePhaseStatus` no-ops when ctx.hasUI
      // is false, so we don't need to guard here.
      updatePhaseStatus(ctx, state.currentPhase, state, {
        notify: phaseChanged,
      });

      const label = ARTIFACT_LABELS[params.type] ?? params.type;
      return {
        content: [
          {
            type: "text",
            text: `✅ ${label} saved. Auto-score: ${quality.score}/10.${qualityMsg} Now in: ${phaseLabel(state.currentPhase)}.`,
          },
        ],
        details: {
          savedType: params.type,
          currentPhase: state.currentPhase,
          qualityScore: quality.score,
          missingFields: fieldCheck.missingFields,
          phaseAdvanced: phaseChanged,
        },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | { savedType?: string; currentPhase?: string }
        | undefined;
      const label = artifactLabel(d?.savedType ?? "");
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
      const stored = state.artifacts[params.type];
      // Distinguish "key not present in artifacts at all" from "key present
      // but value is an empty / whitespace-only string". The former is the
      // normal not-yet-saved case; the latter is almost always the result
      // of a hand-edit of state.json and deserves a different message.
      const hasKey = Object.prototype.hasOwnProperty.call(
        state.artifacts,
        params.type,
      );
      const trimmed = stored?.trim() ?? "";
      const available = LEAN_ARTIFACT_KEYS.filter(
        (k) => Boolean(state.artifacts[k]) && state.artifacts[k]!.trim().length > 0,
      );
      if (!stored) {
        const availableMsg =
          available.length > 0
            ? ` Available artifacts: ${available.join(", ")}.`
            : " No artifacts saved yet.";
        return {
          content: [
            {
              type: "text",
              text: `⚠️ No artifact "${params.type}" found.${availableMsg}`,
            },
          ],
          details: {
            found: false,
            reason: "missing",
            type: params.type,
            available,
          },
        };
      }
      if (trimmed.length === 0) {
        // Key exists but content is blank — surface this explicitly so the
        // LLM knows the file is corrupt rather than missing.
        return {
          content: [
            {
              type: "text",
              text: `⚠️ Artifact "${params.type}" exists but is empty (likely a hand-edit). Re-save it via lean_save_artifact.`,
            },
          ],
          details: {
            found: false,
            reason: hasKey ? "empty" : "missing",
            type: params.type,
            available,
          },
        };
      }
      return {
        content: [{ type: "text", text: stored }],
        details: { found: true, type: params.type, length: stored.length },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | { found?: boolean; type?: string; length?: number }
        | undefined;
      if (!d?.found) return new Text(theme.fg("error", "✗ Not found"), 0, 0);
      const label = artifactLabel(d.type ?? "");
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
      const { state, result: previous } = await withState(ctx.cwd, (s) => {
        const prev = s.currentPhase;
        // Idempotent: avoid spamming history with no-op transitions when the
        // LLM re-asserts the current phase. The widget still refreshes below,
        // so any stale UI is corrected.
        if (prev === params.phase) {
          return prev;
        }
        transitionPhase(s, params.phase);
        s.history.push({
          phase: params.phase,
          timestamp: Date.now(),
          note: params.note ?? `From ${prev} to ${params.phase}`,
        });
        return prev;
      });
      // No-op case: refresh widget silently (no toast), then return the info
      // payload. The previous version always toasted, which spammed the UI
      // when the LLM re-asserted the current phase between turns.
      if (previous === params.phase) {
        updatePhaseStatus(ctx, params.phase, state, { notify: false });
        return {
          content: [
            {
              type: "text",
              text: `ℹ️ Already in: ${phaseLabel(params.phase)}. No change.`,
            },
          ],
          details: { previous, current: params.phase, noop: true },
        };
      }
      updatePhaseStatus(ctx, params.phase, state);

      // Soft warning when the user jumps to a phase whose prerequisite
      // artifact is missing — the move is still allowed (escape hatch by
      // design), but worth flagging so the agent doesn't operate blind.
      const requiredArtifact: Partial<Record<LeanPhase, LeanArtifactKey>> = {
        plan: "clarifiedProduct",
        implement: "actionPlan",
        review: "actionPlan",
      };
      const need = requiredArtifact[params.phase];
      const warning =
        need && !state.artifacts[need]
          ? ` ⚠️ No ${ARTIFACT_NAMES[need]} present — the agent may lack context.`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `✅ Phase: ${phaseLabel(previous)} → ${phaseLabel(params.phase)}.${warning}`,
          },
        ],
        details: { previous, current: params.phase, warning: warning.trim() || undefined },
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
      "Manage tasks. Actions: list, add, toggle (done/undone), edit, remove, clear.",
    promptSnippet: "Manage implementation tasks",
    parameters: Type.Object({
      action: StringEnum([
        "list",
        "add",
        "toggle",
        "edit",
        "remove",
        "clear",
      ] as const),
      description: Type.Optional(
        Type.String({
          description: "Task description (required for add; optional for edit)",
        }),
      ),
      acceptanceCriteria: Type.Optional(
        Type.String({ description: "Acceptance criteria (optional)" }),
      ),
      notes: Type.Optional(
        Type.String({ description: "Technical notes (optional)" }),
      ),
      taskId: Type.Optional(
        Type.Number({
          description: "Task ID (required for toggle, edit, remove)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "list": {
          const state = await loadState(ctx.cwd);
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
              },
            };
          }
          const { state, result: newTask } = await withState(ctx.cwd, (s) => {
            const maxId = s.tasks.reduce((m, t) => Math.max(m, t.id), 0);
            const t = {
              id: maxId + 1,
              description: params.description!,
              acceptanceCriteria: params.acceptanceCriteria ?? "",
              notes: params.notes ?? "",
              done: false,
            };
            s.tasks.push(t);
            return t;
          });
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
              },
            };
          }

          interface ToggleOutcome {
            task: { id: number; description: string; done: boolean } | null;
            transition: ReturnType<typeof computePhaseAfterTaskToggle>;
            allDone: boolean;
            error?: string;
          }

          const { state, result } = await withState<ToggleOutcome>(ctx.cwd, (s) => {
            const t = s.tasks.find((x) => x.id === params.taskId);
            if (!t) {
              return {
                task: null,
                transition: { nextPhase: null, reason: null },
                allDone: false,
                error: "not found",
              };
            }
            t.done = !t.done;
            const transition = computePhaseAfterTaskToggle(s.currentPhase, s.tasks, t.done);
            const allDone = s.tasks.length > 0 && s.tasks.every((x) => x.done);
            if (transition.nextPhase) {
              const note =
                transition.reason === "all-tasks-completed"
                  ? "All tasks completed — auto-transition to review"
                  : `Task #${t.id} reopened — reverted to implement`;
              transitionPhase(s, transition.nextPhase);
              s.history.push({
                phase: transition.nextPhase,
                timestamp: Date.now(),
                note,
              });
              dbg(`auto phase transition: ${transition.reason} → ${transition.nextPhase}`);
            }
            return { task: t, transition, allDone };
          });

          if (result.error || !result.task) {
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
          const status = result.task.done ? "completed" : "reopened";
          let allDoneMsg = "";
          if (result.transition.reason === "all-tasks-completed") {
            allDoneMsg =
              "\n🎯 All tasks completed! Phase advanced to: 🔍 Review. Use /skill:lean-review for the final review.";
          }
          updatePhaseStatus(ctx, state.currentPhase, state, {
            notify: Boolean(result.transition.nextPhase),
          });
          return {
            content: [
              {
                type: "text",
                text: `✅ Task #${result.task.id} ${status}: ${result.task.description}${allDoneMsg}`,
              },
            ],
            details: {
              action: "toggle",
              tasks: state.tasks,
              allDone: result.allDone,
              task: result.task,
            },
          };
        }

        case "edit": {
          if (params.taskId === undefined) {
            return {
              content: [{ type: "text", text: "Error: taskId required for edit." }],
              details: { action: "edit", error: "taskId required" },
            };
          }
          // At least one editable field must be supplied — otherwise the edit
          // would be a no-op and silently mislead the caller into thinking
          // they updated something.
          if (
            params.description === undefined &&
            params.acceptanceCriteria === undefined &&
            params.notes === undefined
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: edit requires at least one of description, acceptanceCriteria, or notes.",
                },
              ],
              details: { action: "edit", error: "no fields to update" },
            };
          }

          const { state, result } = await withState<{
            task: { id: number; description: string; done: boolean } | null;
          }>(ctx.cwd, (s) => {
            const t = s.tasks.find((x) => x.id === params.taskId);
            if (!t) return { task: null };
            if (params.description !== undefined) t.description = params.description;
            if (params.acceptanceCriteria !== undefined)
              t.acceptanceCriteria = params.acceptanceCriteria;
            if (params.notes !== undefined) t.notes = params.notes;
            return { task: t };
          });

          if (!result.task) {
            return {
              content: [
                { type: "text", text: `Task #${params.taskId} not found.` },
              ],
              details: {
                action: "edit",
                error: "not found",
                tasks: state.tasks,
              },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `✏️ Task #${result.task.id} updated: ${result.task.description}`,
              },
            ],
            details: { action: "edit", tasks: state.tasks, task: result.task },
          };
        }

        case "remove": {
          if (params.taskId === undefined) {
            return {
              content: [{ type: "text", text: "Error: taskId required for remove." }],
              details: { action: "remove", error: "taskId required" },
            };
          }

          interface RemoveOutcome {
            removed: { id: number; description: string } | null;
            transition: ReturnType<typeof computePhaseAfterTaskRemove>;
          }

          const { state, result } = await withState<RemoveOutcome>(ctx.cwd, (s) => {
            const idx = s.tasks.findIndex((x) => x.id === params.taskId);
            if (idx === -1) {
              return { removed: null, transition: { nextPhase: null, reason: null } };
            }
            const [t] = s.tasks.splice(idx, 1);
            // Use the dedicated remove transition: removing tasks can only
            // advance (implement → review), never revert. Previously this
            // path borrowed computePhaseAfterTaskToggle with a synthetic
            // `toggledTaskNowDone: true` — same outcome but unclear intent.
            const transition = computePhaseAfterTaskRemove(
              s.currentPhase,
              s.tasks,
            );
            if (transition.nextPhase) {
              transitionPhase(s, transition.nextPhase);
              s.history.push({
                phase: transition.nextPhase,
                timestamp: Date.now(),
                note:
                  transition.reason === "all-tasks-completed"
                    ? `Task #${t.id} removed — all remaining tasks done, auto-transition to review`
                    : `Task #${t.id} removed`,
              });
            }
            return {
              removed: { id: t.id, description: t.description },
              transition,
            };
          });

          if (!result.removed) {
            return {
              content: [
                { type: "text", text: `Task #${params.taskId} not found.` },
              ],
              details: {
                action: "remove",
                error: "not found",
                tasks: state.tasks,
              },
            };
          }
          updatePhaseStatus(ctx, state.currentPhase, state, {
            notify: Boolean(result.transition.nextPhase),
          });
          return {
            content: [
              {
                type: "text",
                text: `🗑️ Task #${result.removed.id} removed: ${result.removed.description}`,
              },
            ],
            details: {
              action: "remove",
              tasks: state.tasks,
              task: result.removed,
            },
          };
        }

        case "clear": {
          const { state, result: count } = await withState(ctx.cwd, (s) => {
            const n = s.tasks.length;
            s.tasks = [];
            return n;
          });
          return {
            content: [{ type: "text", text: `🗑️ ${count} task(s) cleared.` }],
            details: { action: "clear", tasks: state.tasks },
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
      if (d?.action === "edit" && d.task)
        return new Text(
          theme.fg("warning", "✏ ") +
            theme.fg("accent", `#${d.task.id}`) +
            theme.fg("dim", ` ${d.task.description}`),
          0,
          0,
        );
      if (d?.action === "remove" && d.task)
        return new Text(
          theme.fg("warning", "🗑 ") + theme.fg("accent", `#${d.task.id}`),
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
      score: Type.Number({
        description: "Quality score 1-10",
        minimum: 1,
        maximum: 10,
      }),
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
      // Defensive: TypeBox doesn't reject NaN/Infinity from the LLM, so clamp
      // to a finite value in [1,10] before persisting.
      const score = clampScore(params.score);

      // Cap the size of free-text fields. A runaway LLM rationale or a
      // 1000-item suggestion list would bloat state.json and choke the
      // dashboard. We truncate silently but tag the eval with `truncated:
      // true` so downstream consumers can flag it without scanning for the
      // ellipsis marker in the body.
      const rationaleCap = maxRationaleChars(ctx.cwd);
      const suggestionCap = maxSuggestionChars(ctx.cwd);
      const suggestionLimit = maxSuggestions(ctx.cwd);
      let truncated = false;
      const rationale =
        params.rationale.length > rationaleCap
          ? ((truncated = true),
            params.rationale.slice(0, rationaleCap) + "…[truncated]")
          : params.rationale;
      const rawSuggestions = params.suggestions ?? [];
      if (rawSuggestions.length > suggestionLimit) truncated = true;
      const suggestions = rawSuggestions
        .slice(0, suggestionLimit)
        .map((s: string) => {
          if (s.length > suggestionCap) {
            truncated = true;
            return s.slice(0, suggestionCap) + "…[truncated]";
          }
          return s;
        });

      const {
        result: { artifactMissing },
      } = await withState(ctx.cwd, (s) => {
        const missing = !s.artifacts[params.artifactType];
        const evaluation: LeanEvaluation = {
          phase: s.currentPhase,
          artifactType: params.artifactType,
          score,
          rationale,
          suggestions,
          timestamp: Date.now(),
          source: "llm",
          truncated: truncated || undefined,
          // Tag the entry so /lean-quality and any dashboard can choose to
          // filter ghost evaluations out. We still record them — the LLM
          // may legitimately be scoring a draft — but downstream consumers
          // should know they're untethered from a saved artifact.
          orphan: missing,
        };
        s.evaluations.push(evaluation);
        return { artifactMissing: missing };
      });

      const artifactLabel =
        ARTIFACT_LABELS[params.artifactType] ?? params.artifactType;
      const scoreEmoji = score >= 7 ? "✅" : score >= 4 ? "⚠️" : "❌";
      // Warn the caller when they are scoring an artifact that hasn't been
      // saved yet — the evaluation will still be recorded (the LLM might
      // legitimately be reviewing a draft), but the dashboard would
      // otherwise show a score for nothing.
      const missingWarning = artifactMissing
        ? `\n\n⚠️ Note: no "${params.artifactType}" artifact is currently saved — this evaluation has no content to point at.`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `${scoreEmoji} ${artifactLabel} — Score: ${score}/10\n\n${rationale}${suggestions.length > 0 ? `\n\nSuggestions:\n${suggestions.map((s: string) => `  - ${s}`).join("\n")}` : ""}${missingWarning}`,
          },
        ],
        details: {
          artifactType: params.artifactType,
          score,
          rationale,
          suggestions,
          artifactMissing,
        },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | { artifactType?: string; score?: number }
        | undefined;
      if (!d) return new Text("", 0, 0);
      const label = artifactLabel(d.artifactType ?? "");
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
      "Supports: compile (npm run build / compile), lint (npm run lint), " +
      "test (npm test), typecheck (tsc --noEmit), " +
      "format (prefers `format:check` / prettier --check; falls back to " +
      "`format` which may rewrite files in some projects). " +
      "Use after implementation tasks to validate changes. " +
      "A status of 'skipped' means no tool is configured for this project — treat it as a soft pass.",
    promptSnippet:
      "Run project validation checks (compile, lint, test, typecheck, format)",
    promptGuidelines: [
      "Use lean_run_checks after completing implementation tasks to validate changes.",
      "Run 'compile' first to ensure the project builds.",
      "Run 'typecheck' to verify TypeScript types resolve (skipped if no tsconfig.json).",
      "Run 'test' to verify existing tests still pass.",
      "Run 'lint' to check code style; 'format' to check formatter compliance.",
      "A status of 'skipped' means no tool is configured — treat it as a soft pass.",
    ],
    parameters: Type.Object({
      // Single source of truth: read the supported set from gate.ts so a
      // future check type added there is automatically exposed via the tool
      // without a duplicated allowlist here.
      checkType: StringEnum(SUPPORTED_CHECK_TYPES),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runExternalCheck(params.checkType, ctx.cwd);

      // Tri-state status drives the icon + label. Fall back to the legacy
      // boolean fields if `status` is missing (defensive — runExternalCheck
      // always sets it now).
      const status =
        result.status ??
        (result.skipped ? "skipped" : result.passed ? "passed" : "failed");
      const statusIcon =
        status === "skipped" ? "⏭️" : status === "passed" ? "✅" : "❌";
      const statusLabel = status.toUpperCase();
      const output = result.output.slice(0, maxCheckOutputChars(ctx.cwd));
      const errors = result.errors
        .join("\n")
        .slice(0, maxCheckErrorChars(ctx.cwd));

      let text = `${statusIcon} ${params.checkType}: ${statusLabel} (${result.durationMs}ms)\n`;
      if (output) text += `\nOutput:\n${output}\n`;
      if (errors) text += `\nErrors:\n${errors}\n`;

      return {
        content: [{ type: "text", text }],
        details: {
          checkType: params.checkType,
          status,
          passed: result.passed,
          skipped: result.skipped ?? false,
          output: result.output,
          errors: result.errors,
          durationMs: result.durationMs,
        },
      };
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | {
            checkType?: string;
            status?: "passed" | "failed" | "skipped";
            passed?: boolean;
            skipped?: boolean;
            durationMs?: number;
          }
        | undefined;
      if (!d) return new Text("", 0, 0);
      // Prefer tri-state; fall back to booleans for older render contexts.
      const status =
        d.status ?? (d.skipped ? "skipped" : d.passed ? "passed" : "failed");
      const icon =
        status === "skipped"
          ? theme.fg("warning", "⏭")
          : status === "passed"
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
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
    description:
      "Generate a quality report for a saved artifact. " +
      "Optional arg: clarifiedProduct | actionPlan | reviewReport. " +
      "Defaults to the most recently saved artifact.",
    handler: async (args, ctx) => {
      const state = await loadState(ctx.cwd);
      const artifactKeys = (Object.keys(state.artifacts) as LeanArtifactKey[]).filter(
        (k) => Boolean(state.artifacts[k]),
      );

      if (artifactKeys.length === 0) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No artifacts present. Complete at least one phase.",
            "warning",
          );
        return;
      }

      // Explicit arg → validate. Otherwise fall back to `lastSavedArtifact`
      // recorded at save time (object-key order is *not* a reliable proxy for
      // "most recent"). If that field is unset for any reason, pick the
      // artifact whose phase matches the current workflow phase.
      const requestedKey = args?.trim();
      let targetKey: LeanArtifactKey | null = null;

      if (requestedKey) {
        if (isLeanArtifactKey(requestedKey)) {
          targetKey = requestedKey;
        } else {
          if (ctx.hasUI)
            ctx.ui.notify(
              `Unknown artifact "${requestedKey}". Valid: ${LEAN_ARTIFACT_KEYS.join(", ")}. Falling back to most recent.`,
              "warning",
            );
        }
      }

      if (!targetKey && state.lastSavedArtifact && state.artifacts[state.lastSavedArtifact]) {
        targetKey = state.lastSavedArtifact;
      }

      if (!targetKey) {
        const phaseDefault: Record<LeanPhase, LeanArtifactKey> = {
          brainstorm: "clarifiedProduct",
          plan: "actionPlan",
          implement: "actionPlan",
          review: "reviewReport",
          done: "reviewReport",
        };
        const preferred = phaseDefault[state.currentPhase];
        targetKey = state.artifacts[preferred]
          ? preferred
          : artifactKeys[artifactKeys.length - 1];
      }

      const targetContent = state.artifacts[targetKey];
      if (!targetContent) {
        if (ctx.hasUI)
          ctx.ui.notify(`No artifact "${targetKey}" saved yet.`, "warning");
        return;
      }

      dbg(`lean-quality: reporting on artifact "${targetKey}"`);

      // Only the LLM self-evaluation is interesting for the quality report —
      // the auto-heuristic is already surfaced by `report.heuristicScore`.
      // Including it as `selfEvaluation` would have shown the same numbers
      // twice and mislabelled the source. We also skip `orphan` evals
      // (recorded against drafts) so the report reflects the saved artifact.
      const targetEvaluation = [...state.evaluations]
        .reverse()
        .find(
          (e) =>
            e.artifactType === targetKey &&
            e.source === "llm" &&
            !e.orphan,
        );

      const report = generateQualityReport(
        targetKey,
        targetContent,
        targetEvaluation
          ? {
              score: targetEvaluation.score,
              rationale: targetEvaluation.rationale,
              suggestions: targetEvaluation.suggestions,
            }
          : undefined,
      );

      const formatted = formatQualityReport(report);

      if (ctx.hasUI) {
        // Prefer the richer LLM self-evaluation score when available;
        // fall back to the heuristic baseline.
        const displayScore =
          targetEvaluation?.score ?? report.heuristicScore.score;
        const scoreSource = targetEvaluation ? "self-eval" : "auto";
        ctx.ui.notify(
          `${report.artifactName}: ${displayScore}/10 (${scoreSource})`,
          "info",
        );
        ctx.ui.setEditorText(formatted);
      }
    },
  });

  // ── Command: /lean-status ──────────────────────────────────────────────────

  pi.registerCommand("lean-status", {
    description:
      "Show the current Lean Flow phase, artifacts, task progress, and quality scores. Pass --json for a machine-readable dump.",
    handler: async (args, ctx) => {
      const state = await loadState(ctx.cwd);
      const wantJson = args?.trim() === "--json";
      if (wantJson) {
        // Strip artifact bodies — they can be huge — and keep just counts +
        // lengths. CI / external scripts care about the structure, not the
        // markdown bodies.
        const artifactSummary: Record<string, number> = {};
        for (const key of LEAN_ARTIFACT_KEYS) {
          const c = state.artifacts[key];
          if (c) artifactSummary[key] = c.length;
        }
        const done = state.tasks.filter((t) => t.done).length;
        const coherenceIssues = computeCoherenceIssues(state);
        // Orphan evaluations: surface the artifact types so a CI script can
        // alert ("foo was scored but never saved"). Count alone hides which
        // artifact is in the weird state.
        const orphanList = state.evaluations
          .filter((e) => e.orphan)
          .map((e) => e.artifactType);
        const orphanArtifacts = Array.from(new Set(orphanList));
        // Size of the on-disk state.json. Useful as a bloat indicator on
        // long-running projects. `statSync` is imported at the top of the
        // module — no dynamic import here.
        let stateFileBytes = 0;
        try {
          stateFileBytes = statSync(
            join(ctx.cwd, ".pi-lean-flow", "state.json"),
          ).size;
        } catch {
          // file may not exist yet; leave at 0
        }
        const json = JSON.stringify(
          {
            version: state.version,
            currentPhase: state.currentPhase,
            currentPhaseLabel: phaseLabel(state.currentPhase),
            tasks: { total: state.tasks.length, done },
            artifacts: artifactSummary,
            lastSavedArtifact: state.lastSavedArtifact,
            evaluations: {
              total: state.evaluations.length,
              auto: state.evaluations.filter((e) => e.source === "auto").length,
              llm: state.evaluations.filter((e) => e.source === "llm").length,
              orphan: state.evaluations.filter((e) => e.orphan).length,
              orphanArtifacts,
            },
            history: { total: state.history.length },
            coherence: {
              ok: coherenceIssues.length === 0,
              issues: coherenceIssues,
              acked: isCoherenceAcked(state),
            },
            storage: { stateFileBytes },
          },
          null,
          2,
        );
        if (ctx.hasUI) {
          ctx.ui.notify(`lean-status: ${state.currentPhase}`, "info");
          ctx.ui.setEditorText(json);
        }
        return;
      }
      // Enrich the textual status with the same coherence + storage info
      // /lean-status --json exposes, so users on the non-JSON path don't
      // miss them.
      let stateFileBytes = 0;
      try {
        stateFileBytes = statSync(
          join(ctx.cwd, ".pi-lean-flow", "state.json"),
        ).size;
      } catch {
        // state file may not exist yet
      }
      const report = formatStatus(state, {
        stateFileBytes,
        coherenceIssues: computeCoherenceIssues(state),
      });
      if (ctx.hasUI) {
        ctx.ui.notify(report.split("\n")[0], "info");
        ctx.ui.setEditorText(report);
      }
    },
  });

  // ── Command: /lean-export ──────────────────────────────────────────────────

  pi.registerCommand("lean-export", {
    description:
      "Export saved artifacts as Markdown files under .pi-lean-flow/exports/, plus a full state.json snapshot.",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);
      const exportDir = join(ctx.cwd, ".pi-lean-flow", "exports");
      await mkdir(exportDir, { recursive: true });

      // Atomic write helper: stage the content in a sibling `.tmp` file and
      // rename it into place. A crash between write and rename leaves the
      // temp behind (caller can clean up) but never a half-written export.
      const atomicWrite = async (file: string, content: string) => {
        const tmp = `${file}.tmp`;
        await writeFile(tmp, content, "utf-8");
        try {
          await rename(tmp, file);
        } catch (err) {
          try {
            await unlink(tmp);
          } catch {
            // best-effort cleanup
          }
          throw err;
        }
      };

      const written: string[] = [];
      for (const key of LEAN_ARTIFACT_KEYS) {
        const content = state.artifacts[key];
        if (!content) continue;
        const file = join(exportDir, `${key}.md`);
        await atomicWrite(file, content);
        written.push(file);
      }

      // Full state snapshot — needed to round-trip tasks, evaluations,
      // history, etc., which the artifact-only export drops on the floor.
      const snapshotFile = join(exportDir, "state.json");
      await atomicWrite(snapshotFile, JSON.stringify(state, null, 2));
      written.push(snapshotFile);

      if (ctx.hasUI) {
        if (written.length === 1) {
          // only the snapshot was written
          ctx.ui.notify(
            "No artifacts to export — saved state snapshot only.",
            "warning",
          );
        } else {
          ctx.ui.notify(
            `Exported ${written.length - 1} artifact(s) + state.json to .pi-lean-flow/exports/`,
            "info",
          );
        }
      }
    },
  });

  // ── Command: /lean-import ──────────────────────────────────────────────────

  pi.registerCommand("lean-import", {
    description:
      "Import artifacts from .pi-lean-flow/exports/*.md back into the state. " +
      "File name (minus .md) must match an artifact key. " +
      "Pass --dry-run to inspect what would happen without writing.",
    handler: async (args, ctx) => {
      const dryRun = (args ?? "").trim().split(/\s+/).includes("--dry-run");
      const exportDir = join(ctx.cwd, ".pi-lean-flow", "exports");
      if (!existsSync(exportDir)) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No exports directory. Run /lean-export first.",
            "warning",
          );
        return;
      }

      const files = await readdir(exportDir);

      // Build the list of importable .md artifacts first so we can mutate
      // state inside a single withState call (atomic with concurrent tools).
      //
      // IMPORTANT: iterate the canonical LEAN_ARTIFACT_KEYS order rather than
      // the order returned by readdir(). readdir is platform-dependent (FS-
      // specific), so iterating it could leave `lastSavedArtifact` set to any
      // of the imported keys, making the post-import phase hint
      // non-deterministic. Following the canonical order means the *last*
      // saved artifact is always the latest one in the workflow sequence.
      type ImportEntry = { key: LeanArtifactKey; content: string; file: string };
      const fileSet = new Set(files);
      const entries: ImportEntry[] = [];
      // Two distinct skip reasons — surfaced separately because they mean
      // different things to the user.
      const empty: string[] = [];
      const unknown: string[] = [];
      const invalidContent: string[] = [];

      for (const key of LEAN_ARTIFACT_KEYS) {
        const f = `${key}.md`;
        if (!fileSet.has(f)) continue;
        const content = await readFile(join(exportDir, f), "utf-8");
        if (content.trim().length === 0) {
          empty.push(f);
          continue;
        }
        // V1 sanity check on the imported content. We *do* import even if
        // fields are missing (the user may want to fix the file from inside
        // pi.dev), but we surface a warning so they don't silently overwrite
        // a good state with a broken file.
        const fieldCheck = checkRequiredFields(key, content);
        if (!fieldCheck.isValid) {
          invalidContent.push(`${f} (missing: ${fieldCheck.missingFields.join(", ")})`);
        }
        entries.push({ key, content, file: f });
      }

      // Any .md file that doesn't match a known artifact key is reported.
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const key = f.slice(0, -3);
        if (!isLeanArtifactKey(key)) {
          unknown.push(f);
        }
      }

      // Dry-run: skip the write step entirely. We still report what would
      // have been imported (and any invalid/empty/unknown findings), so the
      // user can audit before committing.
      if (dryRun) {
        if (!ctx.hasUI) return;
        const lines = [
          `# Lean Import — DRY RUN (no changes written)`,
          "",
          `Would import: ${entries.length} artifact(s).`,
        ];
        for (const e of entries) {
          lines.push(`  • ${e.key} from ${e.file} (${e.content.length} chars)`);
        }
        if (invalidContent.length > 0) {
          lines.push("", `Would import with field-check warnings:`);
          for (const c of invalidContent) lines.push(`  • ${c}`);
        }
        if (empty.length > 0) {
          lines.push("", `Would skip (empty): ${empty.join(", ")}`);
        }
        if (unknown.length > 0) {
          lines.push("", `Would skip (unknown): ${unknown.join(", ")}`);
        }
        ctx.ui.notify(
          `Dry-run: would import ${entries.length} artifact(s).`,
          "info",
        );
        ctx.ui.setEditorText(lines.join("\n"));
        return;
      }

      const { state, result: imported } = await withState(ctx.cwd, (s) => {
        for (const e of entries) {
          s.artifacts[e.key] = e.content;
          s.lastSavedArtifact = e.key;
        }
        if (entries.length > 0) {
          s.history.push({
            phase: s.currentPhase,
            timestamp: Date.now(),
            note: `Imported ${entries.length} artifact(s) from exports/`,
          });
        }
        return entries.length;
      });

      // Suggest a sane phase if the import looks inconsistent with the
      // current one. We don't auto-rewrite — give the user a heads-up.
      let phaseHint = "";
      if (imported > 0 && state.lastSavedArtifact) {
        const expected = ARTIFACT_TO_PHASE[state.lastSavedArtifact];
        if (state.currentPhase !== expected && state.currentPhase !== suggestNextPhase(expected)) {
          phaseHint = ` ⚠️ Current phase is ${phaseLabel(state.currentPhase)} but the latest imported artifact belongs to ${phaseLabel(expected)}. Use lean_set_phase to align.`;
        }
      }

      if (ctx.hasUI) {
        // Cap the notify message. Full breakdown — including the two
        // distinct skip categories (empty vs unknown) — goes to the editor.
        const emptyLabel =
          empty.length > 0
            ? ` · ${empty.length} empty`
            : "";
        const unknownLabel =
          unknown.length > 0
            ? ` · ${unknown.length} unknown`
            : "";
        const invalidLabel =
          invalidContent.length > 0
            ? ` · ${invalidContent.length} with missing fields (see editor)`
            : "";
        ctx.ui.notify(
          `Imported ${imported} artifact(s)${emptyLabel}${unknownLabel}${invalidLabel}${phaseHint}`,
          imported > 0 ? "info" : "warning",
        );
        if (
          invalidContent.length > 0 ||
          empty.length > 0 ||
          unknown.length > 0
        ) {
          const lines: string[] = [`# Lean Import report`, ""];
          if (invalidContent.length > 0) {
            lines.push(`## Field-check warnings (${invalidContent.length})`);
            lines.push(
              "Imported but missing required sections — fix the body and re-import.",
            );
            lines.push("");
            for (const c of invalidContent) lines.push(`- ${c}`);
            lines.push("");
          }
          if (empty.length > 0) {
            lines.push(`## Empty files (${empty.length})`);
            lines.push("Files with no content — nothing was imported from them.");
            lines.push("");
            for (const f of empty) lines.push(`- ${f}`);
            lines.push("");
          }
          if (unknown.length > 0) {
            lines.push(`## Unknown artifact names (${unknown.length})`);
            lines.push(
              `Valid file names: ${LEAN_ARTIFACT_KEYS.map((k) => `${k}.md`).join(", ")}`,
            );
            lines.push("");
            for (const f of unknown) lines.push(`- ${f}`);
          }
          ctx.ui.setEditorText(lines.join("\n"));
        }
      }
    },
  });

  // ── Command: /lean-next ────────────────────────────────────────────────────

  pi.registerCommand("lean-next", {
    description:
      "Suggest the next skill to invoke based on the current phase.",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);
      const phase = state.currentPhase;
      const hint = PHASE_DESCRIPTIONS[phase];
      const message = `Phase: ${phaseLabel(phase)} — ${hint}`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
        ctx.ui.setEditorText(message);
      }
    },
  });

  // ── Command: /lean-task ────────────────────────────────────────────────────

  pi.registerCommand("lean-task", {
    description:
      "Show full details of a single task. Usage: /lean-task <id>",
    handler: async (args, ctx) => {
      const state = await loadState(ctx.cwd);
      const idStr = args?.trim();
      if (!idStr) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /lean-task <id>", "warning");
        }
        return;
      }
      const id = Number(idStr);
      if (!Number.isInteger(id)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Invalid task id: "${idStr}"`, "warning");
        }
        return;
      }
      const task = state.tasks.find((t) => t.id === id);
      if (!task) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Task #${id} not found.`, "warning");
        }
        return;
      }
      const lines: string[] = [];
      lines.push(`# Task #${task.id} ${task.done ? "✅" : "⏳"}`);
      lines.push("");
      lines.push(`**Description:** ${task.description}`);
      if (task.acceptanceCriteria) {
        lines.push("");
        lines.push(`**Acceptance criteria:** ${task.acceptanceCriteria}`);
      }
      if (task.notes) {
        lines.push("");
        lines.push(`**Notes:** ${task.notes}`);
      }
      // Soft hint at the bottom: this command is read-only, so make the
      // companion edit/remove commands discoverable from here.
      lines.push("");
      lines.push("---");
      lines.push(
        `To modify: \`/lean-task-edit ${task.id} description=… criteria=… notes=…\` · ` +
          `to remove: \`/lean-task-remove ${task.id}\``,
      );
      const text = lines.join("\n");
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Task #${task.id}: ${task.done ? "done" : "pending"}`,
          "info",
        );
        ctx.ui.setEditorText(text);
      }
    },
  });

  // ── Command: /lean-audit ───────────────────────────────────────────────────

  pi.registerCommand("lean-audit", {
    description:
      "Show recent entries from .pi-lean-flow/audit.log. " +
      "Usage: /lean-audit [N] [--full] [--json] [--grep <pattern>] [--since <iso-date>] [--status passed|failed|skipped]. " +
      "N defaults to 20. --full keeps long commands. --json emits raw JSON Lines (in which case --full is implied). " +
      "--grep accepts shell-style double or single quotes (e.g. --grep \"npm test\"). " +
      "--since matches entries with timestamp >= the given ISO date. " +
      "--status filters by check outcome.",
    handler: async (args, ctx) => {
      const rawArgs = (args ?? "").trim();
      // Shell-style tokenisation: respect double- and single-quoted runs so
      // --grep "foo bar" doesn't get split. We do NOT handle escapes; if
      // the user needs a literal quote in the pattern, they should pick the
      // other quote style.
      const tokens: string[] = [];
      const tokenRegex = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let tm: RegExpExecArray | null;
      while ((tm = tokenRegex.exec(rawArgs)) !== null) {
        tokens.push(tm[1] ?? tm[2] ?? tm[3] ?? "");
      }
      let tailN = 20;
      let wantFull = false;
      let wantJson = false;
      let grepPattern: RegExp | null = null;
      let sinceTs: number | null = null;
      let statusFilter: "passed" | "failed" | "skipped" | null = null;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "--full") wantFull = true;
        else if (t === "--json") wantJson = true;
        else if (t === "--grep") {
          const pat = tokens[i + 1];
          if (pat) {
            try {
              grepPattern = new RegExp(pat, "i");
            } catch {
              const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              grepPattern = new RegExp(escaped, "i");
            }
            i += 1;
          }
        } else if (t === "--since") {
          const candidate = tokens[i + 1];
          if (candidate) {
            const parsed = Date.parse(candidate);
            if (Number.isFinite(parsed)) {
              sinceTs = parsed;
            } else if (ctx.hasUI) {
              ctx.ui.notify(
                `Invalid --since value "${candidate}". Use ISO 8601 (e.g. 2026-05-21T10:00:00Z).`,
                "warning",
              );
              return;
            }
            i += 1;
          }
        } else if (t === "--status") {
          const candidate = tokens[i + 1];
          if (
            candidate === "passed" ||
            candidate === "failed" ||
            candidate === "skipped"
          ) {
            statusFilter = candidate;
            i += 1;
          } else if (ctx.hasUI) {
            ctx.ui.notify(
              `Invalid --status value "${candidate ?? "(missing)"}". Use passed | failed | skipped.`,
              "warning",
            );
            return;
          }
        } else if (/^\d+$/.test(t)) {
          const n = Number(t);
          if (n > 0) tailN = n;
        }
      }

      const logPath = join(ctx.cwd, ".pi-lean-flow", "audit.log");
      if (!existsSync(logPath)) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No audit log yet — run lean_run_checks to produce one.",
            "warning",
          );
        return;
      }
      // The log is JSON Lines: we read the whole file, split by newlines,
      // and tail the last N entries. It's bounded by MAX_AUDIT_BYTES so the
      // full read is cheap.
      const raw = await readFile(logPath, "utf-8");
      let lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const totalBefore = lines.length;
      if (grepPattern) {
        lines = lines.filter((l) => grepPattern!.test(l));
      }
      // --since / --status operate on the parsed JSON. Lines that fail to
      // parse are kept (they're already legible enough as raw text).
      if (sinceTs !== null || statusFilter !== null) {
        lines = lines.filter((l) => {
          try {
            const obj = JSON.parse(l);
            if (sinceTs !== null) {
              const ts = Date.parse(obj.timestamp);
              if (!Number.isFinite(ts) || ts < sinceTs) return false;
            }
            if (statusFilter !== null && obj.status !== statusFilter) {
              return false;
            }
            return true;
          } catch {
            // Malformed line — let it through so the user still sees it.
            return true;
          }
        });
      }
      const tail = lines.slice(-tailN);

      if (ctx.hasUI) {
        if (wantJson) {
          // Raw JSON Lines — already redacted at write time. `--full` is
          // implicit here (the body is verbatim) so we don't need to
          // special-case it.
          ctx.ui.notify(
            `Audit: ${tail.length} / ${lines.length} matched of ${totalBefore} total`,
            "info",
          );
          ctx.ui.setEditorText(tail.join("\n") + "\n");
          return;
        }
        const display = tail
          .map((line) => {
            try {
              const obj = JSON.parse(line);
              const { timestamp, checkType, status, durationMs, command } = obj;
              // Defence in depth: redact again on display, in case the file
              // was hand-edited or grew before the redactor was introduced.
              const safeCmd =
                typeof command === "string"
                  ? redactCommand(command)
                  : command ?? "(no command)";
              const cmd =
                !wantFull && typeof safeCmd === "string" && safeCmd.length > 60
                  ? safeCmd.slice(0, 57) + "…"
                  : safeCmd;
              return `${timestamp}  ${status?.toUpperCase().padEnd(8)} ${checkType?.padEnd(10)} ${durationMs ?? 0}ms  ${cmd}`;
            } catch {
              return line;
            }
          })
          .join("\n");
        ctx.ui.notify(
          `Audit: showing ${tail.length} / ${lines.length}${grepPattern ? ` matched of ${totalBefore}` : ""} entries`,
          "info",
        );
        const header = grepPattern
          ? `# Audit log (filtered: last ${tail.length} of ${lines.length} matching ${totalBefore} total)`
          : `# Audit log (last ${tail.length} of ${lines.length})`;
        ctx.ui.setEditorText(`${header}\n\n${display}\n`);
      }
    },
  });

  // ── Command: /lean-history ─────────────────────────────────────────────────

  pi.registerCommand("lean-history", {
    description:
      "Show the recorded phase history. " +
      "Usage: /lean-history [N] [--phase <name>]. " +
      "N defaults to 20. --phase filters to a single phase (brainstorm | plan | implement | review | done).",
    handler: async (args, ctx) => {
      const state = await loadState(ctx.cwd);
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      let tailN = 20;
      let phaseFilter: LeanPhase | null = null;
      const phaseNames: LeanPhase[] = [
        "brainstorm",
        "plan",
        "implement",
        "review",
        "done",
      ];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "--phase") {
          const candidate = tokens[i + 1] as LeanPhase | undefined;
          if (candidate && phaseNames.includes(candidate)) {
            phaseFilter = candidate;
            i += 1;
          } else if (ctx.hasUI) {
            ctx.ui.notify(
              `Unknown phase "${candidate ?? "(missing)"}". Valid: ${phaseNames.join(", ")}.`,
              "warning",
            );
            return;
          }
        } else if (/^\d+$/.test(t)) {
          const n = Number(t);
          if (n > 0) tailN = n;
        }
      }
      if (state.history.length === 0) {
        if (ctx.hasUI) ctx.ui.notify("No history recorded yet.", "info");
        return;
      }
      const filtered = phaseFilter
        ? state.history.filter((h) => h.phase === phaseFilter)
        : state.history;
      if (phaseFilter && filtered.length === 0) {
        // Different from "no history at all" — surface explicitly so the
        // user knows the filter matched zero entries (not that the log is
        // empty).
        if (ctx.hasUI)
          ctx.ui.notify(
            `No history entries for phase ${phaseLabel(phaseFilter)} yet (${state.history.length} total entries in other phases).`,
            "info",
          );
        return;
      }
      const tail = filtered.slice(-tailN);
      const header = phaseFilter
        ? `# Phase history — ${phaseLabel(phaseFilter)} (last ${tail.length} of ${filtered.length}; ${state.history.length} total)`
        : `# Phase history (last ${tail.length} of ${state.history.length})`;
      const lines = [
        header,
        "",
        ...tail.map(
          (h) =>
            `- ${new Date(h.timestamp).toISOString()} · ${phaseLabel(h.phase)}${h.note ? ` — ${h.note}` : ""}`,
        ),
      ];
      if (ctx.hasUI) {
        ctx.ui.notify(
          `History: showing ${tail.length} / ${filtered.length}${phaseFilter ? ` matching ${phaseFilter}` : ""}`,
          "info",
        );
        ctx.ui.setEditorText(lines.join("\n"));
      }
    },
  });

  // ── Command: /lean-revalidate ──────────────────────────────────────────────

  pi.registerCommand("lean-revalidate", {
    description:
      "Recompute the V1+V2 quality score for every saved artifact and record fresh auto-evaluations. " +
      "Use after a bug fix in checkRequiredFields or evaluateQuality to refresh stale scores. " +
      "Usage: /lean-revalidate [type] [--dry-run]. " +
      "Type is one of: clarifiedProduct | actionPlan | reviewReport. " +
      "--dry-run computes the scores but does not modify state.",
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const dryRun = tokens.includes("--dry-run");
      const positional = tokens.find((t) => !t.startsWith("--")) ?? "";
      let targets: LeanArtifactKey[];
      if (positional) {
        if (!isLeanArtifactKey(positional)) {
          if (ctx.hasUI)
            ctx.ui.notify(
              `Unknown artifact "${positional}". Valid: ${LEAN_ARTIFACT_KEYS.join(", ")}.`,
              "warning",
            );
          return;
        }
        targets = [positional];
      } else {
        targets = [...LEAN_ARTIFACT_KEYS];
      }

      // --dry-run: compute scores against the current state without writing
      // anything back. Lets the user preview what /lean-revalidate would do.
      if (dryRun) {
        const snapshot = await loadState(ctx.cwd);
        const preview: { type: LeanArtifactKey; score: number }[] = [];
        const missing: LeanArtifactKey[] = [];
        for (const key of targets) {
          const content = snapshot.artifacts[key];
          if (!content || content.trim().length === 0) {
            missing.push(key);
            continue;
          }
          const quality = evaluateQuality(key, content);
          preview.push({ type: key, score: quality.score });
        }
        if (!ctx.hasUI) return;
        if (preview.length === 0) {
          ctx.ui.notify(
            "Dry-run: nothing would be revalidated (no matching saved artifacts).",
            "warning",
          );
          return;
        }
        const summary = preview
          .map((r) => `${r.type}: ${r.score}/10`)
          .join(", ");
        const missingNote =
          missing.length > 0
            ? ` · would skip (missing/empty): ${missing.join(", ")}`
            : "";
        ctx.ui.notify(
          `🔍 Dry-run: would revalidate ${preview.length} artifact(s) — ${summary}${missingNote}`,
          "info",
        );
        return;
      }

      const { state, result } = await withState<{
        revalidated: { type: LeanArtifactKey; score: number }[];
        missing: LeanArtifactKey[];
      }>(ctx.cwd, (s) => {
        const revalidated: { type: LeanArtifactKey; score: number }[] = [];
        const missing: LeanArtifactKey[] = [];
        for (const key of targets) {
          const content = s.artifacts[key];
          if (!content || content.trim().length === 0) {
            missing.push(key);
            continue;
          }
          const quality = evaluateQuality(key, content);
          const newEval: LeanEvaluation = {
            phase: s.currentPhase,
            artifactType: key,
            score: quality.score,
            rationale: quality.summary,
            suggestions: quality.suggestions,
            timestamp: Date.now(),
            source: "auto",
          };
          // Same dedup rule as lean_save_artifact: if the last evaluation
          // for this artifact is already auto, replace it in place.
          const last = s.evaluations[s.evaluations.length - 1];
          if (
            last &&
            last.source === "auto" &&
            last.artifactType === key
          ) {
            s.evaluations[s.evaluations.length - 1] = newEval;
          } else {
            s.evaluations.push(newEval);
          }
          revalidated.push({ type: key, score: quality.score });
        }
        if (revalidated.length > 0) {
          s.history.push({
            phase: s.currentPhase,
            timestamp: Date.now(),
            note: `Revalidated ${revalidated.length} artifact(s) via /lean-revalidate`,
          });
        }
        return { revalidated, missing };
      });

      if (!ctx.hasUI) return;
      if (result.revalidated.length === 0) {
        ctx.ui.notify(
          `Nothing to revalidate — no saved artifacts matched.`,
          "warning",
        );
        return;
      }
      const summary = result.revalidated
        .map((r) => `${r.type}: ${r.score}/10`)
        .join(", ");
      const missingNote =
        result.missing.length > 0
          ? ` · skipped (missing/empty): ${result.missing.join(", ")}`
          : "";
      ctx.ui.notify(
        `🔁 Revalidated ${result.revalidated.length} artifact(s) — ${summary}${missingNote}`,
        "info",
      );
      updatePhaseStatus(ctx, state.currentPhase, state, { notify: false });
    },
  });

  // ── Command: /lean-acknowledge ─────────────────────────────────────────────

  pi.registerCommand("lean-acknowledge", {
    description:
      "Silence the session-start coherence warning for the current phase. The ack is reset automatically on the next phase change.",
    handler: async (_args, ctx) => {
      // Cheap pre-flight: if there is nothing to ack, avoid a withState
      // round-trip (which would load+rewrite state.json for nothing).
      const probe = await loadState(ctx.cwd);
      const probeIssues = computeCoherenceIssues(probe);
      if (probeIssues.length === 0) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No coherence warnings active — state is healthy.",
            "info",
          );
        return;
      }

      const { state, result } = await withState(ctx.cwd, (s) => {
        const issues = computeCoherenceIssues(s);
        if (issues.length === 0) {
          // Edge case: another tool fixed coherence between probe and now.
          return { acked: false, issues };
        }
        s.coherenceAck = {
          phase: s.currentPhase,
          timestamp: Date.now(),
        };
        return { acked: true, issues };
      });
      if (!ctx.hasUI) return;
      if (!result.acked) {
        ctx.ui.notify(
          "No coherence warnings active — state is healthy.",
          "info",
        );
        return;
      }
      // Refresh the widget so the ⚠️ marker disappears immediately. Without
      // this, the user would see the toast confirming the ack but the widget
      // would still display the warning until the next phase change.
      updatePhaseStatus(ctx, state.currentPhase, state, { notify: false });
      ctx.ui.notify(
        `🔕 Acknowledged ${result.issues.length} coherence warning(s) for ${phaseLabel(state.currentPhase)}.`,
        "info",
      );
    },
  });

  // ── Command: /lean-clean ───────────────────────────────────────────────────

  pi.registerCommand("lean-clean", {
    description:
      "Clean up orphan `.tmp` files left over from interrupted atomic writes under .pi-lean-flow/. " +
      "Usage: /lean-clean [--audit]. With --audit, also removes audit.log and audit.log.1.",
    handler: async (args, ctx) => {
      const wantAudit = (args ?? "").trim().split(/\s+/).includes("--audit");
      const baseDir = join(ctx.cwd, ".pi-lean-flow");
      if (!existsSync(baseDir)) {
        if (ctx.hasUI) ctx.ui.notify("No .pi-lean-flow directory.", "warning");
        return;
      }
      // Scan both the root and exports/ — those are the only places this
      // extension writes via temp+rename. Subdirectories created by users
      // are left alone.
      const scanDirs = [baseDir, join(baseDir, "exports")];
      let removed = 0;
      for (const dir of scanDirs) {
        if (!existsSync(dir)) continue;
        const files = await readdir(dir);
        for (const f of files) {
          if (!f.endsWith(".tmp")) continue;
          try {
            await unlink(join(dir, f));
            removed += 1;
          } catch {
            // best-effort; ignore unlink errors (file may have just been claimed)
          }
        }
      }
      let auditRemoved = 0;
      if (wantAudit) {
        auditRemoved = await clearAuditLog(ctx.cwd);
      }
      if (ctx.hasUI) {
        // Compose a precise message that distinguishes "nothing was here"
        // from "nothing matched the flags". Previously a `/lean-clean
        // --audit` with no log files and no .tmp said "Nothing to clean"
        // and obscured the fact that the audit branch had been considered.
        const segments: string[] = [];
        segments.push(
          removed > 0 ? `${removed} orphan .tmp removed` : "no orphan .tmp",
        );
        if (wantAudit) {
          segments.push(
            auditRemoved > 0
              ? `${auditRemoved} audit log file(s) removed`
              : "no audit log files to remove",
          );
        }
        ctx.ui.notify(`🧹 ${segments.join(" · ")}.`, "info");
      }
    },
  });

  // ── Command: /lean-task-add ────────────────────────────────────────────────

  pi.registerCommand("lean-task-add", {
    description:
      "Add a new task. Usage: /lean-task-add description=\"…\" [criteria=\"…\"] [notes=\"…\"]. " +
      "Field names are case-insensitive; surrounding double or single quotes around values are stripped.",
    handler: async (args, ctx) => {
      const joined = (args ?? "").trim();
      if (!joined) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Usage: /lean-task-add description=… [criteria=…] [notes=…]",
            "warning",
          );
        return;
      }
      const { updates, emptyFields } = parseTaskFields(joined);
      // Symmetric policy with /lean-task-edit: an explicit empty value is
      // almost always a typo, not an intent to record a blank string.
      if (emptyFields.length > 0) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `Refusing empty value(s) for: ${emptyFields.join(", ")}.`,
            "warning",
          );
        return;
      }
      // Belt-and-braces: parseTaskFields already trims values and reports
      // bare-empty fields via `emptyFields`, but a value that becomes empty
      // only AFTER its surrounding quotes are stripped (e.g. `description="
      // "`) deserves the same rejection rather than silently creating a
      // task with a blank description.
      const trimmedDescription = (updates.description ?? "").trim();
      if (!trimmedDescription) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "description=… is required and cannot be blank.",
            "warning",
          );
        return;
      }
      const { state, result: task } = await withState(ctx.cwd, (s) => {
        const maxId = s.tasks.reduce((max, t) => Math.max(max, t.id), 0);
        const t = {
          id: maxId + 1,
          description: trimmedDescription,
          acceptanceCriteria: (updates.acceptanceCriteria ?? "").trim(),
          notes: (updates.notes ?? "").trim(),
          done: false,
        };
        s.tasks.push(t);
        return t;
      });
      if (!ctx.hasUI) return;
      updatePhaseStatus(ctx, state.currentPhase, state, { notify: false });
      ctx.ui.notify(`✅ Task #${task.id}: ${task.description}`, "info");
    },
  });

  // ── Command: /lean-task-toggle ─────────────────────────────────────────────

  pi.registerCommand("lean-task-toggle", {
    description:
      "Flip the done/undone status of a task. Usage: /lean-task-toggle <id>. " +
      "Triggers the same auto phase transitions as the LLM-driven toggle.",
    handler: async (args, ctx) => {
      const idStr = (args ?? "").trim();
      const id = Number(idStr);
      if (!Number.isInteger(id)) {
        if (ctx.hasUI)
          ctx.ui.notify(
            idStr ? `Invalid task id: "${idStr}"` : "Usage: /lean-task-toggle <id>",
            "warning",
          );
        return;
      }
      const { state, result } = await withState<{
        task: { id: number; description: string; done: boolean } | null;
        transitioned: boolean;
      }>(ctx.cwd, (s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return { task: null, transitioned: false };
        t.done = !t.done;
        const transition = computePhaseAfterTaskToggle(
          s.currentPhase,
          s.tasks,
          t.done,
        );
        let transitioned = false;
        if (transition.nextPhase) {
          transitionPhase(s, transition.nextPhase);
          s.history.push({
            phase: transition.nextPhase,
            timestamp: Date.now(),
            note:
              transition.reason === "all-tasks-completed"
                ? "All tasks completed — auto-transition to review"
                : `Task #${t.id} reopened — reverted to implement`,
          });
          transitioned = true;
        }
        return { task: { id: t.id, description: t.description, done: t.done }, transitioned };
      });
      if (!ctx.hasUI) return;
      if (!result.task) {
        ctx.ui.notify(`Task #${id} not found.`, "warning");
        return;
      }
      updatePhaseStatus(ctx, state.currentPhase, state, {
        notify: result.transitioned,
      });
      ctx.ui.notify(
        `✅ Task #${result.task.id} ${result.task.done ? "completed" : "reopened"}: ${result.task.description}`,
        "info",
      );
    },
  });

  // ── Command: /lean-task-edit ───────────────────────────────────────────────

  pi.registerCommand("lean-task-edit", {
    description:
      "Edit a task field. Usage: /lean-task-edit <id> <field>=<value> [<field>=<value>...]. Fields: description, criteria, notes.",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Usage: /lean-task-edit <id> description=... [criteria=...] [notes=...]",
            "warning",
          );
        return;
      }
      const [idStr, ...rest] = raw.split(/\s+/);
      const id = Number(idStr);
      if (!Number.isInteger(id)) {
        if (ctx.hasUI) ctx.ui.notify(`Invalid task id: "${idStr}"`, "warning");
        return;
      }
      // Re-join the rest so quoted values with spaces survive; we then split
      // on the first `=` per assignment. Users pass values without quotes
      // here — the slash command line is the only place this is parsed.
      const joined = rest.join(" ");
      const { updates, emptyFields } = parseTaskFields(joined);
      if (emptyFields.length > 0) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `Refusing empty value(s) for: ${emptyFields.join(", ")}. Pass a non-empty value, or use a single space to blank a field.`,
            "warning",
          );
        return;
      }
      if (Object.keys(updates).length === 0) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No fields to update. Use description=… / criteria=… / notes=… (field names are case-insensitive).",
            "warning",
          );
        return;
      }

      // Pre-flight check: bail out cheaply if the task doesn't exist instead
      // of going through a withState round-trip that would write the file
      // back unchanged. loadState is idempotent and read-only.
      const preState = await loadState(ctx.cwd);
      if (!preState.tasks.some((t) => t.id === id)) {
        if (ctx.hasUI) ctx.ui.notify(`Task #${id} not found.`, "warning");
        return;
      }

      const { state, result } = await withState(ctx.cwd, (s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return { found: false };
        if (updates.description !== undefined) t.description = updates.description;
        if (updates.acceptanceCriteria !== undefined)
          t.acceptanceCriteria = updates.acceptanceCriteria;
        if (updates.notes !== undefined) t.notes = updates.notes;
        return { found: true, task: t };
      });
      if (!ctx.hasUI) return;
      if (!result.found) {
        // Race: task removed between loadState and withState. Rare but
        // possible; surface clearly.
        ctx.ui.notify(`Task #${id} not found (race during edit).`, "warning");
        return;
      }
      updatePhaseStatus(ctx, state.currentPhase, state, { notify: false });
      ctx.ui.notify(
        `✏️ Task #${id} updated: ${Object.keys(updates).join(", ")}`,
        "info",
      );
    },
  });

  // ── Command: /lean-task-remove ─────────────────────────────────────────────

  pi.registerCommand("lean-task-remove", {
    description:
      "Remove a task by id. Usage: /lean-task-remove <id>. Triggers auto-transition to review if removing the task leaves every other task done.",
    handler: async (args, ctx) => {
      const idStr = (args ?? "").trim();
      const id = Number(idStr);
      if (!Number.isInteger(id)) {
        if (ctx.hasUI)
          ctx.ui.notify(
            idStr ? `Invalid task id: "${idStr}"` : "Usage: /lean-task-remove <id>",
            "warning",
          );
        return;
      }
      const { state, result } = await withState<{
        removed: { id: number; description: string } | null;
        transitioned: boolean;
      }>(ctx.cwd, (s) => {
        const idx = s.tasks.findIndex((x) => x.id === id);
        if (idx === -1) return { removed: null, transitioned: false };
        const [t] = s.tasks.splice(idx, 1);
        const transition = computePhaseAfterTaskRemove(s.currentPhase, s.tasks);
        let transitioned = false;
        if (transition.nextPhase) {
          transitionPhase(s, transition.nextPhase);
          s.history.push({
            phase: transition.nextPhase,
            timestamp: Date.now(),
            note: `Task #${t.id} removed via /lean-task-remove`,
          });
          transitioned = true;
        }
        return {
          removed: { id: t.id, description: t.description },
          transitioned,
        };
      });
      if (!ctx.hasUI) return;
      if (!result.removed) {
        ctx.ui.notify(`Task #${id} not found.`, "warning");
        return;
      }
      updatePhaseStatus(ctx, state.currentPhase, state, {
        notify: result.transitioned,
      });
      ctx.ui.notify(
        `🗑️ Task #${result.removed.id} removed: ${result.removed.description}`,
        "info",
      );
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
        if (ctx.hasUI) {
          ctx.ui.notify("🧹 Lean Flow state reset. Phase: Brainstorming.", "info");
        }
      }
    },
  });
}
