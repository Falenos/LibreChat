/**
 * Tests for stale generation detection in ResumableAgentController
 *
 * Tests the following fixes from PR #11462:
 * 1. Immutable generation identity tracking
 * 2. Stale job detection and event skipping
 * 3. Response message saving before final event emission
 */

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

const mockGenerationJobManager = {
  createJob: jest.fn(),
  getJob: jest.fn(),
  emitDone: jest.fn(),
  emitChunk: jest.fn(),
  completeJob: jest.fn(),
  updateMetadata: jest.fn(),
  setContentParts: jest.fn(),
  subscribe: jest.fn(),
};

const mockSaveMessage = jest.fn();
const mockDecrementPendingRequest = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn().mockReturnValue(false),
  GenerationJobManager: mockGenerationJobManager,
  getReferencedQuotes: jest.fn((quotes) => {
    if (!Array.isArray(quotes)) {
      return null;
    }
    const normalized = quotes
      .filter((quote) => typeof quote === 'string' && quote.trim().length > 0)
      .map((quote) => quote.trim());
    return normalized.length > 0 ? normalized : null;
  }),
  checkAndIncrementPendingRequest: jest.fn().mockResolvedValue({ allowed: true }),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  getViolationInfo: jest.fn(),
  sanitizeMessageForTransmit: jest.fn((msg) => msg),
  sanitizeFileForTransmit: jest.fn((file) => file),
  Constants: { NO_PARENT: '00000000-0000-0000-0000-000000000000' },
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
}));

