type JsonSchemaNode = Record<string, unknown>;

const MAX_DEPTH = 50;

function isObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(ref: string, defs: JsonSchemaNode): JsonSchemaNode | undefined {
  const name = ref.replace('#/$defs/', '').replace('#/definitions/', '');
  const target = defs[name];
  return isObject(target) ? target : undefined;
}

function walk(node: unknown, defs: JsonSchemaNode, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return {};
  }
  if (Array.isArray(node)) {
    return node.map((item) => walk(item, defs, depth + 1));
  }
  if (!isObject(node)) {
    return node;
  }
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, defs);
    return target ? walk(target, defs, depth + 1) : {};
  }
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    // Inside `properties`, the child keys are argument NAMES, not schema keywords — walk each
    // property's schema but never strip a property just because it is named `example`/`examples`.
    if (key === 'properties' && isObject(value)) {
      const properties: JsonSchemaNode = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        properties[propName] = walk(propSchema, defs, depth + 1);
      }
      out.properties = properties;
      continue;
    }
    // Strip meta keywords the Anthropic draft-2020-12 validator rejects: $ref/$defs
    // machinery, the $schema dialect marker, the non-standard OpenAPI `example`, and a
    // non-array `examples` (draft 2020-12 requires `examples` to be an array).
    if (key === '$schema' || key === '$defs' || key === 'definitions' || key === 'example') {
      continue;
    }
    if (key === 'examples' && !Array.isArray(value)) {
      continue;
    }
    out[key] = walk(value, defs, depth + 1);
  }
  return out;
}

/**
 * Normalize a backend tool's JSON Schema for the Anthropic tool-use validator: inline all
 * `$ref`/`$defs` (which the validator rejects) and strip the `$schema` keyword. The backend
 * still enforces the full Zod schema, so a slightly looser client-facing schema is safe.
 */
export function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  let defs: JsonSchemaNode = {};
  if (isObject(schema.$defs)) {
    defs = schema.$defs;
  } else if (isObject(schema.definitions)) {
    defs = schema.definitions;
  }
  const result = walk(schema, defs, 0);
  const normalized = isObject(result) ? result : { type: 'object' };
  if (!('type' in normalized)) {
    normalized.type = 'object';
  }
  return normalized;
}
