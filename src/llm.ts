/**
 * Auxiliary LLM generation: session titles and summaries, in the same shape as
 * the official `dsh-session-title-llm` (JSON-framed messages, BlockAssembler,
 * deadline-bounded stream).
 * @module dsh-session-manager/llm
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type FinishReason, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only import: pulls this package's `declare module` Context augmentation
// (ctx.sessionPersistence) into the program.
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionTitleProviderId, normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { ResolvedConfig } from './config.js'

/** One human message picked from a session event log. */
interface PickedUserMessage {
  readonly seq: SessionSeq
  readonly text: string
}

/** One assistant reply picked from a session event log. */
interface PickedAssistantMessage {
  readonly text: string
}

/** Conversation material extracted for one auxiliary call. */
interface ConversationExtract {
  readonly user: readonly PickedUserMessage[]
  readonly assistant: readonly PickedAssistantMessage[]
}

/** A resolvable LLM route. */
interface LlmRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Resolve the provider/model route for one auxiliary call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - deployment policy (explicit provider+model wins).
 * @param id - the target session (used for the logged route fallback).
 * @returns the route, or undefined when no route can be determined.
 */
async function resolveRoute(ctx: Context, config: ResolvedConfig, id: string, signal: AbortSignal): Promise<LlmRoute | undefined> {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  signal.throwIfAborted()
  // Live sessions carry the logged main-request route.
  const live = ctx.sessions.get(SessionId(id))
  if (live !== undefined) {
    const recorded = live.requestContext()
    if (recorded !== undefined) return { provider: recorded.provider, model: recorded.model }
  }
  // Otherwise scan the persisted log for the last request/context event.
  try {
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read', { signal })
    try {
      const result = await handle.read(undefined, undefined, { signal })
      let found: LlmRoute | undefined
      for (const event of result.events) {
        if (event.type === 'request/context') {
          found = { provider: event.data.provider, model: event.data.model }
        }
      }
      return found
    } finally {
      handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Read one session's conversation material, live or persisted.
 * @param ctx - context exposing sessions and the persistence seam.
 * @param id - target session.
 * @param signal - caller cancellation.
 * @returns the picked user/assistant messages, or undefined when absent/empty.
 */
async function extractConversation(ctx: Context, id: string, signal: AbortSignal): Promise<ConversationExtract | undefined> {
  const live = ctx.sessions.get(SessionId(id))
  let events: readonly SessionEvent[]
  if (live !== undefined) {
    events = live.snapshotEvents()
  } else {
    signal.throwIfAborted()
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read', { signal })
    try {
      const result = await handle.read(undefined, undefined, { signal })
      events = result.events
    } finally {
      handle.close()
    }
  }
  const user: PickedUserMessage[] = []
  const assistant: PickedAssistantMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      const text = textOf(event.data.content)
      if (normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length > 0) {
        user.push({ seq: event.seq, text })
      }
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message.content)
      if (text.length > 0) assistant.push({ text })
    }
  }
  if (user.length === 0 && assistant.length === 0) return undefined
  return { user, assistant }
}

