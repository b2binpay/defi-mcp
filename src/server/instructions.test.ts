import { describe, expect, it } from 'vitest';
import { composeInstructions, LOCAL_INSTRUCTIONS } from './instructions.js';

describe('LOCAL_INSTRUCTIONS', () => {
  it('names no retired backend tool', () => {
    for (const retired of ['get_account_details', 'get_queue_details', 'get_queue`']) {
      expect(LOCAL_INSTRUCTIONS).not.toContain(retired);
    }
  });

  it('does not enumerate the backend read/write surface — that is the backend instructions and tools/list', () => {
    const backendReads = [
      'get_account_balances',
      'list_invoices',
      'get_invoice',
      'list_claimable_currencies',
      'create_invoice',
    ];
    for (const name of backendReads) {
      expect(LOCAL_INSTRUCTIONS).not.toContain(name);
    }

    expect(LOCAL_INSTRUCTIONS).toContain('tools/list');
  });

  it('keeps the local concerns it owns: keystore, the signing loop, claiming, identities and safety', () => {
    for (const local of [
      'select_account',
      'review_operation',
      'sign_operation',
      'execute_operation',
      'deploy_account',
      'claim',
    ]) {
      expect(LOCAL_INSTRUCTIONS).toContain(local);
    }

    expect(LOCAL_INSTRUCTIONS).toContain('keystore');
    expect(LOCAL_INSTRUCTIONS).toContain('threshold');
  });
});

describe('LOCAL_INSTRUCTIONS signing safety', () => {
  it('puts the review before signing and treats proposer fields as unverified', () => {
    expect(LOCAL_INSTRUCTIONS.indexOf('review_operation(operationId)')).toBeLessThan(
      LOCAL_INSTRUCTIONS.indexOf('sign_operation(operationId, confirm)'),
    );
    expect(LOCAL_INSTRUCTIONS).toContain('not verified');
    expect(LOCAL_INSTRUCTIONS).toContain('allowUnknownCalls');
    expect(LOCAL_INSTRUCTIONS).toContain('never auto-approve');
    expect(LOCAL_INSTRUCTIONS).not.toContain('whatever proposed it');
  });
});

describe('composeInstructions', () => {
  it('returns local instructions when the backend provides none', () => {
    expect(composeInstructions()).toBe(LOCAL_INSTRUCTIONS);
    expect(composeInstructions('   ')).toBe(LOCAL_INSTRUCTIONS);
  });

  it('prepends backend instructions ahead of the local ones', () => {
    const merged = composeInstructions('Backend domain guide.');
    expect(merged.startsWith('Backend domain guide.\n\n')).toBe(true);
    expect(merged.endsWith(LOCAL_INSTRUCTIONS)).toBe(true);
  });
});
