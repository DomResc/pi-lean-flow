/**
 * audit.ts — Append-only audit log for external check invocations.
 *
 * Design notes:
 *   - One JSON-Lines record per call, written under `<cwd>/.pi-lean-flow/audit.log`.
 *   - Writes are serialised per-cwd via an in-memory queue, so two concurrent
 *     `runExternalCheck` calls can never interleave a record. (POSIX guarantees
 *     atomic appends under PIPE_BUF, but Windows doesn't — the queue keeps
 *     behaviour identical across platforms.)
 *   - The log is capped at `MAX_AUDIT_BYTES`. When the file grows past that,
 *     it's rotated to `audit.log.1` (overwriting any previous rotation) and
 *     a fresh log starts. This is the simplest scheme that prevents the file
 *     from growing without bound; users who need durable history can copy
 *     `audit.log` out before rotation.
 *   - Command strings are redacted before being written. We don't try to
 *     parse a shell grammar — we look for well-known secret-bearing patterns
 *     (`--token=…`, `password=…`, bearer headers, etc.) and replace the
 *     value with `***`. Commit hash-like values are NOT redacted.
 */

import { appendFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { makeDebug } from "./debug.js";

const dbg = makeDebug("audit");

/** Default maximum bytes before audit.log is rotated to audit.log.1. */
export const MAX_AUDIT_BYTES = 1_000_000;

/**
 * Override `MAX_AUDIT_BYTES` from `.pi-lean-flow/config.json` if the user has
 * set a positive `maxAuditBytes` value. Returns the default otherwise.
 */
function readMaxAuditBytes(cwd: string): number {
  try {
    const configPath = join(cwd, ".pi-lean-flow", "config.json");
    if (!existsSync(configPath)) return MAX_AUDIT_BYTES;
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return MAX_AUDIT_BYTES;
    }
    const v = (parsed as Record<string, unknown>).maxAuditBytes;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return Math.floor(v);
    }
    return MAX_AUDIT_BYTES;
  } catch {
    return MAX_AUDIT_BYTES;
  }
}

/**
 * Patterns whose value should be redacted before logging. Each entry is
 * `(prefix, secret)` — the prefix is preserved so the log stays grep-able,
 * the secret is replaced with `***`.
 *
 * This is a *best-effort* heuristic, not a sandbox. Custom flag names and
 * exotic config formats can slip through. Treat `audit.log` as potentially
 * sensitive regardless.
 */
const REDACT_PATTERNS: RegExp[] = [
  // --foo=value / --foo value — common flag names carrying secrets.
  // Recognises short (-p), long (--token), and many synonyms. `cookie`,
  // `private-key`, `client-secret`, `access-key` cover most real-world
  // CLIs (gh, aws, gcloud, npm publish, kubectl, etc).
  /(--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|client[-_]?secret|private[-_]?key|auth|bearer|cookie|session)[=\s])(\S+)/gi,
  // ENV-style assignment for well-known secret names (also catches PREFIX_TOKEN,
  // SOMETHING_SECRET, FOO_API_KEY, …): any uppercase identifier whose suffix
  // is a secret-bearing keyword.
  /\b((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|PASSWORD|PASSWD|SECRET|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|AUTH|BEARER|COOKIE|SESSION)=)([^\s'"]+)/g,
  // HTTP Authorization headers (Bearer / Basic / ApiKey schemes).
  /(Authorization:\s*(?:Bearer|Basic|ApiKey|Token)\s+)(\S+)/gi,
  // Custom auth headers — X-Api-Key, X-Auth-Token, etc.
  /(X-(?:Api-Key|Auth-Token|Access-Token|Secret)\s*:\s*)(\S+)/gi,
  // AWS access key IDs (start with AKIA or ASIA, 20 chars total).
  // We keep the prefix so the log is still useful for forensics.
  /\b((?:AKIA|ASIA))([A-Z0-9]{16})\b/g,
  // GitHub personal-access tokens (ghp_, ghs_, gho_, ghu_ prefixes).
  /\b((?:ghp|ghs|gho|ghu|ghr)_)([A-Za-z0-9]{20,})\b/g,
  // Slack bot/user tokens (xoxb-, xoxa-, xoxp-, xoxs-, xoxr-).
  /\b((?:xox[abprs])-)([A-Za-z0-9-]{10,})\b/g,
];

export function redactCommand(command: string): string {
  let out = command;
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, (_m, prefix: string) => `${prefix}***`);
  }
  return out;
}

// In-memory serialisation queue per cwd. Two parallel appendAuditLog calls
// chain instead of racing for the same file handle.
const queues = new Map<string, Promise<unknown>>();

async function rotateIfNeeded(logPath: string, capBytes: number): Promise<void> {
  let size = 0;
  try {
    const s = await stat(logPath);
    size = s.size;
  } catch {
    // Missing file — nothing to rotate.
    return;
  }
  if (size <= capBytes) return;

  const rotated = `${logPath}.1`;
  // Overwrite any previous rotation so we keep at most two generations.
  try {
    await unlink(rotated);
  } catch {
    // ok: previous rotation may not exist
  }
  try {
    await rename(logPath, rotated);
    dbg(`rotated audit log: ${logPath} → ${rotated} (size=${size})`);
  } catch (err) {
    dbg(`audit log rotation failed: ${(err as Error).message}`);
  }
}

/**
 * Remove `audit.log` and the rotated `audit.log.1` (if present) from
 * `<cwd>/.pi-lean-flow/`. Returns how many files were actually unlinked.
 * Best-effort: missing files are silently ignored.
 *
 * Enters the same per-cwd write queue as {@link appendAuditLog} so a clear
 * cannot race with an in-flight append on the same path.
 */
export async function clearAuditLog(cwd: string): Promise<number> {
  const prev = queues.get(cwd) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const dir = join(cwd, ".pi-lean-flow");
      let removed = 0;
      for (const name of ["audit.log", "audit.log.1"]) {
        try {
          await unlink(join(dir, name));
          removed += 1;
        } catch {
          // ok: file may not exist
        }
      }
      return removed;
    });
  queues.set(
    cwd,
    next.finally(() => {
      if (queues.get(cwd) === next) queues.delete(cwd);
    }),
  );
  return next;
}

/**
 * Append one JSON-Lines record to `<cwd>/.pi-lean-flow/audit.log`.
 * Best-effort: a failure never propagates to the caller. Concurrent calls
 * for the same `cwd` are serialised; rotation is checked before each write.
 */
export async function appendAuditLog(
  cwd: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const prev = queues.get(cwd) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      try {
        const dir = join(cwd, ".pi-lean-flow");
        await mkdir(dir, { recursive: true });
        const logPath = join(dir, "audit.log");
        await rotateIfNeeded(logPath, readMaxAuditBytes(cwd));

        // Redact the command if present, leave everything else alone.
        const safeEntry = { ...entry };
        if (typeof safeEntry.command === "string") {
          safeEntry.command = redactCommand(safeEntry.command);
        }

        // Timestamp is owned by the logger — put it AFTER the spread so a
        // caller-supplied `timestamp` field can never override the real
        // wall-clock value (which would defeat audit trail).
        const line =
          JSON.stringify({ ...safeEntry, timestamp: new Date().toISOString() }) +
          "\n";
        await appendFile(logPath, line, "utf-8");
      } catch (err) {
        dbg(`audit log append failed: ${(err as Error).message}`);
      }
    });
  queues.set(
    cwd,
    next.finally(() => {
      if (queues.get(cwd) === next) queues.delete(cwd);
    }),
  );
  return next;
}
