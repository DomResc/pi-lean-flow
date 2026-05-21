import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";

import {
  appendAuditLog,
  redactCommand,
  clearAuditLog,
  MAX_AUDIT_BYTES,
} from "./audit.js";

describe("redactCommand", () => {
  it("redacts --token=value", () => {
    expect(redactCommand("curl --token=abc123 https://x")).toBe(
      "curl --token=*** https://x",
    );
  });

  it("redacts long-form --password value", () => {
    const result = redactCommand("mytool --password supersecret");
    expect(result).toMatch(/--password\s+\*\*\*/);
    expect(result).not.toContain("supersecret");
  });

  it("redacts --api-key with hyphen", () => {
    expect(redactCommand("--api-key=AAAA-BBBB-CCCC")).toBe("--api-key=***");
  });

  it("redacts env-style PASSWORD=", () => {
    expect(redactCommand("PASSWORD=foo run-tests")).toBe("PASSWORD=*** run-tests");
  });

  it("redacts Authorization Bearer header", () => {
    expect(redactCommand("curl -H 'Authorization: Bearer eyJabc.def'")).toContain(
      "Authorization: Bearer ***",
    );
  });

  it("leaves benign commands untouched", () => {
    expect(redactCommand("npm test --silent")).toBe("npm test --silent");
    expect(redactCommand("tsc --noEmit")).toBe("tsc --noEmit");
  });

  it("is case-insensitive on secret-name patterns", () => {
    expect(redactCommand("--Token=abc")).toContain("***");
    expect(redactCommand("SECRET=xyz")).toContain("***");
  });

  it("redacts --cookie / --session / --client-secret flags", () => {
    expect(redactCommand("--cookie=abc123")).not.toContain("abc123");
    expect(redactCommand("--session ttt")).toContain("***");
    expect(redactCommand("gh release upload --client-secret=zzz")).not.toContain("zzz");
  });

  it("redacts --private-key / --access-key flags", () => {
    expect(redactCommand("aws s3 ls --access-key=AKIATEST")).not.toContain("AKIATEST");
    expect(redactCommand("--private-key=/tmp/k")).toContain("***");
  });

  it("redacts X-Api-Key style auth headers", () => {
    expect(redactCommand("curl -H 'X-Api-Key: abc-secret'"))
      .toContain("X-Api-Key: ***");
    expect(redactCommand("curl -H 'X-Auth-Token: zzz'"))
      .toContain("X-Auth-Token: ***");
  });

  it("redacts Authorization ApiKey/Token schemes (not just Bearer/Basic)", () => {
    expect(redactCommand("Authorization: ApiKey abc123"))
      .toContain("ApiKey ***");
    expect(redactCommand("Authorization: Token zzz"))
      .toContain("Token ***");
  });

  it("redacts AWS access key IDs", () => {
    const out = redactCommand("export AKIA1234567890123456");
    expect(out).toContain("AKIA");
    expect(out).not.toContain("1234567890123456");
  });

  it("redacts GitHub personal-access tokens", () => {
    const out = redactCommand("git push https://ghp_abcDEF1234567890xyzw@github.com");
    expect(out).toContain("ghp_");
    expect(out).not.toContain("abcDEF1234567890xyzw");
  });

  it("redacts Slack tokens", () => {
    const out = redactCommand("curl -d 'token=xoxb-1234-5678-abcdefghij'");
    expect(out).toContain("xoxb-");
    expect(out).not.toContain("abcdefghij");
  });

  it("redacts PREFIX_TOKEN-style env-var assignments", () => {
    // Covers patterns like MYAPP_API_TOKEN=…, BUILD_SECRET=…, FOO_API_KEY=…
    expect(redactCommand("MYAPP_API_TOKEN=zzz npm test"))
      .toContain("MYAPP_API_TOKEN=***");
    expect(redactCommand("BUILD_PRIVATE_KEY=/tmp/k make build"))
      .toContain("BUILD_PRIVATE_KEY=***");
  });
});

