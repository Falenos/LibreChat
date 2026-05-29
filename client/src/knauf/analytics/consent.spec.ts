import {
  getOneTrustGroupsFromEvent,
  hasAnalyticsConsent,
  parseOneTrustGroups,
} from './consent';

describe('OneTrust consent helpers', () => {
  it('parses comma-delimited OneTrust active groups', () => {
    expect(parseOneTrustGroups(',C0001,C0002,')).toEqual(new Set(['C0001', 'C0002']));
  });

  it('parses OneTrustGroupsUpdated array details', () => {
    const event = new CustomEvent('OneTrustGroupsUpdated', {
      detail: ['C0001', 'C0002'],
    });

    expect(getOneTrustGroupsFromEvent(event, {})).toEqual(new Set(['C0001', 'C0002']));
  });

  it('falls back to window OnetrustActiveGroups when event detail is empty', () => {
    expect(
      getOneTrustGroupsFromEvent(undefined, { OnetrustActiveGroups: ',C0001,C0002,' }),
    ).toEqual(new Set(['C0001', 'C0002']));
  });

  it('detects analytics consent for the configured category', () => {
    expect(hasAnalyticsConsent(new Set(['C0001', 'C0002']), 'C0002')).toBe(true);
    expect(hasAnalyticsConsent(new Set(['C0001']), 'C0002')).toBe(false);
  });
});
