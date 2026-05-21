/**
 * gate.ts — Quality gate functions for pi-lean-flow
 *
 * V1: Field presence validation (required headers exist).
 * V2: LLM-based self-evaluation — the model scores its own artifacts.
 * V3: Integration with external tools (linter, test runner).
 */

import { spawn } from "node:child_process";
import { platform } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { ARTIFACT_NAMES } from "../state/project-state.js";
import { makeDebug } from "../util/debug.js";
import { appendAuditLog } from "../util/audit.js";

const dbg = makeDebug("gate");

// ─── Required fields per artifact type ───────────────────────────────────────

const REQUIRED_FIELDS: Record<string, string[]> = {
  clarifiedProduct: [
    "Vision",
    "Measurable Goals",
    "Key Requirements",
    "Users", // matches "## Users and Stakeholders"
    "Constraints",
    "Success Criteria",
    "Out of Scope",
  ],
  actionPlan: ["Tasks"],
  reviewReport: ["Summary", "Task Details", "Decision"],
};

// ─── V1: Field presence validation ───────────────────────────────────────────

export interface FieldCheckResult {
  isValid: boolean;
  missingFields: string[];
  presentFields: string[];
  warnings: string[];
}

/**
 * Check that a Markdown artifact contains all required fields (headers).
 *
 * A field counts as present if it appears either as:
 *   - a Markdown header (`#`/`##`/`###`) followed by the field name and a
 *     word/punctuation boundary, OR
 *   - a stand-alone bold marker (`**Field**`) at the start of a line.
 *
 * Both patterns require a boundary at the end of the field name so that
 * `## Visionary` does not match `Vision`, and a stray phrase like
 * `the **Vision was good**` in a paragraph is not counted either.
 */
