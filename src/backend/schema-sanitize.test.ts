import { describe, expect, it } from 'vitest';
import { sanitizeToolSchema } from './schema-sanitize.js';

describe('sanitizeToolSchema', () => {
  it('inlines $ref/$defs and strips $schema', () => {
    const input = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        approvers: { type: 'array', items: { $ref: '#/$defs/UniversalAddress' } },
      },
      $defs: {
        UniversalAddress: { anyOf: [{ type: 'string' }, { type: 'string', pattern: '^T' }] },
      },
    };

    const out = sanitizeToolSchema(input);
    const json = JSON.stringify(out);

    expect(json).not.toContain('$schema');
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('$defs');
    expect(out).toMatchObject({
      type: 'object',
      properties: {
        approvers: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'string', pattern: '^T' }] } },
      },
    });
  });

  it('adds a root type when missing and leaves clean schemas intact', () => {
    expect(sanitizeToolSchema({ properties: {} })).toMatchObject({ type: 'object' });
    const clean = { type: 'object', properties: { operationId: { type: 'string' } }, additionalProperties: false };
    expect(sanitizeToolSchema(clean)).toEqual(clean);
  });

  it('strips example and non-array examples (invalid per draft 2020-12)', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      properties: {
        a: { type: 'string', example: '1', examples: '1' },
        b: { type: 'string', examples: ['x', 'y'] },
      },
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string', examples: ['x', 'y'] },
      },
    });
  });

  it('replaces an unresolvable $ref with a permissive schema', () => {
    const out = sanitizeToolSchema({ type: 'object', properties: { x: { $ref: '#/$defs/Missing' } } });
    expect(out).toEqual({ type: 'object', properties: { x: {} } });
  });
});