describe("appendAuditLog", () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `pi-lean-flow-audit-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    logPath = join(dir, ".pi-lean-flow", "audit.log");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the log dir and appends a JSON line", async () => {
    await appendAuditLog(dir, { checkType: "test", status: "passed" });
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.checkType).toBe("test");
    expect(parsed.status).toBe("passed");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("redacts the command field automatically", async () => {
    await appendAuditLog(dir, {
      checkType: "test",
      command: "vitest run --token=abc123",
      status: "passed",
    });
    const content = await readFile(logPath, "utf-8");
    expect(content).not.toContain("abc123");
    expect(content).toContain("***");
  });

  it("never lets the caller override the wall-clock timestamp", async () => {
    // If a buggy or malicious caller passes their own timestamp, the
    // logger must overwrite it. Auditability depends on this.
    const fakeTs = "1970-01-01T00:00:00.000Z";
    await appendAuditLog(dir, {
      checkType: "test",
      status: "passed",
      timestamp: fakeTs,
    });
    const parsed = JSON.parse(
      (await readFile(logPath, "utf-8")).trim(),
    );
    expect(parsed.timestamp).not.toBe(fakeTs);
    expect(new Date(parsed.timestamp).getFullYear()).toBeGreaterThan(2000);
  });

  it("serialises concurrent writes (no interleaving)", async () => {
    // Fire 30 concurrent writes; each line must remain a valid JSON object.
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        appendAuditLog(dir, {
          checkType: "test",
          command: `iter-${i}`,
          status: "passed",
        }),
      ),
    );
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(30);
    for (const line of lines) {
      // Every line must parse — proves no interleaved characters from a
      // racing writer corrupted the JSON.
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("clearAuditLog removes both audit.log and audit.log.1", async () => {
    await mkdir(join(dir, ".pi-lean-flow"), { recursive: true });
    await writeFile(logPath, "{}\n", "utf-8");
    await writeFile(`${logPath}.1`, "{}\n", "utf-8");
    const removed = await clearAuditLog(dir);
    expect(removed).toBe(2);
    // Subsequent call removes nothing.
    expect(await clearAuditLog(dir)).toBe(0);
  });

  it("clearAuditLog cannot race with concurrent appendAuditLog", async () => {
    // Without the shared queue, this interleaving could see a partial state
    // where the clear unlinks while a write is mid-flight. With it, the
    // operations serialise: either the clear happens first (then the writes
    // recreate the file), or all writes happen first then the clear empties
    // it. Either way the final state is internally consistent.
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        appendAuditLog(dir, {
          checkType: "test",
          status: "passed",
          iter: i,
        }),
      ),
      clearAuditLog(dir),
      ...Array.from({ length: 10 }, (_, i) =>
        appendAuditLog(dir, {
          checkType: "test",
          status: "passed",
          iter: 100 + i,
        }),
      ),
    ]);
    // Any line that survived must still be valid JSON — proves no partial
    // writes leaked through the queue.
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    if (!existsSync(logPath)) {
      // It's a valid outcome for clear to have happened last and left no
      // log at all.
      return;
    }
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  it("honors maxAuditBytes override from config.json", async () => {
    await mkdir(join(dir, ".pi-lean-flow"), { recursive: true });
    // Use a tiny cap (200 bytes) and check rotation happens earlier than
    // the 1MB default. We seed slightly over 200 bytes and then trigger.
    await writeFile(
      join(dir, ".pi-lean-flow", "config.json"),
      JSON.stringify({ maxAuditBytes: 200 }),
      "utf-8",
    );
    await writeFile(logPath, "x".repeat(300), "utf-8");
    await appendAuditLog(dir, { checkType: "test", status: "passed" });
    const rotated = await stat(`${logPath}.1`);
    expect(rotated.size).toBeGreaterThan(200);
    // New log only contains our single new line.
    const fresh = await readFile(logPath, "utf-8");
    expect(fresh.trim().split("\n").filter(Boolean).length).toBe(1);
  });

  it("rotates audit.log to audit.log.1 when over the byte cap", async () => {
    // Pre-seed an oversized log by writing > MAX_AUDIT_BYTES of dummy
    // content directly. The next append must trigger rotation.
    await mkdir(join(dir, ".pi-lean-flow"), { recursive: true });
    const bigPayload = "x".repeat(MAX_AUDIT_BYTES + 1024);
    await writeFile(logPath, bigPayload, "utf-8");

    await appendAuditLog(dir, { checkType: "test", status: "passed" });

    const rotated = await stat(join(dir, ".pi-lean-flow", "audit.log.1"));
    expect(rotated.size).toBeGreaterThan(MAX_AUDIT_BYTES);
    const fresh = await readFile(logPath, "utf-8");
    // The fresh log contains only the new line we just appended.
    const lines = fresh.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).checkType).toBe("test");
  });
});
