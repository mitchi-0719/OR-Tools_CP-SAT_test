import { Hono } from 'hono'
import { MockState, MockStateError } from './state.js'
import { validateApproval, validateInput, validateOutput, validateProposalId } from './validation.js'
import type { AIChatInput } from './types.js'
import type { LLMTrace } from './trace.js'

type Generator = (input: AIChatInput, trace?: LLMTrace) => Promise<string>

export function createApp(generate: Generator, state = new MockState(), options: {
  createTrace?: () => Promise<LLMTrace>
} = {}) {
  const app = new Hono()
  app.onError((error, c) => c.text(error.message, error instanceof MockStateError ? error.status : 400))
  app.get('/', (c) => c.text('POST /chat'))
  app.get('/context', (c) => c.json(state.snapshot()))
  app.put('/context', async (c) => {
    const { context, updatedAt } = await c.req.json()
    return c.json(state.replaceContext(context, updatedAt))
  })

  app.post('/chat', async (c) => {
    const body = await c.req.json()
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON オブジェクトを送信してください。')
    const snapshot = state.snapshot()
    const input: unknown = {
      context: snapshot.context,
      recentMessages: [],
      pendingProposal: null,
      ...body,
    }
    validateInput(input)
    state.assertCurrent(input.context)
    const previousProposalId = c.req.header('X-Pending-Proposal-Id')
    if (previousProposalId) {
      if (!input.pendingProposal) throw new Error('変更案への修正依頼には pendingProposal を指定してください。')
      state.assertPendingCurrent(previousProposalId)
    }

    let trace: LLMTrace | undefined
    try {
      trace = await options.createTrace?.()
      if (trace) c.header('X-Trace-Id', trace.traceId)
    } catch {
      console.error('LLM ログを作成できません。logs/llm の書き込み権限を確認してください。')
      c.header('X-Trace-Status', 'unavailable')
    }
    let raw: string
    try {
      raw = await generate(input, trace)
    } catch (error) {
      await trace?.fail(error)
      console.error('Gemini API request failed. API キー・モデル名・利用制限を確認してください。')
      return c.text('Gemini API request failed.', 502)
    }
    c.header('X-Event-Updated-At', snapshot.updatedAt)
    let outputType: 'approval_required' | 'clarification_required' | 'answer' | undefined
    let registeredProposalId: string | undefined
    let validationError: string | undefined
    try {
      const output: unknown = JSON.parse(raw)
      validateOutput(output)
      outputType = output.type
      const proposalId = state.register(output, input, snapshot.updatedAt, previousProposalId)
      if (proposalId) {
        c.header('X-Proposal-Id', proposalId)
        registeredProposalId = proposalId
      }
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error)
      // 不正な出力も観察できるよう本文を返すが、承認対象には登録しない。
      c.header('X-Proposal-Status', 'invalid_output')
    }
    await trace?.finish({ httpStatus: 200, outputType, proposalId: registeredProposalId, validationError })
    return c.text(raw)
  })

  app.get('/proposals/:proposalId', (c) => c.json(state.getApproval(c.req.param('proposalId'))))
  app.post('/proposals/approve', async (c) => {
    const request: unknown = await c.req.json()
    validateApproval(request)
    return c.json({ ...state.approve(request), proposalId: request.proposalId, status: 'approved' })
  })
  app.post('/proposals/reject', async (c) => {
    const request: unknown = await c.req.json()
    validateProposalId(request)
    return c.json({ ...state.reject(request.proposalId), proposalId: request.proposalId, status: 'rejected' })
  })
  return app
}
