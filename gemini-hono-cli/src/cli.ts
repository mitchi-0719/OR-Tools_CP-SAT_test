import { createInterface } from 'node:readline'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { stdin, stderr } from 'node:process'
import { join } from 'node:path'
import { HONO_URL, RECENT_MESSAGE_LIMIT } from './config.js'
import { TRACE_ROOT, readTrace, renderTrace } from './trace.js'
import { buildInput, readJson } from './input.js'
import { buildGeminiRequest } from './gemini.js'
import { validateInput, validateResolved } from './validation.js'
import type { AIChatInput, ApprovalResponse, ApproveProposalRequest, EventState } from './types.js'

class HttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly traceId: string | null = null) { super(message) }
}

function reportTrace(headers: Headers) {
  const traceId = headers.get('X-Trace-Id')
  if (traceId) console.error('\nLLMログ: ' + join(TRACE_ROOT, traceId))
  if (headers.get('X-Trace-Status') === 'unavailable') console.error('\nLLM ログを保存できませんでした。サーバー側の表示を確認してください。')
}

async function request(path: string, body?: unknown, method = 'POST', headers: Record<string, string> = {}) {
  let response: Response
  try {
    response = await fetch(HONO_URL + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error(HONO_URL + ' に接続できません。先に npm run dev を実行してください。')
  }
  const raw = await response.text()
  if (!response.ok) {
    reportTrace(response.headers)
    throw new HttpError(raw, response.status, response.headers.get('X-Trace-Id'))
  }
  return { raw, headers: response.headers }
}

async function currentState(): Promise<EventState> {
  return JSON.parse((await request('/context', undefined, 'GET')).raw)
}

async function sendMessage(input: AIChatInput, headers: Record<string, string> = {}) {
  // SDK 呼び出しと同じ組み立て関数を使い、本文の JSON は読みやすく展開する。
  const payload = buildGeminiRequest(input)
  const display = [
    '\n---LLMに送る内容---',
    'model: ' + payload.model,
    'responseMimeType: ' + payload.config.responseMimeType,
    '',
    '[systemInstruction]',
    payload.config.systemInstruction,
    '',
    '[contents: 入力 JSON]',
    JSON.stringify(JSON.parse(payload.contents[0].parts[0].text), null, 2),
    '------\n',
  ].join('\n')
  const apiKey = process.env.GEMINI_API_KEY
  stderr.write(apiKey ? display.replaceAll(apiKey, '[REDACTED]') : display)

  const reply = await request('/chat', input, 'POST', headers)
  stderr.write('\n---LLMからのレスポンス---\n')
  process.stdout.write(reply.raw)
  stderr.write('\n------\n')
  reportTrace(reply.headers)
  return reply
}

function rememberResponse(input: AIChatInput, raw: string) {
  input.recentMessages = [
    ...input.recentMessages,
    { role: 'user', text: input.userMessage },
    { role: 'assistant', text: raw },
  ].slice(-RECENT_MESSAGE_LIMIT) as AIChatInput['recentMessages']
}

function configuredSettings(input: AIChatInput): ApproveProposalRequest['settings'] {
  return (input.pendingProposal?.actions ?? []).flatMap((action, actionIndex) => {
    if (action.type === 'delete_constraint') return []
    validateResolved(action.constraint)
    return [{
      actionIndex,
      hardness: action.constraint.hardness as 'hard' | 'soft',
      priority: action.constraint.priority,
    }]
  })
}

function withoutSettings(proposal: NonNullable<AIChatInput['pendingProposal']>) {
  return proposal.actions.map((action) => action.type === 'delete_constraint'
    ? action
    : { ...action, constraint: { ...action.constraint, hardness: null, priority: null } })
}

async function interactive(input: AIChatInput) {
  const initialContext = structuredClone(input.context)
  let proposalId: string | null = null
  let lastTraceId: string | null = null
  const rl = createInterface({ input: stdin, crlfDelay: Infinity })
  console.error('質問を入力。/trace 送受信ログ、/exit 終了、/reset 初期化、/reload 最新状態、/proposal ファイル UI設定読込、/approve [設定ファイル] 承認、/reject 却下')
  stderr.write('> ')
  try {
    for await (const line of rl) {
      const message = line.trim()
      if (message === '/exit') break
      try {
        if (message === '/trace') {
          stderr.write(renderTrace(await readTrace(lastTraceId ?? 'latest')))
        } else if (message === '/reset' || message === '/reload') {
          if (proposalId) {
            try { await request('/proposals/reject', { proposalId }) }
            catch (error) {
              if (!(error instanceof HttpError) || ![404, 409].includes(error.status)) throw error
            }
          }
          const latest = await currentState()
          const next: EventState = message === '/reset'
            ? JSON.parse((await request('/context', { context: initialContext, updatedAt: latest.updatedAt }, 'PUT')).raw)
            : latest
          input.context = next.context
          if (message === '/reset') input.recentMessages = []
          input.pendingProposal = null
          proposalId = null
          console.error(message === '/reset' ? '現在状態と会話を初期化しました。' : '最新状態を読み込みました。')
        } else if (message.startsWith('/proposal ')) {
          const pendingProposal = await readJson<AIChatInput['pendingProposal']>(message.slice('/proposal '.length).trim())
          validateInput({ ...input, pendingProposal })
          if (proposalId) {
            const original = JSON.parse((await request('/proposals/' + proposalId, undefined, 'GET')).raw) as ApprovalResponse
            if (!pendingProposal || !isDeepStrictEqual(withoutSettings(pendingProposal), withoutSettings(original))) {
              throw new Error('承認前の UI 編集は hardness / priority を変更してください。対象や条件の修正は発言として送ってください。')
            }
          }
          input.pendingProposal = pendingProposal
          console.error('変更案の UI 設定を読み込みました。')
        } else if (message === '/approve' || message.startsWith('/approve ') || message === '/reject') {
          if (!proposalId) throw new Error('BE に登録された承認待ちの変更案がありません。')
          const approve = message !== '/reject'
          const settingsPath = approve ? message.slice('/approve'.length).trim() : ''
          const settings = !approve ? undefined : settingsPath
            ? (await readJson<{ settings: ApproveProposalRequest['settings'] }>(settingsPath)).settings
            : configuredSettings(input)
          const result = JSON.parse((await request(approve ? '/proposals/approve' : '/proposals/reject',
            approve ? { proposalId, settings } : { proposalId })).raw) as EventState
          input.context = result.context
          input.pendingProposal = null
          proposalId = null
          console.error(approve ? '承認した制約を BE の現在状態に反映しました。' : '変更案を却下しました。')
        } else if (message.startsWith('/')) {
          console.error('不明なコマンドです。')
        } else if (message) {
          input.userMessage = line
          validateInput(input)
          const reply = await sendMessage(input, proposalId ? { 'X-Pending-Proposal-Id': proposalId } : {})
          lastTraceId = reply.headers.get('X-Trace-Id')
          rememberResponse(input, reply.raw)
          const nextId = reply.headers.get('X-Proposal-Id')
          if (nextId) {
            const approval = JSON.parse((await request('/proposals/' + nextId, undefined, 'GET')).raw) as ApprovalResponse
            input.pendingProposal = { actions: approval.actions }
            proposalId = nextId
            console.error('proposalId: ' + proposalId)
          } else if (reply.headers.get('X-Proposal-Status') === 'invalid_output') {
            console.error('返答はそのまま表示しました。出力定義または変更案が不正なため、BE に登録していません。')
          }
        }
      } catch (error) {
        if (error instanceof HttpError && error.traceId) lastTraceId = error.traceId
        console.error(error instanceof Error ? error.message : String(error))
      }
      stderr.write('> ')
    }
  } finally {
    rl.close()
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      interactive: { type: 'boolean', default: false },
      context: { type: 'string' },
      history: { type: 'string' },
      proposal: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.error('npm run ask -- [--context file] [--history file] [--proposal file] [--dry-run] "質問文"')
    console.error('npm run chat -- [--context file] [--history file] [--proposal file]')
    return
  }
  const message = positionals.join(' ')
  if (!values.interactive && !message.trim()) throw new Error('使い方: npm run ask -- "質問文" / npm run chat')
  const input = await buildInput(message || '会話開始', {
    contextPath: values.context,
    recentMessages: values.history ? await readJson(values.history) : undefined,
    pendingProposal: values.proposal ? await readJson(values.proposal) : undefined,
  })
  if (values['dry-run']) {
    validateInput(input)
    process.stdout.write(JSON.stringify(input, null, 2) + '\n')
    return
  }
  const latest = await currentState()
  input.context = values.context
    ? JSON.parse((await request('/context', { context: input.context, updatedAt: latest.updatedAt }, 'PUT')).raw).context
    : latest.context
  validateInput(input)
  if (values.interactive) {
    await interactive(input)
  } else {
    const reply = await sendMessage(input)
    const proposalId = reply.headers.get('X-Proposal-Id')
    if (proposalId) console.error('\nproposalId: ' + proposalId)
    if (reply.headers.get('X-Proposal-Status') === 'invalid_output') {
      console.error('\n出力定義または変更案が不正なため、BE に登録していません。')
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
