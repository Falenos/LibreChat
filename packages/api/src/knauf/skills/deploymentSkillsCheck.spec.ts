/**
 * [knauf] KK20-243 — unit tests for the boot-time deployment-skill check.
 *
 * The check exists because a shadowed `/app/skill` produces a *successful* boot
 * with the feature silently gone. These tests pin the two things that make it
 * useful: the classification (missing vs unexpected vs ok) and the log level,
 * since an `info` on a missing skill would defeat the entire purpose.
 */
import { logger } from '@librechat/data-schemas';
import {
  KNAUF_EXPECTED_DEPLOYMENT_SKILLS,
  checkDeploymentSkills,
  reportDeploymentSkillCheck,
  verifyDeploymentSkills,
} from './deploymentSkillsCheck';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

const DIRECTORY = '/app/skill';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('[knauf] KNAUF_EXPECTED_DEPLOYMENT_SKILLS', () => {
  it('lists the skills this image ships', () => {
    expect([...KNAUF_EXPECTED_DEPLOYMENT_SKILLS].sort()).toEqual([
      'agent-builder-coach',
      'karl-artifacts',
      'karl-brand',
      // [knauf] KK20-257 — the code-execution skills ship now that the adapter does.
      'karl-data-analysis',
      'karl-guide',
      'karl-mermaid',
      'karl-xlsx',
      // End [knauf]
      'web-research',
    ]);
  });

  it('is frozen, so a caller cannot mutate the expected set at runtime', () => {
    expect(Object.isFrozen(KNAUF_EXPECTED_DEPLOYMENT_SKILLS)).toBe(true);
  });
});

