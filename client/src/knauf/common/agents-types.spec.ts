import { knaufPersonalitySchema } from './agents-types';

describe('knaufPersonalitySchema', () => {
  it('accepts a valid personality with all fields', () => {
    const result = knaufPersonalitySchema.safeParse({
      name: 'karl-personality-balanced',
      label: 'Balanced',
      description: 'The everyday default.',
      preset: { model: 'gpt-4o', temperature: 0.7 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('karl-personality-balanced');
      expect(result.data.description).toBe('The everyday default.');
    }
  });

  it('accepts a personality without the optional description', () => {
    const result = knaufPersonalitySchema.safeParse({
      name: 'karl-personality-precise',
      label: 'Precise',
      preset: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects a name that does not start with the required prefix', () => {
    const result = knaufPersonalitySchema.safeParse({
      name: 'balanced',
      label: 'Balanced',
      preset: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing label', () => {
    const result = knaufPersonalitySchema.safeParse({
      name: 'karl-personality-precise',
      preset: {},
    });
    expect(result.success).toBe(false);
  });
});
