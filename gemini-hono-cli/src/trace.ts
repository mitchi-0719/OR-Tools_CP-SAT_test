import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AIChatInput, AIChatOutput } from './types.js'

export const TRACE_ROOT = fileURLToPath(new URL('../logs/llm/', import.meta.url))

export type TraceResult = {
  httpStatus: number
  outputType?: AIChatOutput['type']
  proposalId?: string
  validationError?: string
}

export interface LLMTrace {
  readonly traceId: string
  request(request: { model: string }, input: AIChatInput): Promise<void>
  response(response: unknown, text: string | undefined): Promise<void>
  finish(result: TraceResult): Promise<void>
  fail(error: unknown): Promise<void>
}

type TraceOptions = {
  root?: string
  apiKey?: string
  report?: (message: string) => void
}

export async function createFileTrace(options: TraceOptions = {}): Promise<LLMTrace> {
  const startedAt = new Date()
  const started = performance.now()
  const traceId = startedAt.toISOString().replace(/[:.]/g, '-') + '_' + randomUUID()
  const directory = join(options.root ?? TRACE_ROOT, traceId)
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY
  const report = options.report ?? console.error
  const redactText = (text: string) => apiKey ? text.replaceAll(apiKey, '[REDACTED]') : text
  const json = (value: unknown) => redactText(JSON.stringify(value, (key, field: unknown) =>
    /^(authorization|proxy-authorization|x-goog-api-key|api[-_]?key|access_token|refresh_token|cookie|set-cookie)$/i.test(key)
      ? '[REDACTED]' : typeof field === 'string' ? redactText(field) : field, 2) + '\n')
  const summary: Record<string, unknown> = { traceId, startedAt: startedAt.toISOString(), status: 'running' }
  let writeErrorReported = false
  async function save(file: string, contents: string) {
    try {
      await writeFile(join(directory, file), redactText(contents), 'utf8')
    } catch {
      if (!writeErrorReported) {
        report('[LLM ' + traceId + '] ログを保存できません: ' + directory)
        writeErrorReported = true
      }
    }
  }
  async function saveJson(file: string, value: unknown) {
    try {
      await save(file, json(value))
    } catch {
      report('[LLM ' + traceId + '] ログを JSON に変換できません: ' + file)
    }
  }
  async function complete(status: 'completed' | 'failed') {
    summary.status = status
    summary.completedAt = new Date().toISOString()
    summary.durationMs = Math.round(performance.now() - started)
    await saveJson('trace.json', summary)
    report('[LLM ' + traceId + '] ' + status + ' / ' + summary.durationMs + 'ms / ' + directory)
  }

  await mkdir(directory, { recursive: true })
  await saveJson('trace.json', summary)
  return {
    traceId,
    async request(request, input) {
      summary.model = request.model
      await saveJson('request.json', request)
      await saveJson('input.json', input)
      const config = 'config' in request ? request.config as { systemInstruction?: string } : undefined
      await save('system.md', config?.systemInstruction ?? '')
      await saveJson('trace.json', summary)
      report('[LLM ' + traceId + '] SEND / ' + request.model + ' / ' + directory)
    },
    async response(response, text) {
      await saveJson('response.json', response)
      if (text !== undefined) await save('response.txt', text)
      summary.textSource = 'response.text'
      summary.hasResponseText = text !== undefined && text.length > 0
    },
    async finish(result) {
      summary.result = result
      await complete('completed')
    },
    async fail(error) {
      const detail = error instanceof Error
        ? { name: error.name, message: error.message, status: 'status' in error ? error.status : undefined }
        : { message: String(error) }
      await saveJson('error.json', detail)
      summary.result = { httpStatus: 502, errorFile: 'error.json' }
      await complete('failed')
    },
  }
}

export async function readTrace(identifier = 'latest', root = TRACE_ROOT) {
  let traceId = identifier
  if (identifier === 'latest') {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
    traceId = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1) ?? ''
  }
  if (!/^[\w-]+$/.test(traceId)) throw new Error('ログがありません。先にメッセージを送ってください。')
  const directory = join(root, traceId)
  const files = ['trace.json', 'system.md', 'input.json', 'request.json', 'response.json', 'response.txt', 'error.json']
  const contents: Record<string, string> = {}
  for (const file of files) {
    try {
      contents[file] = await readFile(join(directory, file), 'utf8')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
  if (!contents['trace.json']) throw new Error('指定したログが見つかりません: ' + traceId)
  return { traceId, directory, contents }
}

export function renderTrace(trace: Awaited<ReturnType<typeof readTrace>>) {
  const sections = [
    ['処理結果・所要時間', 'trace.json'],
    ['送信: 固定システム指示 (config.systemInstruction)', 'system.md'],
    ['送信: 入力 JSON (contents の本文)', 'input.json'],
    ['受信: Gemini SDK のレスポンス', 'response.json'],
    ['返却: response.text の本文', 'response.txt'],
    ['エラー', 'error.json'],
  ]
  return 'ログ: ' + trace.directory + '\n\n' + sections
    .filter(([, file]) => trace.contents[file] !== undefined)
    .map(([label, file]) => '=== ' + label + ' ===\n' + trace.contents[file])
    .join('\n\n') + '\n'
}
