/**
 * Minimal JSON Schema validator.
 *
 * Maps to Pi's `validateToolArguments` (agent-loop.ts L618, from pi-ai, implemented with typebox).
 * The teaching version implements only the subset this course needs: object type, per-field type checks, required checks.
 * From Chapter 04, tool argument validation joins the pipeline; this is a pure function so it can be tested on its own.
 */
import type { Tool, ToolParameters } from "./types.ts";

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** Validates tool arguments against the schema (Pi `validateToolArguments`, agent-loop.ts L618). */
export function validateToolArguments(tool: Tool, args: unknown): ValidationResult {
  return validateObject(tool.parameters, args);
}

/** Validates one object schema (recursing down to the field level). */
function validateObject(schema: ToolParameters, value: unknown): ValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `Arguments must be an object, got ${describe(value)}` };
  }

  const record = value as Record<string, unknown>;

  // required check (Pi contract: a missing required field is rejected outright)
  for (const key of schema.required ?? []) {
    if (!(key in record)) {
      return { ok: false, error: `Missing required argument: ${key}` };
    }
  }

  // Field-level type check
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key in record) {
      const check = checkType(prop.type, record[key]);
      if (!check.ok) {
        return { ok: false, error: `Argument ${key} ${check.error}` };
      }
    }
  }

  return { ok: true };
}

/** Type check for a single field. */
function checkType(type: string, value: unknown): ValidationResult {
  const match = {
    string: typeof value === "string",
    number: typeof value === "number",
    boolean: typeof value === "boolean",
    integer: typeof value === "number" && Number.isInteger(value),
    object: typeof value === "object" && value !== null && !Array.isArray(value),
    array: Array.isArray(value),
  }[type];

  if (!match) {
    return { ok: false, error: `should be of type ${type}, got ${describe(value)}` };
  }
  return { ok: true };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}