export function checkRequiredFields(
  artifactType: string,
  content: string,
): FieldCheckResult {
  const required = REQUIRED_FIELDS[artifactType];
  if (!required) {
    return {
      isValid: true,
      missingFields: [],
      presentFields: [],
      warnings: [],
    };
  }

  const present: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const field of required) {
    const escaped = escapeRegex(field);
    // Header form: anchored to start of line, requires a non-word character
    // (whitespace, colon, end-of-line) immediately after the field name.
    // Case-insensitive so `## VISION` and `## vision` both count.
    const headerRegex = new RegExp(`^#{1,3}\\s+${escaped}(?:[\\s:]|$)`, "mi");
    // Bold form: a stand-alone **Field** marker — anchored to start of line
    // (after optional whitespace) and closed by another `**` to avoid matches
    // inside running prose.
    const boldRegex = new RegExp(`^\\s*\\*\\*${escaped}\\*\\*`, "mi");
    if (headerRegex.test(content) || boldRegex.test(content)) {
      present.push(field);
    } else {
      missing.push(field);
    }
  }

  // Content length warnings
  const textLength = content.replace(/#{1,6}\s+/g, "").length;
  if (textLength < 100) {
    warnings.push("Content is very short (< 100 chars). Add more details.");
  }

  // Check for lists/actionable items
  const listItems = (content.match(/^[-*]\s/gm) || []).length;
  if (listItems < 2 && artifactType !== "reviewReport") {
    warnings.push("Few list items. Add more detail with bullet points.");
  }

  return {
    isValid: missing.length === 0,
    missingFields: missing,
    presentFields: present,
    warnings,
  };
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── V2: Quality scoring ─────────────────────────────────────────────────────

export interface QualityScore {
  score: number; // 1-10
  summary: string;
  suggestions: string[];
}

/**
 * Heuristic quality evaluation based on artifact structure and content.
 * This is the automated baseline; the LLM self-evaluation (via
 * lean_evaluate_artifact tool) provides the richer qualitative score.
 */
export function evaluateQuality(
  artifactType: string,
  content: string,
): QualityScore {
  const checks = checkRequiredFields(artifactType, content);
  const suggestions: string[] = [...checks.warnings];
  let score = 5; // middle baseline

  // +/- based on field completeness
  if (checks.missingFields.length > 0) {
    score -= checks.missingFields.length * 2;
    suggestions.push(
      `Add missing required fields: ${checks.missingFields.join(", ")}`,
    );
  } else {
    score += 2;
  }

  // Content depth
  const textLength = content.replace(/#{1,6}\s+/g, "").length;
  if (textLength < 100) {
    score -= 2;
    suggestions.push("Add more content: artifact is very short.");
  } else if (textLength < 300) {
    // adequate, no score delta
  } else if (textLength < 1000) {
    score += 1;
  } else {
    score += 2;
  }

  // Structure — sections with content
  const sectionCount = (content.match(/^#{2,3}\s+.+/gm) || []).length;
  if (sectionCount >= 3) score += 1;

  // Actionable items (lists)
  const listItems = (content.match(/^[-*]\s/gm) || []).length;
  if (listItems >= 5) score += 1;

  const clampedScore = Math.max(1, Math.min(10, score));

  // Only append the "all good" hint when the clamped score actually reflects
  // a healthy artifact. Otherwise listing both "missing fields" and a green
  // checkmark in the same response is confusing.
  if (checks.missingFields.length === 0 && clampedScore >= 7) {
    suggestions.push("All required fields present. ✓");
  }

  return {
    score: clampedScore,
    summary: `Quality: ${clampedScore}/10. ${checks.isValid ? "All required fields present." : `${checks.missingFields.length} missing field(s).`}`,
    suggestions,
  };
}

// ─── V3: External tool validation ────────────────────────────────────────────

/**
 * Tri-state outcome for an external check.
 *
 *   - "passed":  the configured command ran and exited 0.
 *   - "failed":  the command ran and exited non-zero (or timed out / crashed).
 *   - "skipped": no command was configured for this check type — the check
 *               could not be evaluated. This is *not* a failure.
 *
 * Tools relying on the older boolean shape can still read `passed`/`skipped`,
 * but new callers should branch on `status` to avoid the
 * "skipped looks like failed" confusion.
 */
export type ExternalCheckStatus = "passed" | "failed" | "skipped";

export interface ExternalCheckResult {
  checkType: string;
  /**
   * Tri-state outcome. Optional for backwards compatibility — older callers
   * constructed results with only `passed`/`skipped`. The formatter
   * (`formatQualityReport`) and the extension renderer fall back to the
   * legacy booleans when `status` is undefined.
   */
  status?: ExternalCheckStatus;
  /** Convenience: true iff status === "passed". Kept for backwards compat. */
  passed: boolean;
  /** Convenience: true iff status === "skipped". Kept for backwards compat. */
  skipped?: boolean;
  output: string;
  errors: string[];
  durationMs: number;
}

/** Maximum combined output (stdout+stderr) buffered per check. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Default per-check timeout. */
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;

/**
 * Read npm scripts from package.json, returning a set of script names.
 *
 * Defensive: a hand-edited package.json can be an array, `null`, or have
 * `scripts` typed as something other than a plain object. Anything that
 * doesn't look like a `{ scripts: { name: string } }` shape is treated as
 * "no scripts" — `detectAvailableCommand` will then fall back / skip.
 */
function readPackageScripts(cwd: string): Set<string> {
  try {
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) return new Set();
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Set();
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      return new Set();
    }
    return new Set(Object.keys(scripts as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

/**
 * Read a single positive-integer field from `.pi-lean-flow/config.json`.
 * Returns null when the file is missing/malformed or the field is absent /
 * not a finite positive number. Centralised so timeout, audit size, output
 * cap etc. all share the same defensive-parse semantics.
 */
export function readConfigPositiveInt(
  cwd: string,
  field: string,
): number | null {
  try {
    const configPath = join(cwd, ".pi-lean-flow", "config.json");
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const v = (parsed as Record<string, unknown>)[field];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return Math.floor(v);
    }
    return null;
  } catch {
    return null;
  }
}

/** Read project-level check overrides from `.pi-lean-flow/config.json`. */
function readCheckOverrides(cwd: string): Record<string, string> {
  try {
    const configPath = join(cwd, ".pi-lean-flow", "config.json");
    if (!existsSync(configPath)) return {};
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      checks?: Record<string, string>;
    };
    return config.checks ?? {};
  } catch {
    return {};
  }
}

/**
 * Read the per-check timeout (ms) from `.pi-lean-flow/config.json` if present.
 * Returns null when not configured so callers can fall back to the default.
 */
function readCheckTimeout(cwd: string, checkType: string): number | null {
  try {
    const configPath = join(cwd, ".pi-lean-flow", "config.json");
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      timeouts?: Record<string, number>;
      timeoutMs?: number;
    };
    if (config.timeouts && typeof config.timeouts[checkType] === "number") {
      return config.timeouts[checkType];
    }
    if (typeof config.timeoutMs === "number") return config.timeoutMs;
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect the best available command for a check type by inspecting the project.
 *
 * Resolution order:
 *   1. Explicit override from `.pi-lean-flow/config.json` → `checks[type]`
 *   2. Matching npm script in `package.json`
 *   3. Tool-specific fallback (e.g. `npx tsc --noEmit` if `tsconfig.json` exists)
 *
 * Returns null if no suitable tool is configured — callers should treat this
 * as "skipped" rather than "passed".
 */
export function detectAvailableCommand(
  checkType: string,
  cwd: string,
): string | null {
  const overrides = readCheckOverrides(cwd);
  if (overrides[checkType]) return overrides[checkType];

  const scripts = readPackageScripts(cwd);
  switch (checkType) {
    case "compile":
      if (scripts.has("build")) return "npm run build";
      if (scripts.has("compile")) return "npm run compile";
      return null;
    case "lint":
      if (scripts.has("lint")) return "npm run lint";
      return null;
    case "test":
      if (scripts.has("test")) return "npm test";
      return null;
    case "typecheck":
      if (scripts.has("typecheck")) return "npm run typecheck";
      if (existsSync(join(cwd, "tsconfig.json"))) return "npx tsc --noEmit";
      return null;
    case "format":
      // Prefer an explicit script; otherwise pick a formatter the project has
      // configured. We default to a *check-only* invocation so the gate never
      // rewrites files on its own.
      if (scripts.has("format:check")) return "npm run format:check";
      if (scripts.has("format")) return "npm run format";
      if (
        existsSync(join(cwd, ".prettierrc")) ||
        existsSync(join(cwd, ".prettierrc.json")) ||
        existsSync(join(cwd, ".prettierrc.js")) ||
        existsSync(join(cwd, "prettier.config.js")) ||
        existsSync(join(cwd, "prettier.config.cjs"))
      ) {
        return "npx prettier --check .";
      }
      if (existsSync(join(cwd, "biome.json"))) return "npx biome format .";
      if (existsSync(join(cwd, "dprint.json"))) return "npx dprint check";
      return null;
    default:
      return null;
  }
}

/** Supported external check types. */
export const SUPPORTED_CHECK_TYPES = [
  "compile",
  "lint",
  "test",
  "typecheck",
  "format",
] as const;
export type ExternalCheckType = (typeof SUPPORTED_CHECK_TYPES)[number];

// ─── spawn helper ────────────────────────────────────────────────────────────

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: Error;
}

/**
 * Run a shell command via `spawn` so we can kill the whole process tree on
 * timeout. `exec`'s built-in timeout would only signal the top-level shell on
 * POSIX and is unreliable on Windows.
 */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ProcessOutcome> {
  const isWindows = platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    // StringDecoder handles split UTF-8 sequences across chunk boundaries
    // safely; raw `chunk.toString()` would corrupt multi-byte characters.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const safeResolve = (outcome: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args, {
        cwd,
        detached: !isWindows, // gives us a process group to signal on POSIX
        windowsHide: true,
      });
    } catch (err) {
      safeResolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        spawnError: err as Error,
      });
      return;
    }

    const killTree = () => {
      try {
        if (isWindows && child.pid !== undefined) {
          // taskkill /T /F follows the process tree on Windows.
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        } else if (child.pid !== undefined) {
          // detached:true above gives us a process group (-pid).
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      } catch {
        // best-effort
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) {
        stdout += stdoutDecoder.write(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) {
        stderr += stderrDecoder.write(chunk);
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      safeResolve({
        stdout,
        stderr,
        exitCode: null,
        timedOut,
        spawnError: err,
      });
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      safeResolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
      });
    });
  });
}

