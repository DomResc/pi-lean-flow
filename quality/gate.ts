/**
 * gate.ts — Quality gate functions for pi-lean-flow
 *
 * V1: Field presence validation (required headers exist).
 * V2: LLM-based self-evaluation — the model scores its own artifacts.
 * V3: Integration with external tools (linter, test runner).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { env } from "node:process";

const execAsync = promisify(exec);

// ─── Required fields per artifact type ───────────────────────────────────────

const REQUIRED_FIELDS: Record<string, string[]> = {
  clarifiedProduct: [
    "Vision",
    "Measurable Goals",
    "Key Requirements",
    "Constraints",
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
 * Returns which required headers are present vs missing, plus warnings.
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
    // Check for markdown headers (## or ###) that START WITH the field name
    const headerRegex = new RegExp(`^#{1,3}\\s+${escapeRegex(field)}`, "m");
    if (headerRegex.test(content)) {
      present.push(field);
    } else {
      // Also check for bold markers that START WITH the field
      const fieldRegex = new RegExp(`\\*\\*${escapeRegex(field)}`, "m");
      if (fieldRegex.test(content)) {
        present.push(field);
      } else {
        missing.push(field);
      }
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
    suggestions.push("All required fields present. ✓");
  }

  // Content depth
  const textLength = content.replace(/#{1,6}\s+/g, "").length;
  if (textLength < 100) score -= 2;
  else if (textLength < 300)
    score += 0; // adequate
  else if (textLength < 1000)
    score += 1; // good
  else score += 2; // very detailed

  // Structure — sections with content
  const sectionCount = (content.match(/^#{2,3}\s+.+/gm) || []).length;
  if (sectionCount >= 3) score += 1;

  // Actionable items (lists)
  const listItems = (content.match(/^[-*]\s/gm) || []).length;
  if (listItems >= 5) score += 1;

  return {
    score: Math.max(1, Math.min(10, score)),
    summary: `Quality: ${score}/10. ${checks.isValid ? "All required fields present." : `${checks.missingFields.length} missing field(s).`}`,
    suggestions,
  };
}

// ─── V3: External tool validation ────────────────────────────────────────────

export interface ExternalCheckResult {
  checkType: string;
  passed: boolean;
  output: string;
  errors: string[];
  durationMs: number;
}

/**
 * Run common project validation commands.
 *
 * Supported check types:
 * - "compile"   → npm run build, tsc --noEmit, make, etc.
 * - "lint"      → npm run lint, eslint, etc.
 * - "test"      → npm test, npx vitest run, npx jest, etc.
 * - "typecheck" → npx tsc --noEmit
 */
export async function runExternalCheck(
  checkType: string,
  cwd: string,
): Promise<ExternalCheckResult> {
  const command = resolveCheckCommand(checkType);
  if (!command) {
    return {
      checkType,
      passed: false,
      output: `Unknown check type: "${checkType}". Use: compile, lint, test, typecheck.`,
      errors: [`Unknown check type: ${checkType}`],
      durationMs: 0,
    };
  }

  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60000,
      shell: env.SHELL || "/bin/sh",
    });
    const durationMs = Date.now() - start;
    const errors: string[] = [];
    if (stderr) errors.push(stderr);

    return {
      checkType,
      passed: true,
      output: stdout || "OK — no output",
      errors,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      checkType,
      passed: false,
      output: error.stdout ?? "",
      errors: error.stderr
        ? [error.stderr]
        : [error.message ?? "Unknown error"],
      durationMs,
    };
  }
}

/**
 * Map a generic check type to the actual command to run.
 * Tries to detect the project type from the working directory.
 */
function resolveCheckCommand(checkType: string): string | null {
  switch (checkType) {
    case "compile":
      // Try multiple build commands, pick first that likely works
      return "npm run build 2>/dev/null || npm run compile 2>/dev/null || echo 'No build script configured'";
    case "lint":
      return "npm run lint 2>/dev/null || npx eslint . 2>/dev/null || echo 'No linter configured'";
    case "test":
      return "npm test 2>/dev/null || npx vitest run 2>/dev/null || npx jest 2>/dev/null || echo 'No test runner configured'";
    case "typecheck":
      return "npx tsc --noEmit 2>/dev/null || echo 'TypeScript not configured'";
    default:
      return null;
  }
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

  const artifactNames: Record<string, string> = {
    clarifiedProduct: "Clarified Product",
    actionPlan: "Action Plan",
    reviewReport: "Review Report",
  };

  return {
    artifactType,
    artifactName: artifactNames[artifactType] ?? artifactType,
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
    lines.push(
      `## 🧠 Self-evaluation (LLM): ${report.selfEvaluation.score}/10`,
    );
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
      const icon = check.passed ? "✅" : "❌";
      lines.push(`${icon} ${check.checkType} (${check.durationMs}ms)`);
      if (check.errors.length > 0) {
        for (const e of check.errors) {
          lines.push(`   Error: ${e.slice(0, 200)}`);
        }
      }
    }
  }

  return lines.join("\n");
}
