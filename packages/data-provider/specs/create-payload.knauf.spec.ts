// [knauf] Preserve the explicit edit signal across the agent-chat transport boundary.
import { Constants } from '../src/config';
import createPayload from '../src/createPayload';
import { EModelEndpoint } from '../src/schemas';
import type { TSubmission } from '../src/types';

describe('createPayload — Knauf linear chat recovery', () => {
  it('forwards an explicit user-message edit to the agent controller', () => {
    const submission = {
      userMessage: {
        text: 'Edited root message',
        messageId: 'edited-root',
        parentMessageId: Constants.NO_PARENT,
        conversationId: 'conversation-1',
        isCreatedByUser: true,
      },
      isEdited: true,
      isContinued: false,
      isTemporary: false,
      messages: [],
      conversation: { conversationId: 'conversation-1', endpoint: EModelEndpoint.agents },
      endpointOption: { endpoint: EModelEndpoint.agents },
    } as TSubmission;

    expect(createPayload(submission).payload).toEqual(expect.objectContaining({ isEdited: true }));
  });
});
// End [knauf]
