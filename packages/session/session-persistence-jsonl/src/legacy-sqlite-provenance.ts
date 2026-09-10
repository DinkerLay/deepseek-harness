/** Strict provenance reconstruction for the recorded rc2 SQLite export boundary. */

import { isDeepStrictEqual } from 'node:util'
import { AssistantStreamAccumulator, BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

type JsonRecord = Record<string, unknown>

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Legacy SQLite export cannot reconstruct ${label}: expected an object.`)
  }
  return value as JsonRecord
}

function coordinate(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Legacy SQLite export cannot reconstruct ${label}: expected a non-negative safe integer.`)
  }
  return value as number
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Legacy SQLite export cannot reconstruct ${label}: expected a non-empty string.`)
  }
  return value
}

function eventType(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)['type']
    : undefined
}

/**
 * Add chunk provenance only when one rc2 final message immediately follows its exact chunk run.
 * General JSONL migration remains strict; this function is used only after the recorded rc2
 * runtime has read a SQLite database through its public persistence API.
 * @param events - contiguous events returned by the recorded rc2 SQLite provider.
 * @returns events with provable missing `sourceEventSeqs` reconstructed on final messages.
 */
export function reconstructRc2ChunkProvenance(events: readonly unknown[]): readonly unknown[] {
  const output = [...events]
  for (let messageIndex = 0; messageIndex < events.length; messageIndex += 1) {
    if (eventType(events[messageIndex]) !== 'assistant/message') continue
    let chunkStart = messageIndex
    while (chunkStart > 0 && eventType(events[chunkStart - 1]) === 'assistant/chunk') chunkStart -= 1
    if (chunkStart === messageIndex) continue

    const message = record(events[messageIndex], `assistant/message at index ${String(messageIndex)}`)
    const messageData = record(message['data'], `assistant/message ${String(message['seq'])} data`)
    const messageTurn = coordinate(messageData['turn'], `assistant/message ${String(message['seq'])} turn`)
    const messageStep = coordinate(messageData['step'], `assistant/message ${String(message['seq'])} step`)
    const value = record(messageData['message'], `assistant/message ${String(message['seq'])} message`)
    if (value['role'] !== 'assistant') {
      throw new Error(`Legacy SQLite export cannot reconstruct assistant/message ${String(message['seq'])}: role is not assistant.`)
    }
    const source = record(value['source'], `assistant/message ${String(message['seq'])} source`)
    if (source['kind'] !== 'model') {
      throw new Error(`Legacy SQLite export cannot reconstruct assistant/message ${String(message['seq'])}: source is not a model.`)
    }
    nonEmptyString(source['provider'], `assistant/message ${String(message['seq'])} provider`)
    nonEmptyString(source['model'], `assistant/message ${String(message['seq'])} model`)

    const messageSeq = coordinate(message['seq'], `assistant/message at index ${String(messageIndex)} seq`)
    const sourceEventSeqs: number[] = []
    const accumulator = new AssistantStreamAccumulator()
    for (let chunkIndex = chunkStart; chunkIndex < messageIndex; chunkIndex += 1) {
      const chunk = record(events[chunkIndex], `assistant/chunk at index ${String(chunkIndex)}`)
      const chunkSeq = coordinate(chunk['seq'], `assistant/chunk at index ${String(chunkIndex)} seq`)
      const expectedSeq = messageSeq - (messageIndex - chunkIndex)
      if (chunkSeq !== expectedSeq) {
        throw new Error(`Legacy SQLite export cannot reconstruct assistant/message ${String(messageSeq)}: chunk sequence has a gap.`)
      }
      const chunkData = record(chunk['data'], `assistant/chunk ${String(chunkSeq)} data`)
      if (coordinate(chunkData['turn'], `assistant/chunk ${String(chunkSeq)} turn`) !== messageTurn
        || coordinate(chunkData['step'], `assistant/chunk ${String(chunkSeq)} step`) !== messageStep) {
        throw new Error(
          `Legacy SQLite export cannot reconstruct assistant/message ${String(messageSeq)}: chunk belongs to another turn or step.`,
        )
      }
      accumulator.push({
        time: coordinate(chunk['time'], `assistant/chunk ${String(chunkSeq)} time`),
        chunk: chunkData['chunk'] as StreamChunk,
      })
      sourceEventSeqs.push(chunkSeq)
    }

    const assembler = new BlockAssembler()
    for (const member of expandAssistantStream(accumulator.snapshot())) assembler.push(member.chunk)
    const expectedContent = messageData['interrupted'] === true
      ? assembler.interruptedBlocks()
      : assembler.blocks()
    if (!isDeepStrictEqual(value['content'], expectedContent)
      || !isDeepStrictEqual(messageData['usage'], assembler.usage)
      || !isDeepStrictEqual(source['replayState'], assembler.replayState)) {
      throw new Error(
        `Legacy SQLite export cannot reconstruct assistant/message ${String(messageSeq)}: final message disagrees with its chunks.`,
      )
    }

    if (Object.hasOwn(message, 'sourceEventSeqs')) {
      if (!isDeepStrictEqual(message['sourceEventSeqs'], sourceEventSeqs)) {
        throw new Error(
          `Legacy SQLite export cannot reconstruct assistant/message ${String(messageSeq)}: existing chunk provenance conflicts.`,
        )
      }
      continue
    }
    output[messageIndex] = { ...message, sourceEventSeqs }
  }
  return output
}