/** Concatenate the text blocks of one message. */
function textOf(content: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Truncate a framed payload to the byte budget by keeping whole messages. */
function fitToBudget(frames: string[], maxBytes: number): string {
  let json = JSON.stringify(frames)
  while (Buffer.byteLength(json, 'utf8') > maxBytes && frames.length > 1) {
    frames = frames.slice(0, frames.length - 1)
    json = JSON.stringify(frames)
  }
  return json
}

/** One bounded auxiliary call through ctx.llm, assembled to plain text. */
async function callModel(ctx: Context, route: LlmRoute, system: string, userText: string, maxTokens: number, id: string, purpose: 'session-title' | undefined, signal: AbortSignal): Promise<string> {
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    system,
    maxTokens,
    sessionId: SessionId(id),
    ...(purpose === undefined ? {} : { purpose }),
    signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const text = assembler
    .blocks()
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  return text.trim()
}

/** Translate terminal finish reasons into a failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('dsh-session-manager: auxiliary output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('dsh-session-manager: auxiliary model unexpectedly requested a tool')
    default:
      return new Error(`dsh-session-manager: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Generate a normalized session title.
 * @param ctx - context exposing the registered LLM service.
 * @param config - resolved deployment policy.
 * @param id - target session.
 * @param signal - caller cancellation.
 * @returns the normalized non-empty title and the exact human message seqs it
 * drew from (for recording the official `session/title` event).
 */
export interface GeneratedTitle {
  readonly title: string
  readonly messageSeqs: readonly SessionSeq[]
}

export async function generateTitle(ctx: Context, config: ResolvedConfig, id: string, signal: AbortSignal): Promise<GeneratedTitle> {
  const route = await resolveRoute(ctx, config, id, signal)
  if (route === undefined) {
    throw new Error('dsh-session-manager: no LLM route; configure provider and model together in the plugin config')
  }
  const extract = await extractConversation(ctx, id, signal)
  if (extract === undefined || extract.user.length === 0) {
    throw new Error('dsh-session-manager: session has no human messages to title')
  }
  const system = [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, or Markdown. No code is allowed.',
    'Use the language of the messages.',
    'Aim for about 5 words in non-CJK languages or 15 CJK characters.',
  ].join('\n')
  const framed = fitToBudget([JSON.stringify(extract.user.map(message => ({ seq: message.seq, text: message.text })))], config.maxInputBytes)
  const text = await callModel(ctx, route, system, `Generate the session title from this JSON array of human messages:\n${framed}`, config.titleMaxOutputTokens, id, 'session-title', signal)
  const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('dsh-session-manager: title model produced no text')
  return { title, messageSeqs: extract.user.map(message => message.seq) }
}

/**
 * Generate a session summary.
 * @param ctx - context exposing the registered LLM service.
 * @param config - resolved deployment policy.
 * @param id - target session.
 * @param focus - optional narrowing instruction, or undefined.
 * @param signal - caller cancellation.
 * @returns the summary text.
 */
export async function generateSummary(ctx: Context, config: ResolvedConfig, id: string, focus: string | undefined, signal: AbortSignal): Promise<string> {
  const route = await resolveRoute(ctx, config, id, signal)
  if (route === undefined) {
    throw new Error('dsh-session-manager: no LLM route; configure provider and model together in the plugin config')
  }
  const extract = await extractConversation(ctx, id, signal)
  if (extract === undefined || extract.user.length === 0) {
    throw new Error('dsh-session-manager: session has no messages to summarize')
  }
  const system = [
    'Write a concise working summary of an AI coding-assistant session.',
    'Cover: the goal, key decisions and their rationale, concrete outcomes (files, commands, results), and next steps if any.',
    'Plain text only, no Markdown headers, no code fences. Use the language of the session.',
    'Keep it under 300 words.',
    focus === undefined ? '' : `Additional instruction from the caller: ${focus}`,
  ].filter(line => line.length > 0).join('\n')
  const frames = [
    ...extract.user.map(message => `USER: ${message.text}`),
    ...extract.assistant.map(message => `ASSISTANT: ${message.text}`),
  ]
  const framed = fitToBudget(frames, config.maxInputBytes)
  const text = await callModel(ctx, route, system, `Summarize this session transcript:\n${framed}`, config.summaryMaxOutputTokens, id, undefined, signal)
  if (text.length === 0) throw new Error('dsh-session-manager: summary model produced no text')
  return text
}

/** Record one LLM-generated title on a LIVE session (the official vocabulary event). */
export function recordTitleOnLiveSession(session: Session, title: string, messageSeqs: readonly SessionSeq[], route: LlmRoute | undefined): void {
  session.append('session/title', {
    title,
    messageSeqs: [...messageSeqs],
    source: {
      kind: 'provider',
      provider: SessionTitleProviderId('dsh-session-manager'),
      ...(route === undefined ? {} : { model: route }),
    },
  })
}