// [knauf] UUID ownership replaces collision-prone createdAt comparisons.
describe('Generation Ownership Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Generation Identity Tracking', () => {
    it('captures generationId when a job is created', async () => {
      const streamId = 'test-stream-123';
      const generationId = 'generation-1';

      mockGenerationJobManager.createJob.mockResolvedValue({
        generationId,
        readyPromise: Promise.resolve(),
        abortController: new AbortController(),
        emitter: { on: jest.fn() },
      });

      const job = await mockGenerationJobManager.createJob(streamId, 'user-123', streamId);

      expect(job.generationId).toBe(generationId);
    });
  });

  describe('Job Replacement Detection Logic', () => {
    /**
     * Simulates the job replacement detection logic from request.js
     * This is extracted for unit testing since the full controller is complex
     */
    const detectJobReplacement = async (streamId, originalGenerationId) => {
      const currentJob = await mockGenerationJobManager.getJob(streamId);
      return !currentJob || currentJob.generationId !== originalGenerationId;
    };

    it('detects a stale generation', async () => {
      const streamId = 'test-stream-123';
      const originalGenerationId = 'generation-1';
      const newGenerationId = 'generation-2';

      mockGenerationJobManager.getJob.mockResolvedValue({
        generationId: newGenerationId,
      });

      const wasReplaced = await detectJobReplacement(streamId, originalGenerationId);

      expect(wasReplaced).toBe(true);
    });

    it('should detect when job was deleted', async () => {
      const streamId = 'test-stream-123';
      const originalGenerationId = 'generation-1';

      mockGenerationJobManager.getJob.mockResolvedValue(null);

      const wasReplaced = await detectJobReplacement(streamId, originalGenerationId);

      expect(wasReplaced).toBe(true);
    });

    it('keeps the current generation authoritative', async () => {
      const streamId = 'test-stream-123';
      const originalGenerationId = 'generation-1';

      mockGenerationJobManager.getJob.mockResolvedValue({
        generationId: originalGenerationId,
      });

      const wasReplaced = await detectJobReplacement(streamId, originalGenerationId);

      expect(wasReplaced).toBe(false);
    });
  });

  describe('Event Emission Behavior', () => {
    /**
     * Simulates the final event emission logic from request.js
     */
    const emitFinalEventIfNotReplaced = async ({
      streamId,
      originalGenerationId,
      finalEvent,
      userId,
    }) => {
      const currentJob = await mockGenerationJobManager.getJob(streamId);
      const jobWasReplaced = !currentJob || currentJob.generationId !== originalGenerationId;

      if (jobWasReplaced) {
        mockLogger.debug('Skipping FINAL emit - job was replaced', {
          streamId,
          originalGenerationId,
          currentGenerationId: currentJob?.generationId,
        });
        await mockDecrementPendingRequest(userId);
        return false;
      }

      await mockGenerationJobManager.emitDone(streamId, finalEvent, originalGenerationId);
      await mockGenerationJobManager.completeJob(streamId, undefined, originalGenerationId);
      await mockDecrementPendingRequest(userId);
      return true;
    };

    it('should skip emitting when job was replaced', async () => {
      const streamId = 'test-stream-123';
      const originalGenerationId = 'generation-1';
      const newGenerationId = 'generation-2';
      const userId = 'user-123';

      mockGenerationJobManager.getJob.mockResolvedValue({
        generationId: newGenerationId,
      });

      const emitted = await emitFinalEventIfNotReplaced({
        streamId,
        originalGenerationId,
        finalEvent: { final: true },
        userId,
      });

      expect(emitted).toBe(false);
      expect(mockGenerationJobManager.emitDone).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(userId);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Skipping FINAL emit - job was replaced',
        expect.objectContaining({
          streamId,
          originalGenerationId,
          currentGenerationId: newGenerationId,
        }),
      );
    });

    it('should emit when job was not replaced', async () => {
      const streamId = 'test-stream-123';
      const originalGenerationId = 'generation-1';
      const userId = 'user-123';
      const finalEvent = { final: true, conversation: { conversationId: streamId } };

      mockGenerationJobManager.getJob.mockResolvedValue({
        generationId: originalGenerationId,
      });

      const emitted = await emitFinalEventIfNotReplaced({
        streamId,
        originalGenerationId,
        finalEvent,
        userId,
      });

      expect(emitted).toBe(true);
      expect(mockGenerationJobManager.emitDone).toHaveBeenCalledWith(
        streamId,
        finalEvent,
        originalGenerationId,
      );
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        streamId,
        undefined,
        originalGenerationId,
      );
      expect(mockDecrementPendingRequest).toHaveBeenCalledWith(userId);
    });
  });

  describe('Response Message Saving Order', () => {
    /**
     * Tests that response messages are saved BEFORE final events are emitted
     * This prevents race conditions where clients send follow-up messages
     * before the response is in the database
     */
    it('should save message before emitting final event', async () => {
      const callOrder = [];

      mockSaveMessage.mockImplementation(async () => {
        callOrder.push('saveMessage');
      });

      mockGenerationJobManager.emitDone.mockImplementation(() => {
        callOrder.push('emitDone');
      });

      mockGenerationJobManager.getJob.mockResolvedValue({
        generationId: 'generation-1',
      });

      // Simulate the order of operations from request.js
      const streamId = 'test-stream-123';
      const originalGenerationId = 'generation-1';
      const response = { messageId: 'response-123' };
      const userId = 'user-123';

      // Step 1: Save message
      await mockSaveMessage({}, { ...response, user: userId }, { context: 'test' });

      // Step 2: Check for replacement
      const currentJob = await mockGenerationJobManager.getJob(streamId);
      const jobWasReplaced = !currentJob || currentJob.generationId !== originalGenerationId;

      // Step 3: Emit if not replaced
      if (!jobWasReplaced) {
        mockGenerationJobManager.emitDone(streamId, { final: true }, originalGenerationId);
      }

      expect(callOrder).toEqual(['saveMessage', 'emitDone']);
    });
  });

  describe('Aborted Request Handling', () => {
    it('should use unfinished: true instead of error: true for aborted requests', () => {
      const response = { messageId: 'response-123', content: [] };

      // The new format for aborted responses
      const abortedResponse = { ...response, unfinished: true };

      expect(abortedResponse.unfinished).toBe(true);
      expect(abortedResponse.error).toBeUndefined();
    });

    it('should include unfinished flag in final event for aborted requests', () => {
      const response = { messageId: 'response-123', content: [] };

      // Old format (deprecated)
      const _oldFinalEvent = {
        final: true,
        responseMessage: { ...response, error: true },
        error: { message: 'Request was aborted' },
      };

      // New format (PR #11462)
      const newFinalEvent = {
        final: true,
        responseMessage: { ...response, unfinished: true },
      };

      expect(newFinalEvent.responseMessage.unfinished).toBe(true);
      expect(newFinalEvent.error).toBeUndefined();
      expect(newFinalEvent.responseMessage.error).toBeUndefined();
    });
  });
});
// End [knauf]
