import { readFile } from 'node:fs/promises'
import type { AIChatInput } from './types.js'

export const DEFAULT_CONTEXT_PATH = new URL('../data/context.json', import.meta.url)

export async function readJson<T>(path: string | URL): Promise<T> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as T
}

export async function buildInput(
  userMessage: string,
  options: {
    contextPath?: string | URL
    recentMessages?: AIChatInput['recentMessages']
    pendingProposal?: AIChatInput['pendingProposal']
  } = {},
): Promise<AIChatInput> {
  return {
    context: await readJson<AIChatInput['context']>(options.contextPath ?? DEFAULT_CONTEXT_PATH),
    recentMessages: options.recentMessages ?? [],
    userMessage,
    pendingProposal: options.pendingProposal ?? null,
  }
}
