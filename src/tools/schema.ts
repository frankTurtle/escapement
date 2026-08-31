import type { JsonObject, JsonValue } from "../core/json.ts";
import { correctable, type EscapementError } from "../core/errors.ts";
import { ok, err, type Result } from "../core/result.ts";

/**
 * A deliberately small subset of JSON Schema.
 *
 * Two jobs, both of which argue for "small": it validates what the model sent,
 * and it is *rendered into the prompt*, where every keyword costs tokens the
 * context assembler has to budget for. A schema language rich enough to express
 * `oneOf` with `$ref` is a schema language that spends 400 tokens describing a
 * two-field function.
 *
 * Deliberately absent: `$ref`, `oneOf`/`anyOf`/`allOf`, and `pattern`. The first
 * two need a resolver and a satisfiability story; `pattern` means compiling a
 * model- or config-supplied regex, which is a ReDoS vector we decline to open.
 */
export type SchemaNode =
  | { readonly type: "string"; readonly description?: string; readonly enum?: readonly string[]; readonly minLength?: number; readonly maxLength?: number }
  | { readonly type: "number" | "integer"; readonly description?: string; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "boolean"; readonly description?: string }
  | { readonly type: "array"; readonly description?: string; readonly items: SchemaNode; readonly minItems?: number; readonly maxItems?: number }
  | { readonly type: "object"; readonly description?: string; readonly properties: Readonly<Record<string, SchemaNode>>; readonly required?: readonly string[]; readonly additionalProperties?: boolean };

export type ObjectSchema = Extract<SchemaNode, { type: "object" }>;

export type SchemaProblem = { readonly path: string; readonly message: string };

/**
 * Validate `value` against `schema`, collecting *every* problem rather than
 * stopping at the first.
 *
 * Collecting all of them is the whole point: the failure goes back to the model
 * as an observation (ADR-0005), and a model that is told about one missing
 * field at a time takes one round trip per field.
 */
export function validate(schema: SchemaNode, value: JsonValue, path = "$"): readonly SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const bad = (message: string): void => void problems.push({ path, message });

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return [{ path, message: `expected string, got ${typeName(value)}` }];
      if (schema.enum && !schema.enum.includes(value)) bad(`expected one of ${schema.enum.map((e) => `"${e}"`).join(", ")}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) bad(`shorter than minLength ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) bad(`longer than maxLength ${schema.maxLength}`);
      return problems;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number") return [{ path, message: `expected ${schema.type}, got ${typeName(value)}` }];
      if (schema.type === "integer" && !Number.isInteger(value)) bad("expected an integer");
      if (schema.minimum !== undefined && value < schema.minimum) bad(`below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) bad(`above maximum ${schema.maximum}`);
      return problems;
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [{ path, message: `expected boolean, got ${typeName(value)}` }];
    case "array": {
      if (!Array.isArray(value)) return [{ path, message: `expected array, got ${typeName(value)}` }];
      if (schema.minItems !== undefined && value.length < schema.minItems) bad(`fewer than minItems ${schema.minItems}`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) bad(`more than maxItems ${schema.maxItems}`);
      value.forEach((item, i) => problems.push(...validate(schema.items, item, `${path}[${i}]`)));
      return problems;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return [{ path, message: `expected object, got ${typeName(value)}` }];
      }
      const obj = value as JsonObject;
      for (const key of schema.required ?? []) {
        if (!(key in obj)) bad(`missing required property "${key}"`);
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        const present = obj[key];
        if (present !== undefined) problems.push(...validate(child, present, `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in schema.properties)) bad(`unexpected property "${key}"`);
        }
      }
      return problems;
    }
  }
}

/** Validation as a Result, with the problems already shaped for the model. */
export function validateArgs(
  toolName: string,
  schema: ObjectSchema,
  args: JsonObject,
): Result<JsonObject, EscapementError> {
  const problems = validate(schema, args);
  if (problems.length === 0) return ok(args);
  return err(
    correctable(
      "tool.invalid_arguments",
      `Invalid arguments for "${toolName}": ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`,
      { tool: toolName, problems: problems.map((p) => ({ path: p.path, message: p.message })) },
    ),
  );
}

/**
 * Render a schema as compact, prompt-shaped text.
 *
 * Not JSON. The model reads this, and a signature line plus prose costs roughly
 * a third of what the equivalent JSON Schema block costs — which the context
 * assembler charges against the tool-schema reserve either way.
 */
export function renderSchema(schema: SchemaNode): string {
  switch (schema.type) {
    case "object": {
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties).map(([key, child]) => {
        const optional = required.has(key) ? "" : "?";
        const note = child.description ? ` — ${child.description}` : "";
        return `${key}${optional}: ${renderSchema(child)}${note}`;
      });
      return `{ ${fields.join("; ")} }`;
    }
    case "array":
      return `${renderSchema(schema.items)}[]`;
    case "string":
      return schema.enum ? schema.enum.map((e) => `"${e}"`).join("|") : "string";
    default:
      return schema.type;
  }
}

function typeName(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
