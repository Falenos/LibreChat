import type { TMessage } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
// [knauf] Keep artifact source out of the screen-reader completion announcement. (NO-TICKET)
import {
  getAllContentText,
  isValidTimestamp,
  getMessageAriaLabel,
  getMessageTimestamp,
  getHeaderPrefixForScreenReader,
} from '../messages';
// End [knauf]

const translations: Record<string, string> = {
  com_endpoint_message: 'Message',
  com_endpoint_message_new: 'Message {{0}}',
  com_ui_prompt: 'Prompt',
  com_ui_response: 'Response',
};

const localize: LocalizeFunction = ((key: string, args?: Record<string, string | number>) => {
  const template = translations[key] ?? key;
  if (args) {
    return Object.entries(args).reduce(
      (result, [k, v]) => result.replace(`{{${k}}}`, String(v)),
      template,
    );
  }
  return template;
}) as LocalizeFunction;

const makeMessage = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'msg-1',
    isCreatedByUser: false,
    ...overrides,
  }) as TMessage;

describe('getMessageAriaLabel', () => {
  it('returns "Message N" when depth is present and valid', () => {
    const msg = makeMessage({ depth: 2 });
    expect(getMessageAriaLabel(msg, localize)).toBe('Message 3');
  });

  it('returns "Message" when depth is undefined', () => {
    const msg = makeMessage({ depth: undefined });
    expect(getMessageAriaLabel(msg, localize)).toBe('Message');
  });

  it('returns "Message" when depth is negative', () => {
    const msg = makeMessage({ depth: -1 });
    expect(getMessageAriaLabel(msg, localize)).toBe('Message');
  });

  it('returns "Message 1" for depth 0 (root message)', () => {
    const msg = makeMessage({ depth: 0 });
    expect(getMessageAriaLabel(msg, localize)).toBe('Message 1');
  });
});

describe('getHeaderPrefixForScreenReader', () => {
  it('returns "Prompt N: " for user messages with valid depth', () => {
    const msg = makeMessage({ isCreatedByUser: true, depth: 2 });
    expect(getHeaderPrefixForScreenReader(msg, localize)).toBe('Prompt 3: ');
  });

  it('returns "Response N: " for AI messages with valid depth', () => {
    const msg = makeMessage({ isCreatedByUser: false, depth: 0 });
    expect(getHeaderPrefixForScreenReader(msg, localize)).toBe('Response 1: ');
  });

  it('returns "Prompt: " for user messages without depth', () => {
    const msg = makeMessage({ isCreatedByUser: true, depth: undefined });
    expect(getHeaderPrefixForScreenReader(msg, localize)).toBe('Prompt: ');
  });

  it('returns "Response: " for AI messages without depth', () => {
    const msg = makeMessage({ isCreatedByUser: false, depth: undefined });
    expect(getHeaderPrefixForScreenReader(msg, localize)).toBe('Response: ');
  });

  it('omits number when depth is -1 (no "Prompt 0:" regression)', () => {
    const msg = makeMessage({ isCreatedByUser: true, depth: -1 });
    expect(getHeaderPrefixForScreenReader(msg, localize)).toBe('Prompt: ');
  });

  it('omits number when depth is negative', () => {
    const msg = makeMessage({ isCreatedByUser: false, depth: -5 });
    expect(getHeaderPrefixForScreenReader(msg, localize)).toBe('Response: ');
  });
});

// [knauf] Artifact cards are announced by the UI; their source must not be read aloud. (NO-TICKET)
describe('getAllContentText artifact announcements', () => {
  it('leaves ordinary response text unchanged', () => {
    expect(getAllContentText(makeMessage({ text: '  Ordinary response.  ' }))).toBe(
      '  Ordinary response.  ',
    );
  });

  it('keeps prose and removes a complete artifact directive', () => {
    const msg = makeMessage({
      text: [
        'Created the requested dashboard.',
        ':::artifact{identifier="dashboard" type="application/vnd.react" title="Dashboard"}',
        '```tsx',
        'export default function Dashboard() { return <main>Secret source</main>; }',
        '```',
        ':::',
        'You can open it from the card.',
      ].join('\n'),
    });

    expect(getAllContentText(msg)).toBe(
      'Created the requested dashboard.\nYou can open it from the card.',
    );
  });

  it('fails closed for an unterminated streaming artifact', () => {
    const msg = makeMessage({
      text: 'Ready.\n:::artifact{identifier="dashboard"}\nexport default function Dashboard() {}',
    });

    expect(getAllContentText(msg)).toBe('Ready.');
  });
});
// End [knauf]

describe('isValidTimestamp', () => {
  it('returns false for missing values', () => {
    expect(isValidTimestamp(undefined)).toBe(false);
    expect(isValidTimestamp(null)).toBe(false);
    expect(isValidTimestamp('')).toBe(false);
  });

  it('returns false for unparseable strings', () => {
    expect(isValidTimestamp('not-a-date')).toBe(false);
  });

  it('returns true for ISO date strings', () => {
    expect(isValidTimestamp('2026-06-12T15:42:00.000Z')).toBe(true);
  });
});

describe('getMessageTimestamp', () => {
  const NOW = new Date('2026-06-12T15:42:00.000Z').getTime();

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null for missing or invalid values', () => {
    expect(getMessageTimestamp(undefined, 'en-US')).toBeNull();
    expect(getMessageTimestamp(null, 'en-US')).toBeNull();
    expect(getMessageTimestamp('not-a-date', 'en-US')).toBeNull();
  });

  it('formats relative and absolute time for a recent message', () => {
    const twoHoursAgo = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const result = getMessageTimestamp(twoHoursAgo, 'en-US');
    expect(result).not.toBeNull();
    expect(result?.relative).toBe('2 hours ago');
    expect(result?.iso).toBe(twoHoursAgo);
    expect(result?.absolute).toContain('2026');
  });

  it('flags messages under 24h as recent (prefer relative)', () => {
    const justUnderADay = new Date(NOW - 23 * 60 * 60 * 1000).toISOString();
    expect(getMessageTimestamp(justUnderADay, 'en-US')?.isRecent).toBe(true);
  });

  it('flags older messages as not recent (prefer absolute date)', () => {
    const overADay = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(NOW - 38 * 24 * 60 * 60 * 1000).toISOString();
    expect(getMessageTimestamp(overADay, 'en-US')?.isRecent).toBe(false);
    expect(getMessageTimestamp(monthAgo, 'en-US')?.isRecent).toBe(false);
  });

  it('uses "now" for the current instant', () => {
    const result = getMessageTimestamp(new Date(NOW).toISOString(), 'en-US');
    expect(result?.relative).toBe('now');
    expect(result?.isRecent).toBe(true);
  });

  it('falls back to the default locale for a malformed locale tag', () => {
    const iso = new Date(NOW - 60 * 1000).toISOString();
    expect(() => getMessageTimestamp(iso, 'not a locale!!')).not.toThrow();
    expect(getMessageTimestamp(iso, 'not a locale!!')).not.toBeNull();
  });
});
