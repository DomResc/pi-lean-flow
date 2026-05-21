import { describe, it, expect } from "vitest";

import { parseTaskFields, stripQuotes } from "./parse.js";

describe("stripQuotes", () => {
  it("strips matching double quotes", () => {
    expect(stripQuotes('"hello world"')).toBe("hello world");
  });

  it("strips matching single quotes", () => {
    expect(stripQuotes("'hello world'")).toBe("hello world");
  });

  it("leaves unmatched quotes alone", () => {
    expect(stripQuotes('"hello')).toBe('"hello');
    expect(stripQuotes("hello'")).toBe("hello'");
    expect(stripQuotes(`"hello'`)).toBe(`"hello'`);
  });

  it("leaves naked strings alone", () => {
    expect(stripQuotes("plain")).toBe("plain");
    expect(stripQuotes("")).toBe("");
    expect(stripQuotes("x")).toBe("x");
  });

  it("preserves inner quotes of the other style", () => {
    expect(stripQuotes(`"don't"`)).toBe("don't");
    expect(stripQuotes(`'say "hi"'`)).toBe('say "hi"');
  });
});

describe("parseTaskFields", () => {
  it("parses simple field=value pairs", () => {
    const r = parseTaskFields("description=foo criteria=bar notes=baz");
    expect(r.updates).toEqual({
      description: "foo",
      acceptanceCriteria: "bar",
      notes: "baz",
    });
    expect(r.emptyFields).toEqual([]);
  });

  it("maps `criteria` to the canonical `acceptanceCriteria`", () => {
    const r = parseTaskFields("criteria=must work");
    expect(r.updates.acceptanceCriteria).toBe("must work");
    expect(r.updates).not.toHaveProperty("criteria");
  });

  it("is case-insensitive on field names", () => {
    const r = parseTaskFields("Description=foo CRITERIA=bar NoTeS=baz");
    expect(r.updates).toEqual({
      description: "foo",
      acceptanceCriteria: "bar",
      notes: "baz",
    });
  });

  it("strips surrounding double quotes from values", () => {
    const r = parseTaskFields('description="hello world"');
    expect(r.updates.description).toBe("hello world");
  });

  it("strips surrounding single quotes from values", () => {
    const r = parseTaskFields("description='hello world'");
    expect(r.updates.description).toBe("hello world");
  });

  it("does not strip mismatched quotes", () => {
    const r = parseTaskFields(`description="hello'`);
    expect(r.updates.description).toBe(`"hello'`);
  });

  it("records empty values without assigning the field", () => {
    const r = parseTaskFields("description= criteria=foo");
    expect(r.updates.description).toBeUndefined();
    expect(r.updates.acceptanceCriteria).toBe("foo");
    expect(r.emptyFields).toEqual(["description"]);
  });

  it("handles values containing spaces", () => {
    const r = parseTaskFields(
      "description=Implement the parser criteria=tests pass",
    );
    expect(r.updates.description).toBe("Implement the parser");
    expect(r.updates.acceptanceCriteria).toBe("tests pass");
  });

  it("handles values containing inner = signs", () => {
    const r = parseTaskFields("description=use a=b mapping");
    expect(r.updates.description).toBe("use a=b mapping");
  });

  it("returns nothing for input that has no field tokens", () => {
    const r = parseTaskFields("hello world this is not a field=value pair");
    // "field=value" *is* recognised — only `description|criteria|notes` are.
    expect(r.updates).toEqual({});
  });

  it("trims whitespace around the value", () => {
    const r = parseTaskFields("description=   foo bar   ");
    expect(r.updates.description).toBe("foo bar");
  });

  it("returns empty result for empty input", () => {
    const r = parseTaskFields("");
    expect(r.updates).toEqual({});
    expect(r.emptyFields).toEqual([]);
  });
});
