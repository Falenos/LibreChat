import {
  formatOneTrustConsentState,
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

  it('falls back to window OptanonActiveGroups when OneTrust uses the legacy global', () => {
    expect(getOneTrustGroupsFromEvent(undefined, { OptanonActiveGroups: ',C0002,C0003,' })).toEqual(
      new Set(['C0002', 'C0003']),
    );
  });

  it('detects analytics consent for the configured category', () => {
    expect(hasAnalyticsConsent(new Set(['C0001', 'C0002']), 'C0002')).toBe(true);
    expect(hasAnalyticsConsent(new Set(['C0001']), 'C0002')).toBe(false);
  });

  it('formats OneTrust active groups for Adobe Launch consent checks', () => {
    expect(formatOneTrustConsentState(new Set(['C0001', 'C0002']))).toBe(',C0001,C0002,');
    expect(formatOneTrustConsentState(new Set())).toBe('');
  });
});
