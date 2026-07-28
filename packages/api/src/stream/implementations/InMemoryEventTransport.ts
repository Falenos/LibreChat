import { EventEmitter } from 'events';
import { logger } from '@librechat/data-schemas';
import type { GenerationRef, IEventTransport } from '../interfaces/IJobStore';

interface StreamState {
  // [knauf] One in-memory event state belongs to one immutable generation.
  streamId: string;
  generationId?: string;
  // End [knauf]
  emitter: EventEmitter;
  allSubscribersLeftCallbacks: Array<() => void>;
  abortCallbacks: Array<() => void>;
}

/**
 * In-memory event transport using Node.js EventEmitter.
 * For horizontal scaling, replace with RedisEventTransport.
 */
export class InMemoryEventTransport implements IEventTransport {
  // [knauf] Mirror Redis generation fencing in single-process deployments and tests.
  private generations = new Map<string, StreamState>();
  private streamGenerations = new Map<string, Set<string>>();

  private generationKey(streamId: string, generationId?: string): string {
    return JSON.stringify([streamId, generationId ?? null]);
  }

  private getGeneration(streamId: string, generationId?: string): StreamState | undefined {
    return this.generations.get(this.generationKey(streamId, generationId));
  }

  private getOrCreateStream(streamId: string, generationId?: string): StreamState {
    const key = this.generationKey(streamId, generationId);
    let state = this.generations.get(key);
    if (!state) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(100);
      state = {
        streamId,
        generationId,
        emitter,
        allSubscribersLeftCallbacks: [],
        abortCallbacks: [],
      };
      this.generations.set(key, state);
      let keys = this.streamGenerations.get(streamId);
      if (!keys) {
        keys = new Set();
        this.streamGenerations.set(streamId, keys);
      }
      keys.add(key);
    }
    return state;
  }

  private deleteGeneration(streamId: string, generationId?: string): void {
    const key = this.generationKey(streamId, generationId);
    this.generations.delete(key);
    const keys = this.streamGenerations.get(streamId);
    keys?.delete(key);
    if (keys?.size === 0) {
      this.streamGenerations.delete(streamId);
    }
  }
  // End [knauf]

  subscribe(
    streamId: string,
    handlers: {
      onChunk: (event: unknown) => void;
      onDone?: (event: unknown) => void;
      onError?: (error: string) => void;
    },
    generationId?: string,
  ): { unsubscribe: () => void; ready?: Promise<void> } {
    // [knauf] Subscribe and unsubscribe against the exact generation owner.
    const state = this.getOrCreateStream(streamId, generationId);

    const chunkHandler = (event: unknown) => handlers.onChunk(event);
    const doneHandler = (event: unknown) => handlers.onDone?.(event);
    const errorHandler = (error: string) => handlers.onError?.(error);

    state.emitter.on('chunk', chunkHandler);
    state.emitter.on('done', doneHandler);
    state.emitter.on('error', errorHandler);

    logger.debug(
      `[InMemoryEventTransport] subscribe ${streamId}: listeners=${state.emitter.listenerCount('chunk')}`,
    );

    return {
      unsubscribe: () => {
        const currentState = this.getGeneration(streamId, generationId);
        if (currentState) {
          currentState.emitter.off('chunk', chunkHandler);
          currentState.emitter.off('done', doneHandler);
          currentState.emitter.off('error', errorHandler);

          // Check if all subscribers left - cleanup and notify
          if (currentState.emitter.listenerCount('chunk') === 0) {
            for (const callback of currentState.allSubscribersLeftCallbacks) {
              callback();
            }
            /* Remove all EventEmitter listeners but preserve stream state
             * (including allSubscribersLeftCallbacks) for reconnection.
             * State is fully cleaned up by cleanup() when the job completes.
             */
            currentState.emitter.removeAllListeners();
          }
        }
      },
    };
  }
  // End [knauf]

  // [knauf] Emit only to handlers registered for the same generation.
  emitChunk(streamId: string, event: unknown, generationId?: string): void {
    const state = this.getGeneration(streamId, generationId);
    state?.emitter.emit('chunk', event);
  }

  emitDone(streamId: string, event: unknown, generationId?: string): void {
    const state = this.getGeneration(streamId, generationId);
    state?.emitter.emit('done', event);
  }

  emitError(streamId: string, error: string, generationId?: string): void {
    const state = this.getGeneration(streamId, generationId);
    // Only emit if there are listeners - Node.js throws on unhandled 'error' events
    // This is intentional for the race condition where error occurs before client connects
    if (state?.emitter.listenerCount('error') ?? 0 > 0) {
      state?.emitter.emit('error', error);
    }
  }
  // End [knauf]

  getSubscriberCount(streamId: string, generationId?: string): number {
    const state = this.getGeneration(streamId, generationId);
    return state?.emitter.listenerCount('chunk') ?? 0;
  }

  onAllSubscribersLeft(streamId: string, callback: () => void, generationId?: string): void {
    this.getOrCreateStream(streamId, generationId).allSubscribersLeftCallbacks.push(callback);
  }

  /**
   * Check if this is the first subscriber (for ready signaling)
   */
  isFirstSubscriber(streamId: string, generationId?: string): boolean {
    const state = this.getGeneration(streamId, generationId);
    const count = state?.emitter.listenerCount('chunk') ?? 0;
    logger.debug(`[InMemoryEventTransport] isFirstSubscriber ${streamId}: count=${count}`);
    return count === 1;
  }

  // [knauf] In-memory abort callbacks use the same generation fence as Redis.
  emitAbort(streamId: string, generationId?: string): void {
    const state = this.getGeneration(streamId, generationId);
    for (const callback of state?.abortCallbacks ?? []) {
      callback();
    }
  }

  onAbort(streamId: string, callback: () => void, generationId?: string): void {
    this.getOrCreateStream(streamId, generationId).abortCallbacks.push(callback);
  }
  // End [knauf]

  /**
   * Cleanup a stream's event emitter
   */
  // [knauf] Cleanup cannot remove listeners belonging to another generation.
  cleanup(streamId: string, generationId?: string): void {
    const state = this.getGeneration(streamId, generationId);
    if (state) {
      state.emitter.removeAllListeners();
      state.allSubscribersLeftCallbacks = [];
      state.abortCallbacks = [];
      this.deleteGeneration(streamId, generationId);
    }
  }
  // End [knauf]

  /**
   * Get count of tracked streams (for monitoring)
   */
  getStreamCount(): number {
    return this.generations.size;
  }

  /**
   * Get all tracked stream IDs (for orphan cleanup)
   */
  getTrackedStreamIds(): string[] {
    return Array.from(this.streamGenerations.keys());
  }

  // [knauf] Expose exact owners for generation-safe manager cleanup.
  getTrackedGenerations(): GenerationRef[] {
    return Array.from(this.generations.values(), ({ streamId, generationId }) => ({
      streamId,
      generationId,
    }));
  }
  // End [knauf]

  destroy(): void {
    for (const state of this.generations.values()) {
      state.emitter.removeAllListeners();
    }
    this.generations.clear();
    this.streamGenerations.clear();
    logger.debug('[InMemoryEventTransport] Destroyed');
  }
}
