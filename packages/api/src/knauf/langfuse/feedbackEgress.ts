// [knauf] KK20-327 — Langfuse feedback egress adapter: the ONLY path by which message
// feedback may leave the application for Langfuse.
//
// Why an adapter and not a call-site transformation: upstream's `sendFeedbackScore`
// transport accepts `{ rating, tag, text }` and joins `[tag, text]` into the score
// comment. Gating that at one route is a narrow fix another caller or an upstream merge
// can silently undo. This module owns the outbound contract as a type that CANNOT carry
// prose — `rating` is an enum, `tag` is an enum, there is no third field — and it
// rebuilds the object from scratch, so unknown properties on a stored record cannot
// survive. It re-validates at egress even though the route validates at ingress, because
// legacy rows written before the boundary parse existed are still in Mongo.
//
// Fail-closed semantics: a stored `rating` that is not a known enum value yields `null`,
// which upstream treats as the score-DELETE path. A malformed rating must never become
// a "negative score" carrying whatever string it was.
import { z } from 'zod';
import { feedbackRatingSchema, feedbackTagKeySchema } from 'librechat-data-provider';
import type { TFeedbackRating, TFeedbackTagKey } from 'librechat-data-provider';
import type { LangfuseFeedbackMetadata, SendFeedbackScoreParams } from '../../langfuse/feedback';
import { sendFeedbackScore } from '../../langfuse/feedback';

/** The complete outbound contract. Nothing else may be sent. */
export type KnaufLangfuseFeedback = {
  rating: TFeedbackRating;
  tag?: TFeedbackTagKey;
};

/** Metadata keys the score may carry — pseudonymous ids and server-set message facts only. */
export const LANGFUSE_FEEDBACK_METADATA_KEYS: readonly string[] = [
  'messageId',
  'parentMessageId',
  'conversationId',
  'sessionId',
  'userId',
  'endpoint',
  'sender',
  'isCreatedByUser',
  'tokenCount',
];

const MAX_METADATA_STRING = 128;

/** Accepts the key string the client sends and the legacy `{ key }` object form. */
const storedTagSchema = z.union([
  feedbackTagKeySchema,
  z
    .object({ key: feedbackTagKeySchema })
    .passthrough()
    .transform((t) => t.key),
]);

function isFalseEnv(value?: string): boolean {
  return value != null && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Honour every disable switch in use: `LANGFUSE_ENABLED=false` (the Knauf translation
 * sidecar's switch), `LANGFUSE_TRACING_ENABLED=false` (upstream's), and absent keys.
 * Evaluated per call, not at module load, so an operator flip is testable and immediate.
 */
export function isKnaufLangfuseFeedbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isFalseEnv(env.LANGFUSE_ENABLED) || isFalseEnv(env.LANGFUSE_TRACING_ENABLED)) {
    return false;
  }
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

/**
 * Rebuild the outbound feedback from a stored record. Returns `null` (⇒ score DELETE)
 * for nullish input, non-objects, or any rating outside the enum.
 */
export function toLangfuseFeedback(stored: unknown): KnaufLangfuseFeedback | null {
  if (stored == null || typeof stored !== 'object' || Array.isArray(stored)) {
    return null;
  }
  const record = stored as Record<string, unknown>;
  const rating = feedbackRatingSchema.safeParse(record.rating);
  if (!rating.success) {
    return null;
  }
  const tag = storedTagSchema.safeParse(record.tag);
  const out: KnaufLangfuseFeedback = { rating: rating.data };
  if (tag.success) {
    out.tag = tag.data;
  }
  return out;
}

/** Keep allow-listed keys with primitive values only; drop everything else. */
export function toLangfuseFeedbackMetadata(
  input: Record<string, unknown> | undefined,
): LangfuseFeedbackMetadata {
  const out: LangfuseFeedbackMetadata = {};
  if (input == null) {
    return out;
  }
  for (const key of LANGFUSE_FEEDBACK_METADATA_KEYS) {
    const value = input[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value;
    } else if (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_METADATA_STRING
    ) {
      out[key] = value;
    }
  }
  return out;
}

export type SendKnaufFeedbackScoreParams = {
  traceId: string;
  /** The feedback as stored on the message — validated again here, never trusted. */
  storedFeedback: unknown;
  metadata?: Record<string, unknown>;
  observationId?: string;
};

export type SendKnaufFeedbackScoreDeps = {
  send: (params: SendFeedbackScoreParams) => Promise<void>;
  env: NodeJS.ProcessEnv;
};

export type SendKnaufFeedbackScoreResult =
  | { sent: false; reason: 'disabled' }
  | { sent: true; feedback: KnaufLangfuseFeedback | null };

export async function sendKnaufFeedbackScore(
  params: SendKnaufFeedbackScoreParams,
  deps: SendKnaufFeedbackScoreDeps = { send: sendFeedbackScore, env: process.env },
): Promise<SendKnaufFeedbackScoreResult> {
  if (!isKnaufLangfuseFeedbackEnabled(deps.env)) {
    return { sent: false, reason: 'disabled' };
  }
  const feedback = toLangfuseFeedback(params.storedFeedback);
  await deps.send({
    traceId: params.traceId,
    feedback,
    metadata: toLangfuseFeedbackMetadata(params.metadata),
    ...(params.observationId ? { observationId: params.observationId } : {}),
  });
  return { sent: true, feedback };
}
// End [knauf]
