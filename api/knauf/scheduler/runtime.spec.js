'use strict';

const { getSchedulerReadiness, parsePositiveIntegerSetting } = require('./runtime');

describe('scheduler worker runtime', () => {
  test.each([undefined, ''])('uses the default threshold when %p is omitted', (value) => {
    expect(parsePositiveIntegerSetting('THRESHOLD', value, 5)).toBe(5);
  });

  test.each(['0', '-1', '1.5', 'five', ' 5', '5 '])(
    'rejects an invalid explicit threshold %p',
    (value) => {
      expect(() => parsePositiveIntegerSetting('THRESHOLD', value, 5)).toThrow(
        'THRESHOLD must be a positive integer',
      );
    },
  );

  test('accepts a positive integer threshold', () => {
    expect(parsePositiveIntegerSetting('THRESHOLD', '3', 5)).toBe(3);
  });

  test('is not ready before worker progress or without MongoDB', () => {
    expect(
      getSchedulerReadiness({
        mongoConnected: true,
        lastProgressAt: null,
        staleAfterMs: 30_000,
      }).ready,
    ).toBe(false);
    expect(
      getSchedulerReadiness({
        mongoConnected: false,
        lastProgressAt: new Date(),
        staleAfterMs: 30_000,
      }).ready,
    ).toBe(false);
  });

  test('reports fresh progress as ready and stale progress as not ready', () => {
    const now = () => new Date('2026-05-15T10:00:30.000Z').getTime();
    expect(
      getSchedulerReadiness({
        mongoConnected: true,
        lastProgressAt: new Date('2026-05-15T10:00:20.000Z'),
        staleAfterMs: 30_000,
        now,
      }).ready,
    ).toBe(true);
    expect(
      getSchedulerReadiness({
        mongoConnected: true,
        lastProgressAt: new Date('2026-05-15T09:59:00.000Z'),
        staleAfterMs: 30_000,
        now,
      }).ready,
    ).toBe(false);
  });

  test('reports shutdown as not ready', () => {
    expect(
      getSchedulerReadiness({
        mongoConnected: true,
        lastProgressAt: new Date(),
        staleAfterMs: 30_000,
        stopping: true,
      }).ready,
    ).toBe(false);
  });
});
