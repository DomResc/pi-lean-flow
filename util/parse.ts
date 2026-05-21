/**
 * parse.ts — Slash-command argument parsing helpers.
 *
 * The slash commands accept simple `field=value field=value …` syntax. We
 * don't want a full shell grammar but we do want:
 *   - case-insensitive field names (so a `Description=…` typo isn't silently
 *     dropped),
 *   - quote stripping (so `description="implement foo bar"` doesn't keep
 *     literal quotes in the persisted value),
 *   - reuse across `/lean-task-add`, `/lean-task-edit`, and any future
 *     field-bearing slash command.
 */

/** Map from canonical field name to the regex alternatives accepted. */
export interface TaskFieldUpdates {
  description?: string;
  acceptanceCriteria?: string;
  notes?: string;
}

/** Result of {@link parseTaskFields}. */
export interface ParseTaskFieldsResult {
  updates: TaskFieldUpdates;
  /** Field names the parser saw but with an empty value. */
  emptyFields: string[];
}

const FIELD_ALIASES: Record<string, keyof TaskFieldUpdates> = {
  description: "description",
  criteria: "acceptanceCriteria",
  notes: "notes",
};

/**
 * Strip a single matched pair of surrounding quotes (`"…"` or `'…'`). Inner
 * quotes are preserved. We do *not* parse escapes — slash commands are
 * single-line and the LLM/user is free to use the other quote style for
 * literal inner quotes.
 */
export function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a slash-command tail of the form `field=value [field=value …]`
 * (case-insensitive field names, optional surrounding quotes per value).
 * Empty values are not assigned but tracked separately in `emptyFields`
 * so callers can choose to reject them.
 *
 * Recognised field aliases:
 *   - description / Description / DESCRIPTION
 *   - criteria    → maps to `acceptanceCriteria`
 *   - notes
 */
export function parseTaskFields(input: string): ParseTaskFieldsResult {
  const aliases = Object.keys(FIELD_ALIASES);
  // Build a single regex that matches any field token (case-insensitive) and
  // captures the value up to the next field token or EOL.
  //
  // Important: we deliberately *don't* eat whitespace after `=`. If we did,
  // an empty value followed by another field (`description= criteria=foo`)
  // would leave the lookahead unable to see the `\s+` it needs to anchor
  // the next field. We rely on `.trim()` on the captured value instead.
  const fieldGroup = `(?:${aliases.join("|")})`;
  const regex = new RegExp(
    `(${fieldGroup})\\s*=(.*?)(?=\\s+${fieldGroup}\\s*=|$)`,
    "gi",
  );

  const updates: TaskFieldUpdates = {};
  const emptyFields: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(input)) !== null) {
    const aliasKey = m[1].toLowerCase();
    const canonical = FIELD_ALIASES[aliasKey];
    if (!canonical) continue;
    const stripped = stripQuotes(m[2].trim()).trim();
    if (stripped.length === 0) {
      // Report the alias the user actually typed so error messages can echo
      // it back; we keep it lowercase for consistency.
      emptyFields.push(aliasKey);
      continue;
    }
    updates[canonical] = stripped;
  }
  return { updates, emptyFields };
}