describe('[knauf] checkDeploymentSkills', () => {
  it('passes when exactly the expected skills loaded', () => {
    const result = checkDeploymentSkills({
      loadedNames: KNAUF_EXPECTED_DEPLOYMENT_SKILLS,
      directory: DIRECTORY,
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    // Sorted, so the log line is stable across load order.
    expect(result.loaded).toEqual([...KNAUF_EXPECTED_DEPLOYMENT_SKILLS].sort());
    expect(result.directory).toBe(DIRECTORY);
  });

  it('reports every expected skill as missing when the directory is empty', () => {
    // The shadowed-volume case: boot succeeds, registry is empty.
    const result = checkDeploymentSkills({ loadedNames: [], directory: DIRECTORY });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...KNAUF_EXPECTED_DEPLOYMENT_SKILLS].sort());
    expect(result.loaded).toEqual([]);
  });

  it('reports a partial load', () => {
    const result = checkDeploymentSkills({
      loadedNames: KNAUF_EXPECTED_DEPLOYMENT_SKILLS.filter((name) => name !== 'karl-brand'),
      directory: DIRECTORY,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['karl-brand']);
    expect(result.unexpected).toEqual([]);
  });

  it('treats an unlisted skill as informational, not a failure', () => {
    // Enabling a parked skill before updating the constant must not page anyone —
    // CI already forces the constant to be updated. (`karl-data-analysis` played
    // this role until KK20-257 shipped it; use a still-parked name instead.)
    const result = checkDeploymentSkills({
      loadedNames: [...KNAUF_EXPECTED_DEPLOYMENT_SKILLS, 'karl-not-yet-enabled'],
      directory: DIRECTORY,
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual(['karl-not-yet-enabled']);
  });

  it('distinguishes missing from unexpected when a skill is renamed', () => {
    // A rename mints a new skill id and drops per-user active state, so surfacing
    // both halves is what makes the log actionable.
    const result = checkDeploymentSkills({
      loadedNames: KNAUF_EXPECTED_DEPLOYMENT_SKILLS.map((name) =>
        name === 'karl-brand' ? 'karl-branding' : name,
      ),
      directory: DIRECTORY,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['karl-brand']);
    expect(result.unexpected).toEqual(['karl-branding']);
  });

  it('de-duplicates loaded names rather than reporting a false miss', () => {
    const result = checkDeploymentSkills({
      loadedNames: [...KNAUF_EXPECTED_DEPLOYMENT_SKILLS, 'karl-brand'],
      directory: DIRECTORY,
    });
    expect(result.ok).toBe(true);
    expect(result.loaded).toEqual([...KNAUF_EXPECTED_DEPLOYMENT_SKILLS].sort());
  });

  it('honours an explicit expected set', () => {
    const result = checkDeploymentSkills({
      loadedNames: ['only-this'],
      directory: DIRECTORY,
      expected: ['only-this'],
    });
    expect(result.ok).toBe(true);
  });

  it('passes trivially when nothing is expected', () => {
    const result = checkDeploymentSkills({
      loadedNames: [],
      directory: DIRECTORY,
      expected: [],
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('does not mutate its input', () => {
    const loadedNames = ['karl-brand'];
    checkDeploymentSkills({ loadedNames, directory: DIRECTORY });
    expect(loadedNames).toEqual(['karl-brand']);
  });
});

describe('[knauf] reportDeploymentSkillCheck', () => {
  it('logs a greppable positive line on success', () => {
    // Operators need something to confirm, because absence of errors cannot
    // distinguish "loaded fine" from "check never ran".
    reportDeploymentSkillCheck(
      checkDeploymentSkills({
        loadedNames: KNAUF_EXPECTED_DEPLOYMENT_SKILLS,
        directory: DIRECTORY,
      }),
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const [message] = mockLogger.info.mock.calls[0];
    expect(message).toContain('OK');
    expect(message).toContain(DIRECTORY);
    expect(message).toContain([...KNAUF_EXPECTED_DEPLOYMENT_SKILLS].sort().join(', '));
  });

  it('logs at ERROR — not warn or info — when skills are missing', () => {
    // The whole point. A warn would sit in the noise floor; an info would be
    // exactly the silent failure this check replaces.
    reportDeploymentSkillCheck(checkDeploymentSkills({ loadedNames: [], directory: DIRECTORY }));
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('names the mount hypothesis when nothing loaded', () => {
    reportDeploymentSkillCheck(checkDeploymentSkills({ loadedNames: [], directory: DIRECTORY }));
    const [message] = mockLogger.error.mock.calls[0];
    expect(message).toContain('NO skills loaded');
    expect(message).toContain('/app/skill');
    expect(message).toContain('DEPLOYMENT_SKILLS_DIR');
    // Must say the app still works, so nobody escalates this to an outage.
    expect(message).toContain('Artifacts still work');
    expect(message).toContain('Mermaid guidance');
  });

  it('points at the directory rather than the mount on a partial load', () => {
    reportDeploymentSkillCheck(
      checkDeploymentSkills({ loadedNames: ['karl-artifacts'], directory: DIRECTORY }),
    );
    const [message] = mockLogger.error.mock.calls[0];
    expect(message).toContain('karl-brand');
    expect(message).toContain('Loaded: karl-artifacts');
    expect(message).not.toContain('NO skills loaded');
  });

  it('logs unexpected skills as info even when the check passes', () => {
    reportDeploymentSkillCheck(
      checkDeploymentSkills({
        loadedNames: [...KNAUF_EXPECTED_DEPLOYMENT_SKILLS, 'extra-skill'],
        directory: DIRECTORY,
      }),
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(2);
    expect(mockLogger.info.mock.calls[0][0]).toContain('extra-skill');
  });
});

describe('[knauf] verifyDeploymentSkills', () => {
  it('compares, logs and returns the result', () => {
    const result = verifyDeploymentSkills({
      loadedNames: KNAUF_EXPECTED_DEPLOYMENT_SKILLS,
      directory: DIRECTORY,
    });
    expect(result.ok).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
  });

  it('never throws on a failed check, so a missing skill cannot crashloop the pod', () => {
    // Non-fatal by design: chat, agents and file search are unaffected, so the
    // correct posture is degraded-and-noisy rather than down.
    expect(() => verifyDeploymentSkills({ loadedNames: [], directory: DIRECTORY })).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});
