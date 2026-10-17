import { readFileSync } from 'node:fs'
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai'
import { MODEL } from './config.js'
import type { LLMTrace } from './trace.js'
import type { AIChatInput } from './types.js'

export const SYSTEM_INSTRUCTION = readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8')

// テストや入力の確認でも、実際の送信と同じ組み立て方を使う。
export function buildGeminiRequest(input: AIChatInput) {
  return {
    model: MODEL,
    contents: [{ role: 'user' as const, parts: [{ text: JSON.stringify(input) }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
    },
  }
}

type GenerateContent = (request: ReturnType<typeof buildGeminiRequest>) => Promise<GenerateContentResponse>

export function createGeminiGenerator(send?: GenerateContent) {
  if (!send) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('gemini-hono-cli/.env に GEMINI_API_KEY を設定してください。')
    const ai = new GoogleGenAI({ apiKey })
    send = (request) => ai.models.generateContent(request)
  }
  const generate = send
  return async (input: AIChatInput, trace?: LLMTrace): Promise<string> => {
    const request = buildGeminiRequest(input)
    await trace?.request(request, input)
    const response = await generate(request)
    const text = response.text
    await trace?.response(response, text)
    if (text === undefined || text.length === 0) {
      throw new Error('Gemini から返答テキストが返りませんでした。')
    }
    return text
  }
}