/**
 * Run common project validation commands.
 *
 * Supported check types: "compile", "lint", "test", "typecheck", "format".
 *
 * The actual command is resolved by `detectAvailableCommand`. When no command
 * is configured the result is marked `status: "skipped"` so callers can
 * distinguish "tool missing" from "passed" / "failed".
 *
 * The whole process tree is killed on timeout (60 s by default) — on Windows
 * via `taskkill /T /F`, on POSIX via process-group SIGKILL.
 */
/**
 * Heuristic check on a configured command string. We don't try to outright
 * block dangerous-looking commands (any reasonable build tool can include
 * pipes, redirects, etc.) — instead we look for patterns that almost never
 * appear in legit project scripts but are common in command injection:
 *
 *   - `rm -rf /` (or variants near root, both POSIX `~`/`$HOME` and
 *     Windows `%USERPROFILE%`/`%HOMEDRIVE%%HOMEPATH%`)
 *   - `:(){:|:&};:`             (classic fork bomb)
 *   - `curl … | sh`             (drive-by install)
 *   - `` $(curl …) `` or `` `curl …` ``  (template injection via command
 *     substitution wrapping a network fetch — these patterns only show up
 *     in a config that was generated or tampered with)
 *
 * Returns a human-readable reason if suspicious, or null when fine.
 */
