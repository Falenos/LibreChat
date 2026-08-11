'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applySchedulerInterfaceFlag, isSchedulerApiEnabled } = require('~/knauf/scheduler/config');

describe('scheduler configuration', () => {
  test('keeps the custom-config seam wired before schema validation', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../server/services/Config/loadCustomConfig.js'),
      'utf8',
    );
    expect(source.indexOf('applySchedulerInterfaceFlag(customConfig)')).toBeGreaterThan(-1);
    expect(source.indexOf('applySchedulerInterfaceFlag(customConfig)')).toBeLessThan(
      source.indexOf('configSchema.strict().safeParse(customConfig)'),
    );
  });

  test('keeps the API and interface dark unless explicitly enabled', () => {
    const config = { interface: { knauf: { scheduler: false } } };

    expect(isSchedulerApiEnabled(undefined)).toBe(false);
    expect(applySchedulerInterfaceFlag(config, undefined)).toBe(config);
    expect(config.interface.knauf.scheduler).toBe(false);
  });

  test('enables the interface with the same explicit flag as the API', () => {
    const config = {};

    expect(isSchedulerApiEnabled('true')).toBe(true);
    expect(applySchedulerInterfaceFlag(config, 'true')).toBe(config);
    expect(config.interface.knauf.scheduler).toBe(true);
  });
});
