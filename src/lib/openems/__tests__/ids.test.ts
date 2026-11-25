import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  COMPONENT_ID_FORMAT_CONSTRAINT,
  EDGE_ID_FORMAT_CONSTRAINT,
  OPENEMS_ID_PATTERN,
  isIdFormatViolation,
  openEmsIdSchema,
  parseOpenEmsId,
} from "../ids";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../supabase/migrations");

/**
 * The pattern each CHECK holds in the newest migration that adds it, so a
 * later migration replacing a constraint is what this compares against.
 */
function newestSqlPattern(constraint: string): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  const addRe = new RegExp(
    `ADD CONSTRAINT ${constraint}\\s+CHECK\\s*\\(([\\s\\S]*?)\\)\\s*(?:NOT VALID)?;`
  );
  for (const file of files) {
    const match = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").match(addRe);
    if (!match) continue;
    const pattern = match[1].match(/~\s*'([^']*)'/);
    if (!pattern) throw new Error(`${file}: ${constraint} has no ~ '<pattern>'`);
    return pattern[1];
  }
  throw new Error(`no migration adds ${constraint}`);
}

describe("OPENEMS_ID_PATTERN", () => {
  it.each(["edges_openems_edge_id_format", "devices_openems_component_id_format"])(
    "is the pattern of the database's %s",
    (constraint) => {
      expect(newestSqlPattern(constraint)).toBe(OPENEMS_ID_PATTERN.source);
    }
  );

  it.each([
    "edge0",
    "meter1",
    "ess0",
    "SYNTHETIC-EDGE-550e8400-e29b-41d4-a716-446655440000",
    "fems:edge_0.a-1",
    "a",
    "e".repeat(64),
  ])("accepts %s", (id) => {
    expect(OPENEMS_ID_PATTERN.test(id)).toBe(true);
    expect(parseOpenEmsId(id)).toBe(id);
  });

  it.each([
    ["empty", ""],
    ["65 characters", "e".repeat(65)],
    ["a space inside", "edge 0"],
    ["a slash", "meter0/ActivePower"],
    ["a comma", "a,b"],
    ["a parenthesis", "meter0)"],
    ["a quote", "edge'0"],
    ["a non-ASCII letter", "édge0"],
    ["a newline inside", "edge\n0"],
  ])("refuses an id that is %s", (_label, id) => {
    expect(parseOpenEmsId(id)).toBeNull();
  });
});

describe("parseOpenEmsId", () => {
  it("trims before checking", () => {
    expect(parseOpenEmsId("  meter0\t")).toBe("meter0");
    expect(openEmsIdSchema.parse(" edge0 ")).toBe("edge0");
  });

  it("refuses an id that is only whitespace", () => {
    expect(parseOpenEmsId("   ")).toBeNull();
  });

  it.each([undefined, null, 7, {}, ["edge0"]])("refuses %j", (value) => {
    expect(parseOpenEmsId(value)).toBeNull();
  });
});

describe("isIdFormatViolation", () => {
  const edgeError = {
    code: "23514",
    message:
      'new row for relation "edges" violates check constraint "edges_openems_edge_id_format"',
  };

  it("is true for a check_violation naming the constraint", () => {
    expect(isIdFormatViolation(edgeError, EDGE_ID_FORMAT_CONSTRAINT)).toBe(true);
  });

  it("is false for the other constraint, another code or no error", () => {
    expect(isIdFormatViolation(edgeError, COMPONENT_ID_FORMAT_CONSTRAINT)).toBe(false);
    expect(
      isIdFormatViolation({ ...edgeError, code: "23505" }, EDGE_ID_FORMAT_CONSTRAINT)
    ).toBe(false);
    expect(isIdFormatViolation(null, EDGE_ID_FORMAT_CONSTRAINT)).toBe(false);
  });

  it.each([EDGE_ID_FORMAT_CONSTRAINT, COMPONENT_ID_FORMAT_CONSTRAINT])(
    "names a constraint the migrations add: %s",
    (constraint) => {
      expect(() => newestSqlPattern(constraint)).not.toThrow();
    }
  );
});