export function sanityCheckCheckCommand(command: string): string | null {
  const trimmed = command.trim();
  if (
    /rm\s+-rf?\s+(\/|~|\$HOME|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)(\s|$)/i.test(
      trimmed,
    )
  ) {
    return "command contains an `rm -rf` of a root-like path";
  }
  if (/:\s*\(\s*\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/.test(trimmed)) {
    return "command looks like a fork bomb";
  }
  if (
    /(curl|wget|iwr|invoke-webrequest)[^\n]*\|\s*(sh|bash|zsh|pwsh|powershell|iex|invoke-expression)/i.test(
      trimmed,
    )
  ) {
    return "command pipes a network fetch into a shell";
  }
  // Command substitution that wraps a network fetch. We accept legitimate
  // uses of `$(…)` for date/version stamping, but a network fetch inside
  // `$(…)` or backticks is essentially always template injection in a
  // build script. Same for PowerShell's `$(iwr …)` idiom.
  if (
    /\$\([^()]*\b(curl|wget|iwr|invoke-webrequest)\b[^()]*\)/i.test(trimmed) ||
    /`[^`]*\b(curl|wget)\b[^`]*`/i.test(trimmed)
  ) {
    return "command uses command substitution to invoke a network fetch";
  }
  return null;
}

export async function runExternalCheck(
  checkType: string,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<ExternalCheckResult> {
  if (!(SUPPORTED_CHECK_TYPES as readonly string[]).includes(checkType)) {
    const result: ExternalCheckResult = {
      checkType,
      status: "failed",
      passed: false,
      output: `Unknown check type: "${checkType}". Use: ${SUPPORTED_CHECK_TYPES.join(", ")}.`,
      errors: [`Unknown check type: ${checkType}`],
      durationMs: 0,
    };
    await appendAuditLog(cwd, {
      checkType,
      command: null,
      status: result.status,
      durationMs: 0,
      reason: "unknown check type",
    });
    return result;
  }

  const command = detectAvailableCommand(checkType, cwd);
  if (!command) {
    dbg(`check "${checkType}" skipped — no tool configured for this project`);
    const result: ExternalCheckResult = {
      checkType,
      status: "skipped",
      passed: false,
      skipped: true,
      output: `No ${checkType} command configured for this project.`,
      errors: [],
      durationMs: 0,
    };
    await appendAuditLog(cwd, {
      checkType,
      command: null,
      status: "skipped",
      durationMs: 0,
    });
    return result;
  }

  // Refuse to execute commands matching well-known dangerous patterns. Better
  // to nudge the user back to config.json than silently SIGKILL their box.
  const suspicious = sanityCheckCheckCommand(command);
  if (suspicious) {
    dbg(`check "${checkType}" refused — suspicious command: ${suspicious}`);
    const result: ExternalCheckResult = {
      checkType,
      status: "failed",
      passed: false,
      output: "",
      errors: [
        `Refused to run "${checkType}" — ${suspicious}. Edit .pi-lean-flow/config.json to set a safe command.`,
      ],
      durationMs: 0,
    };
    await appendAuditLog(cwd, {
      checkType,
      command,
      status: "failed",
      durationMs: 0,
      reason: `refused: ${suspicious}`,
    });
    return result;
  }

  // Timeout resolution order: explicit option → config file → default.
  const configuredTimeout = readCheckTimeout(cwd, checkType);
  const effectiveTimeout =
    options.timeoutMs ?? configuredTimeout ?? DEFAULT_CHECK_TIMEOUT_MS;

  dbg(
    `running check "${checkType}" in "${cwd}" (timeout=${effectiveTimeout}ms): ${command}`,
  );
  const start = Date.now();
  const outcome = await runShell(command, cwd, effectiveTimeout);
  const durationMs = Date.now() - start;

  let result: ExternalCheckResult;
  if (outcome.spawnError) {
    dbg(`check "${checkType}" failed to spawn: ${outcome.spawnError.message}`);
    result = {
      checkType,
      status: "failed",
      passed: false,
      output: "",
      errors: [outcome.spawnError.message],
      durationMs,
    };
  } else if (outcome.timedOut) {
    dbg(`check "${checkType}" timed out after ${durationMs}ms`);
    result = {
      checkType,
      status: "failed",
      passed: false,
      output: outcome.stdout,
      errors: [
        `Command timed out after ${durationMs}ms and was killed.`,
        outcome.stderr,
      ].filter(Boolean),
      durationMs,
    };
  } else if (outcome.exitCode === 0) {
    if (outcome.stderr) {
      // Many tools (npm, vitest, tsc) print progress/warnings to stderr even
      // on success. Treat stderr as informational — don't flag as an error.
      dbg(
        `check "${checkType}" stderr (non-fatal): ${outcome.stderr.slice(0, 200)}`,
      );
    }
    dbg(`check "${checkType}" passed in ${durationMs}ms`);
    result = {
      checkType,
      status: "passed",
      passed: true,
      output: outcome.stdout || "OK — no output",
      errors: [],
      durationMs,
    };
  } else {
    dbg(
      `check "${checkType}" failed in ${durationMs}ms (exit ${outcome.exitCode})`,
    );
    result = {
      checkType,
      status: "failed",
      passed: false,
      output: outcome.stdout,
      errors: outcome.stderr
        ? [outcome.stderr]
        : [`Command exited with code ${outcome.exitCode}`],
      durationMs,
    };
  }

  await appendAuditLog(cwd, {
    checkType,
    command,
    status: result.status,
    durationMs,
    exitCode: outcome.exitCode ?? null,
    timedOut: outcome.timedOut,
  });
  return result;
}

// ─── Combined quality report ─────────────────────────────────────────────────

export interface QualityReport {
  artifactType: string;
  artifactName: string;
  fieldCheck: FieldCheckResult;
  heuristicScore: QualityScore;
  selfEvaluation?: {
    score: number;
    rationale: string;
    suggestions: string[];
  };
  externalChecks?: ExternalCheckResult[];
}

/**
 * Produce a combined quality report for an artifact.
 */
export function generateQualityReport(
  artifactType: string,
  content: string,
  selfEvaluation?: { score: number; rationale: string; suggestions: string[] },
  externalChecks?: ExternalCheckResult[],
): QualityReport {
  const fieldCheck = checkRequiredFields(artifactType, content);
  const heuristicScore = evaluateQuality(artifactType, content);

  return {
    artifactType,
    artifactName:
      (ARTIFACT_NAMES as Record<string, string>)[artifactType] ?? artifactType,
    fieldCheck,
    heuristicScore,
    selfEvaluation,
    externalChecks,
  };
}

/**
 * Format a quality report as a Markdown string.
 */
export function formatQualityReport(report: QualityReport): string {
  const lines: string[] = [];
  lines.push(`# Quality Report: ${report.artifactName}`);
  lines.push("");

  // Field check
  if (report.fieldCheck.isValid) {
    lines.push("## ✅ Required fields: all present");
  } else {
    lines.push(
      `## ❌ Required fields: ${report.fieldCheck.missingFields.length} missing`,
    );
    for (const f of report.fieldCheck.missingFields) {
      lines.push(`  - ${f}`);
    }
  }
  if (report.fieldCheck.warnings.length > 0) {
    lines.push("");
    lines.push("### ⚠️ Warnings");
    for (const w of report.fieldCheck.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  // Heuristic score
  lines.push("");
  lines.push(`## 🤖 Automated evaluation: ${report.heuristicScore.score}/10`);
  lines.push(report.heuristicScore.summary);
  if (report.heuristicScore.suggestions.length > 0) {
    lines.push("");
    lines.push("Suggestions:");
    for (const s of report.heuristicScore.suggestions) {
      lines.push(`  - ${s}`);
    }
  }

  // Self-evaluation (LLM)
  if (report.selfEvaluation) {
    lines.push("");
    lines.push(`## Self-evaluation (LLM): ${report.selfEvaluation.score}/10`);
    lines.push(report.selfEvaluation.rationale);
    if (report.selfEvaluation.suggestions.length > 0) {
      lines.push("");
      for (const s of report.selfEvaluation.suggestions) {
        lines.push(`  - ${s}`);
      }
    }
  }

  // External checks
  if (report.externalChecks && report.externalChecks.length > 0) {
    lines.push("");
    lines.push("## 🔧 External checks");
    for (const check of report.externalChecks) {
      // Prefer the tri-state `status` field; fall back to the legacy boolean
      // shape so reports built before this refactor still render correctly.
      const status: ExternalCheckStatus =
        check.status ??
        (check.skipped ? "skipped" : check.passed ? "passed" : "failed");
      const icon =
        status === "skipped" ? "⏭️" : status === "passed" ? "✅" : "❌";
      lines.push(
        `${icon} ${check.checkType} — ${status} (${check.durationMs}ms)`,
      );
      if (check.errors.length > 0) {
        for (const e of check.errors) {
          lines.push(`   Error: ${e.slice(0, 200)}`);
        }
      }
    }
  }

  return lines.join("\n");
}
