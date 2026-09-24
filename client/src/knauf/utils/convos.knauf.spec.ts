import type { TConversation } from 'librechat-data-provider';
import { dateKeys, groupConversationsByDate } from '~/utils/convos';

describe('KK20-385 conversation month ordering', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-11-15T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('orders localized current-year month groups independently of input order', () => {
    const conversations = [
      { conversationId: 'june', updatedAt: '2025-06-15T12:00:00.000Z' },
      { conversationId: 'august', updatedAt: '2025-08-15T12:00:00.000Z' },
    ];

    const grouped = groupConversationsByDate(conversations as TConversation[]);

    expect(grouped.map(([key]) => key)).toEqual([dateKeys.august, dateKeys.june]);
  });

  it('orders current-year months before previous-year groups', () => {
    const conversations = [
      { conversationId: 'previous-year', updatedAt: '2024-12-15T12:00:00.000Z' },
      { conversationId: 'june', updatedAt: '2025-06-15T12:00:00.000Z' },
    ];

    const grouped = groupConversationsByDate(conversations as TConversation[]);

    expect(grouped.map(([key]) => key)).toEqual([dateKeys.june, ' 2024']);
  });
});
