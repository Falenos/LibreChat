import { describe, expect, it } from 'vitest';
import {
  deriveSessionId,
  isValidSessionId,
  mintSessionId,
  parseIdentity,
  sanitizeFilename,
  sessionBelongsTo,
  ValidationError,
} from '../../src/validate.js';

const SECRET = 'test-session-secret';

describe('session ids', () => {
  it('mints karl-<32hex> ids that validate', () => {
    const id = mintSessionId('user-1', SECRET);
    expect(id).toMatch(/^karl-[0-9a-f]{32}$/);
    expect(isValidSessionId(id)).toBe(true);
  });

  it('mints unique ids for one user', () => {
    const a = mintSessionId('user-1', SECRET);
    const b = mintSessionId('user-1', SECRET);
    expect(a).not.toBe(b);
  });

  it('rejects foreign ids', () => {
    expect(isValidSessionId('conv-1234')).toBe(false);
    expect(isValidSessionId('karl-XYZ')).toBe(false);
    expect(isValidSessionId('karl-' + 'a'.repeat(31))).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
  });
});

/**
 * The sandbox is the isolation boundary — whoever names a session id gets its /mnt/data.
 * `/exec` accepts a caller-supplied id, so an id must prove whose it is.
 */
describe('session ownership', () => {
  it('recognises a caller’s own minted id', () => {
    const id = mintSessionId('user-1', SECRET);
    expect(sessionBelongsTo(id, 'user-1', SECRET)).toBe(true);
  });

  it('rejects another user’s minted id', () => {
    const victim = mintSessionId('user-victim', SECRET);
    expect(sessionBelongsTo(victim, 'user-attacker', SECRET)).toBe(false);
  });

  it('rejects another user’s hint-derived id', () => {
    // Same conversation, two users: without userId in the derivation both would land in
    // one sandbox and read each other's files.
    const victim = deriveSessionId('thread-abc', SECRET, 'user-victim');
    const attacker = deriveSessionId('thread-abc', SECRET, 'user-attacker');
    expect(victim).not.toBe(attacker);
    expect(sessionBelongsTo(victim, 'user-attacker', SECRET)).toBe(false);
  });

  it('derives the same id for the same user and hint (continuity)', () => {
    expect(deriveSessionId('thread-abc', SECRET, 'user-1')).toBe(
      deriveSessionId('thread-abc', SECRET, 'user-1'),
    );
  });

  it('keeps derived ids inside the karl-<32hex> namespace', () => {
    const id = deriveSessionId('thread-abc', SECRET, 'user-1');
    expect(isValidSessionId(id)).toBe(true);
  });

  it('does not leak the hint into the id', () => {
    // The hint is a LibreChat conversation id; it must not reach Azure resource names.
    expect(deriveSessionId('thread-abc', SECRET, 'user-1')).not.toContain('thread-abc');
  });
});

describe('parseIdentity (mirrors codeapi rules + wording)', () => {
  it('accepts user/agent without version', () => {
    expect(parseIdentity({ kind: 'user', id: 'u1' })).toEqual({ kind: 'user', id: 'u1' });
    expect(parseIdentity({ kind: 'agent', id: 'a1' })).toEqual({ kind: 'agent', id: 'a1' });
  });

  it('requires version for skill', () => {
    expect(parseIdentity({ kind: 'skill', id: 's1', version: '3' })).toEqual({
      kind: 'skill',
      id: 's1',
      version: 3,
    });
    expect(() => parseIdentity({ kind: 'skill', id: 's1' })).toThrow(
      'kind "skill" requires a numeric version',
    );
  });

  it('forbids version for non-skill kinds', () => {
    expect(() => parseIdentity({ kind: 'agent', id: 'a1', version: '1' })).toThrow(
      'version is only valid for kind "skill"',
    );
  });

  it('uses the codeapi 400 wording for a bad kind', () => {
    try {
      parseIdentity({ kind: 'bogus', id: 'x' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toBe('kind must be one of: skill, agent, user');
    }
  });

  it('requires id', () => {
    expect(() => parseIdentity({ kind: 'user' })).toThrow('missing id for kind "user"');
  });
});

describe('sanitizeFilename (mirrors form.ts rules)', () => {
  it('accepts nested relative paths', () => {
    expect(sanitizeFilename('reports/out.png')).toBe('reports/out.png');
    expect(sanitizeFilename('data.csv')).toBe('data.csv');
  });

  it('rejects traversal and absolute paths', () => {
    expect(() => sanitizeFilename('../etc/passwd')).toThrow(ValidationError);
    expect(() => sanitizeFilename('a/../b')).toThrow(ValidationError);
    expect(() => sanitizeFilename('/etc/passwd')).toThrow(ValidationError);
    expect(() => sanitizeFilename('~/x')).toThrow(ValidationError);
    expect(() => sanitizeFilename('a//b')).toThrow(ValidationError);
  });

  it('rejects control characters, backslashes, and double-quotes', () => {
    expect(() => sanitizeFilename('bad\u0000name')).toThrow(ValidationError);
    expect(() => sanitizeFilename('win\\path')).toThrow(ValidationError);
    expect(() => sanitizeFilename('a\nb.csv')).toThrow(ValidationError);
    // a double-quote would break the multipart Content-Disposition filename="…"
    expect(() => sanitizeFilename('a"b.csv')).toThrow(ValidationError);
  });
});
