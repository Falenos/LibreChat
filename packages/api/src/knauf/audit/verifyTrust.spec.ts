// [knauf] KK20-328 — trust policy for the admin verify endpoint.
import {
  auditRetentionScopeKey,
  signAuditCheckpoint,
  signAuditIntent,
} from '@librechat/data-schemas';
import type { AuditRetentionCheckpointState } from '@librechat/data-schemas';
import { getAuditCheckpointSigningKeys, resolveAuditRetentionTrust } from './verifyTrust';

const SCOPE = auditRetentionScopeKey('t1');
const base: AuditRetentionCheckpointState = {
  scopeKey: SCOPE,
  throughSeq: 10,
  prevHash: 'h10',
  purgedAt: new Date('2027-01-01'),
  totalDeleted: 10,
  recoveredCommits: 0,
  lastFence: 3,
  pending: null,
};
const intent = {
  throughSeq: 25,
  prevHash: 'h25',
  startedAt: new Date('2027-01-02'),
  cutoff: new Date('2026-01-02'),
  owner: 'host:1',
  fence: 4,
};
const lookup = (state?: AuditRetentionCheckpointState) => async () => state;

describe('resolveAuditRetentionTrust', () => {
  it('never purged: no checkpoint offered, intent flagged', async () => {
    expect(
      await resolveAuditRetentionTrust({
        tenantId: 't1',
        getAuditRetentionCheckpoint: lookup(undefined),
      }),
    ).toEqual({ retention: { state: 'never-purged', pendingIntent: false } });
    const intentOnly = { ...base, purgedAt: undefined, throughSeq: 0, pending: intent };
    const r = await resolveAuditRetentionTrust({
      tenantId: 't1',
      getAuditRetentionCheckpoint: lookup(intentOnly),
    });
    expect(r.retention).toEqual({ state: 'never-purged', pendingIntent: true });
    expect(r.trustedCheckpoint).toBeUndefined();
    expect(r.pendingCheckpoint).toEqual({ throughSeq: 25, prevHash: 'h25' }); // unsigned mode
  });

  it('no key configured ⇒ unsigned, trusted, reported as unsigned', async () => {
    const r = await resolveAuditRetentionTrust({
      tenantId: 't1',
      getAuditRetentionCheckpoint: lookup(base),
    });
    expect(r.trustedCheckpoint).toEqual({ throughSeq: 10, prevHash: 'h10' });
    expect(r.retention).toEqual(
      expect.objectContaining({ state: 'active', signature: 'unsigned' }),
    );
  });

  it('key configured, valid signature ⇒ trusted', async () => {
    const signed = { ...base, signature: signAuditCheckpoint(base, 'k1') };
    const r = await resolveAuditRetentionTrust({
      tenantId: 't1',
      getAuditRetentionCheckpoint: lookup(signed),
      signingKeys: { current: 'k1' },
    });
    expect(r.trustedCheckpoint).toBeDefined();
    expect(r.retention.signature).toBe('valid');
  });

  it('key configured, checkpoint predates the key ⇒ MISSING, not trusted, not "tampered"', async () => {
    const r = await resolveAuditRetentionTrust({
      tenantId: 't1',
      getAuditRetentionCheckpoint: lookup(base),
      signingKeys: { current: 'k1' },
    });
    expect(r.trustedCheckpoint).toBeUndefined();
    expect(r.retention.signature).toBe('missing');
  });

  it('edited boundary ⇒ INVALID, not trusted', async () => {
    const tampered = { ...base, signature: signAuditCheckpoint(base, 'k1'), throughSeq: 12 };
    const r = await resolveAuditRetentionTrust({
      tenantId: 't1',
      getAuditRetentionCheckpoint: lookup(tampered),
      signingKeys: { current: 'k1' },
    });
    expect(r.trustedCheckpoint).toBeUndefined();
    expect(r.retention.signature).toBe('invalid');
  });

  it('rotation: a checkpoint signed with the previous key stays trusted', async () => {
    const signed = { ...base, signature: signAuditCheckpoint(base, 'old') };
    const r = await resolveAuditRetentionTrust({
      tenantId: 't1',
      getAuditRetentionCheckpoint: lookup(signed),
      signingKeys: { current: 'new', previous: 'old' },
    });
    expect(r.trustedCheckpoint).toBeDefined();
    expect(r.retention.signature).toBe('valid');
  });

  it('pending intent is offered only when its own signature is trustworthy', async () => {
    const signedIntent = {
      ...intent,
      signature: signAuditIntent({ scopeKey: SCOPE, ...intent }, 'k1'),
    };
    const ok = await resolveAuditRetentionTrust({
      tenantId: 't1',
      getAuditRetentionCheckpoint: lookup({ ...base, pending: signedIntent }),
      signingKeys: { current: 'k1' },
    });
    expect(ok.pendingCheckpoint).toEqual({ throughSeq: 25, prevHash: 'h25' });
    expect(ok.retention.pendingIntent).toBe(true);
    const forged = await resolveAuditRetentionTrust({
      tenantId: 't1',
      getAuditRetentionCheckpoint: lookup({ ...base, pending: intent }),
      signingKeys: { current: 'k1' },
    });
    expect(forged.pendingCheckpoint).toBeUndefined();
    expect(forged.retention.pendingIntent).toBe(true);
  });

  it('platform scope uses the platform chain key', async () => {
    const seen: string[] = [];
    await resolveAuditRetentionTrust({
      getAuditRetentionCheckpoint: async (k) => {
        seen.push(k);
        return undefined;
      },
    });
    expect(seen).toEqual([auditRetentionScopeKey(undefined)]);
  });
});

describe('getAuditCheckpointSigningKeys', () => {
  it('reads current and previous, dropping blanks', () => {
    expect(getAuditCheckpointSigningKeys({})).toEqual({});
    expect(getAuditCheckpointSigningKeys({ KNAUF_AUDIT_CHECKPOINT_HMAC_KEY: 'a' })).toEqual({
      current: 'a',
    });
    expect(
      getAuditCheckpointSigningKeys({
        KNAUF_AUDIT_CHECKPOINT_HMAC_KEY: 'a',
        KNAUF_AUDIT_CHECKPOINT_HMAC_KEY_PREVIOUS: '',
      }),
    ).toEqual({ current: 'a' });
    expect(
      getAuditCheckpointSigningKeys({
        KNAUF_AUDIT_CHECKPOINT_HMAC_KEY: 'a',
        KNAUF_AUDIT_CHECKPOINT_HMAC_KEY_PREVIOUS: 'b',
      }),
    ).toEqual({ current: 'a', previous: 'b' });
  });
});
// End [knauf]
