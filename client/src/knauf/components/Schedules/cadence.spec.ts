import type { LocalizeFunction } from '~/common';
import { describeCadence, formatScheduleDay, to12Hour, to24Hour } from './cadence';

const localize: LocalizeFunction = (key, options) => {
  const values = options as Record<string, string> | undefined;
  return [key, values?.minute, values?.time, values?.days].filter(Boolean).join('|');
};

describe('scheduler cadence', () => {
  it('converts noon and midnight without losing meridiem', () => {
    expect(to12Hour(0)).toEqual({ hour12: 12, meridiem: 'AM' });
    expect(to12Hour(12)).toEqual({ hour12: 12, meridiem: 'PM' });
    expect(to24Hour(12, 'AM')).toBe(0);
    expect(to24Hour(12, 'PM')).toBe(12);
  });

  it('describes hourly cadence with a zero-padded minute', () => {
    expect(describeCadence({ frequency: 'hourly', hour: 0, minute: 5 }, localize, 'en')).toBe(
      'com_knauf_scheduler_runs_hourly|05',
    );
  });

  it('uses Monday when a weekly cadence has no explicit day', () => {
    expect(describeCadence({ frequency: 'weekly', hour: 9, minute: 0 }, localize, 'en')).toContain(
      formatScheduleDay(1, 'en'),
    );
  });
});
