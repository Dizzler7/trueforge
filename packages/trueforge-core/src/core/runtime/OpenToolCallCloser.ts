/**
 * OpenToolCallCloser - Context processor that closes unresolved tool calls.
 *
 * When an assistant message contains tool_calls but corresponding tool response
 * messages are missing (e.g., due to a failed or interrupted tool execution),
 * LLMs will reject the request. This processor detects such cases in the
 * **last** assistant message and appends dummy tool responses so the
 * conversation can continue.
 *
 * Uses is_thread_creation from InternalToolCallInfo to identify sub-agent
 * tool calls. Older persisted contexts without is_thread_creation follow the
 * ordinary non-thread-creation path (no compatibility fallback).
 *
 * Resume / user-action batches close only dangling regular calls. A user
 * message also closes pending approval, client-side, and thread-creation
 * calls so the new message can sit after a complete tool-call/response pair.
 */
import type {
  AgentContextProcessorAppendContext,
  AgentThreadExecutionContext,
  PreSendContextProcessor,
} from '../capabilities/AgentContextProcessor';
import { EventType, newEventId, type ToolResponseEvent } from '../events/schema';
import type { InternalEnrichedAssistantMessage, InternalEnrichedToolCall, LLMToolMessage } from '../llm/LLMTypes';
import type { ContextMessage } from './AgentThread.types';
import { InternalEventType } from './AgentThread.types';
import { mergeCurrentContextUsage } from './contextUsage';
import { estimateTokensForContextMessages, isLLMContextMessage } from './contextUtils';

const DANGLING_TOOL_MESSAGE_CONTENT = JSON.stringify({
  error: 'Tool call was not executed. Please retry this tool call.',
});

const USER_ACTION_TOOL_MESSAGE_CONTENT = JSON.stringify({
  error:
    'Tool call was not executed: the user sent a new message before it was resolved. Do not retry unless the user asks.',
});

const THREAD_CREATION_TOOL_MESSAGE_CONTENT = 'Sub-agent was cancelled because the user sent a new message.';

export type ClosableOpenToolCallKind = 'dangling' | 'user_action' | 'thread_creation';

export interface ClosableOpenToolCall {
  tool_call_id: string;
  close_kind: ClosableOpenToolCallKind;
}

function closeKindForToolCall(toolCall: InternalEnrichedToolCall): ClosableOpenToolCallKind {
  if (toolCall.tool_info.is_thread_creation === true) {
    return 'thread_creation';
  }
  if (toolCall.tool_info.is_approval_required === true || toolCall.tool_info.is_client_side === true) {
    return 'user_action';
  }
  return 'dangling';
}

function contentForCloseKind(closeKind: ClosableOpenToolCallKind): string {
  switch (closeKind) {
    case 'dangling':
      return DANGLING_TOOL_MESSAGE_CONTENT;
    case 'user_action':
      return USER_ACTION_TOOL_MESSAGE_CONTENT;
    case 'thread_creation':
      return THREAD_CREATION_TOOL_MESSAGE_CONTENT;
  }
}

export function getClosableOpenToolCalls(input: {
  context: ContextMessage[];
  userMessageIncoming: boolean;
}): ClosableOpenToolCall[] {
  const lastIdx = input.context.findLastIndex(
    (msg): msg is InternalEnrichedAssistantMessage =>
      isLLMContextMessage(msg) && msg.role === 'assistant' && !!msg.tool_calls?.length,
  );
  if (lastIdx === -1) {
    return [];
  }

  const lastAssistant = input.context[lastIdx];
  if (lastAssistant === undefined || !isLLMContextMessage(lastAssistant) || lastAssistant.role !== 'assistant') {
    throw new Error('Unreachable');
  }
  if (!lastAssistant.tool_calls) {
    return [];
  }

  if (
    !input.userMessageIncoming &&
    lastAssistant.tool_calls.some(
      tc => tc.tool_info.is_approval_required === true || tc.tool_info.is_client_side === true,
    )
  ) {
    return [];
  }

  const resolvedIds = new Set<string>();
  for (const msg of input.context.slice(lastIdx + 1)) {
    if (isLLMContextMessage(msg) && msg.role === 'tool') {
      resolvedIds.add(msg.tool_call_id);
    }
  }

  const closable: ClosableOpenToolCall[] = [];
  for (const toolCall of lastAssistant.tool_calls) {
    if (resolvedIds.has(toolCall.id)) {
      continue;
    }
    const close_kind = closeKindForToolCall(toolCall);
    if (!input.userMessageIncoming && close_kind === 'thread_creation') {
      continue;
    }
    closable.push({ tool_call_id: toolCall.id, close_kind });
  }
  return closable;
}

export function getClosableOpenToolCallIds(input: {
  context: ContextMessage[];
  userMessageIncoming: boolean;
}): Set<string> {
  return new Set(getClosableOpenToolCalls(input).map(call => call.tool_call_id));
}

// we are closing open tool calls synthetically, the subscriber needs to understand
// the tool calls were closed.
function toToolResponseEvent(input: { threadId: string; toolCallId: string; content: string }): ToolResponseEvent {
  return {
    type: EventType.TOOL_RESPONSE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    thread_id: input.threadId,
    tool_call_id: input.toolCallId,
    content: input.content,
  };
}

export class OpenToolCallCloser implements PreSendContextProcessor {
  // eslint-disable-next-line @typescript-eslint/require-await -- async *: AsyncIterable contract; body is sync
  async *processPreSend(
    execution: Readonly<AgentThreadExecutionContext>,
    options: { userMessageIncoming: boolean },
  ): AsyncGenerator<AgentContextProcessorAppendContext, void, unknown> {
    const closable = getClosableOpenToolCalls({
      context: execution.context,
      userMessageIncoming: options.userMessageIncoming,
    });
    if (closable.length === 0) {
      return;
    }

    const dummyToolMessages: LLMToolMessage[] = closable.map(call => ({
      role: 'tool',
      tool_call_id: call.tool_call_id,
      content: contentForCloseKind(call.close_kind),
    }));

    const output: ToolResponseEvent[] = closable
      .filter(call => call.close_kind !== 'dangling')
      .map(call =>
        toToolResponseEvent({
          threadId: execution.threadId,
          toolCallId: call.tool_call_id,
          content: contentForCloseKind(call.close_kind),
        }),
      );

    const currentContextUsage = mergeCurrentContextUsage(
      execution.currentContextUsage,
      estimateTokensForContextMessages(dummyToolMessages),
    );

    yield {
      type: InternalEventType.AGENT_CONTEXT_APPEND,
      context: dummyToolMessages,
      output,
      current_context_usage: currentContextUsage,
    };
  }
}
