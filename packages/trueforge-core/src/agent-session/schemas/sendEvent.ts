/**
 * Inbound send-event payloads for tip HITL (client → harness), distinct from the
 * stream log ({@link PersistedTurnEvent} / session_event).
 *
 * Public send is session-scoped (`POST …/sessions/{id}/events`); `turn_id` is a
 * required body field (not path) and is stored on `session_inbound_events`.
 * v1 union is tip-only; approval policies may relax `turn_id` to optional/null later.
 * `user.message` stays on createTurn / steer.
 */
import { z } from '@hono/zod-openapi';
import { UserToolApprovalMessageSchema, UserToolResponseMessageSchema } from '../../core/events/schema';

export const SendTurnEventItemSchema = z
  .discriminatedUnion('type', [UserToolApprovalMessageSchema, UserToolResponseMessageSchema])
  .openapi('SendTurnEventItem');

export type SendTurnEventItem = z.infer<typeof SendTurnEventItemSchema>;
