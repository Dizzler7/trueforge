import type {
  InsertSessionInboundEventsInput,
  ListUnconsumedSessionInboundEventsInput,
  MarkSessionInboundEventsConsumedInput,
  SessionInboundEventRecord,
} from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  SessionInboundEventAlreadyExistsError,
  SessionNotFoundError,
  TurnNotFoundError,
} from '@truefoundry/trueforge-core/agent-session/store/SessionStoreErrors';
import type { JsonValue } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { isUniqueViolation } from '../../client';
import { jsonbBind, jsonText } from '../../sqlExpressions';
import type { Database } from '../../types';

async function requireSession(db: Kysely<Database>, sessionId: string): Promise<void> {
  const row = await db
    .selectFrom('session')
    .select('session_id')
    .where('session_id', '=', sessionId)
    .executeTakeFirst();
  if (!row) {
    throw new SessionNotFoundError(sessionId);
  }
}

async function requireTurn(db: Kysely<Database>, sessionId: string, turnId: string): Promise<void> {
  const row = await db
    .selectFrom('turn')
    .select('turn_id')
    .where('session_id', '=', sessionId)
    .where('turn_id', '=', turnId)
    .executeTakeFirst();
  if (!row) {
    throw new TurnNotFoundError(turnId);
  }
}

export async function insertSessionInboundEvents(
  db: Kysely<Database>,
  input: InsertSessionInboundEventsInput,
): Promise<void> {
  if (input.events.length === 0) {
    return;
  }
  await requireSession(db, input.session_id);
  for (const event of input.events) {
    await requireTurn(db, input.session_id, event.turn_id);
  }

  try {
    await db
      .insertInto('session_inbound_events')
      .values(
        input.events.map(event => ({
          session_id: input.session_id,
          event_id: event.event_id,
          turn_id: event.turn_id,
          payload: jsonbBind(event.payload),
          consumed: 0,
          created_at: event.created_at,
        })),
      )
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) {
      const first = input.events[0];
      throw new SessionInboundEventAlreadyExistsError(input.session_id, first?.event_id ?? '', {
        cause: error,
      });
    }
    throw error;
  }
}

export async function listUnconsumedSessionInboundEvents(
  db: Kysely<Database>,
  input: ListUnconsumedSessionInboundEventsInput,
): Promise<SessionInboundEventRecord[]> {
  await requireSession(db, input.session_id);

  let query = db
    .selectFrom('session_inbound_events')
    .select(['event_id', 'turn_id', 'created_at', jsonText<JsonValue>(sql.ref('payload')).as('payload')])
    .where('session_id', '=', input.session_id)
    .where('consumed', '=', 0);

  if (input.turn_id === null) {
    query = query.where('turn_id', 'is', null);
  } else if (input.turn_id !== undefined) {
    query = query.where('turn_id', '=', input.turn_id);
  }

  const rows = await query.orderBy('event_id', 'asc').execute();

  return rows.map(row => ({
    event_id: row.event_id,
    turn_id: row.turn_id,
    payload: row.payload as SessionInboundEventRecord['payload'],
    created_at: row.created_at,
  }));
}

export async function markSessionInboundEventsConsumed(
  db: Kysely<Database>,
  input: MarkSessionInboundEventsConsumedInput,
): Promise<void> {
  if (input.event_ids.length === 0) {
    return;
  }
  await requireSession(db, input.session_id);

  await db
    .updateTable('session_inbound_events')
    .set({ consumed: 1 })
    .where('session_id', '=', input.session_id)
    .where('event_id', 'in', input.event_ids)
    .execute();
}
