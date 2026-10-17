import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { DEFAULT_CONTEXT_PATH } from './input.js'
import { applyProposal } from './proposal.js'
import { validateApproval, validateInput } from './validation.js'
import type { AIChatInput, AIChatOutput, ApprovalResponse, ApproveProposalRequest, EventState } from './types.js'

type StoredProposal = {
  response: ApprovalResponse
  eventUpdatedAt: string
  sourceText: string
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
}

export class MockStateError extends Error {
  constructor(message: string, public readonly status: 404 | 409) {
    super(message)
  }
}

// 単一イベントをメモリに保持するモック。再起動すると fixture に戻る。
export class MockState {
  private state: EventState
  private readonly proposals = new Map<string, StoredProposal>()

  constructor(context: AIChatInput['context'] = JSON.parse(readFileSync(DEFAULT_CONTEXT_PATH, 'utf8'))) {
    validateInput({ context, userMessage: '初期状態', recentMessages: [], pendingProposal: null })
    this.state = { context: structuredClone(context), updatedAt: new Date().toISOString() }
  }

  snapshot(): EventState {
    return structuredClone(this.state)
  }

  assertCurrent(context: AIChatInput['context']) {
    if (!isDeepStrictEqual(context, this.state.context)) {
      throw new MockStateError('現在状態が更新されています。GET /context で最新状態を読み込んでください。', 409)
    }
  }

  private nextTimestamp() {
    return new Date(Math.max(Date.now(), Date.parse(this.state.updatedAt) + 1)).toISOString()
  }

  replaceContext(context: unknown, updatedAt: unknown): EventState {
    if (updatedAt !== this.state.updatedAt) throw new MockStateError('現在状態の updatedAt が一致しません。', 409)
    const input = { context, userMessage: '現在状態の変更', recentMessages: [], pendingProposal: null }
    validateInput(input)
    if (!isDeepStrictEqual(input.context, this.state.context)) {
      this.state = { context: structuredClone(input.context), updatedAt: this.nextTimestamp() }
    }
    return this.snapshot()
  }

  private pending(proposalId: string) {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) throw new MockStateError('proposalId が存在しません。', 404)
    if (proposal.status !== 'pending') throw new MockStateError('この変更案は処理済み、または新しい案に置き換えられています。', 409)
    return proposal
  }

  getApproval(proposalId: string): ApprovalResponse {
    return structuredClone(this.pending(proposalId).response)
  }

  assertPendingCurrent(proposalId: string) {
    const proposal = this.pending(proposalId)
    if (proposal.eventUpdatedAt !== this.state.updatedAt) {
      throw new MockStateError('変更案の生成後に現在状態が更新されています。最新状態で再提案してください。', 409)
    }
  }

  register(output: AIChatOutput, input: AIChatInput, updatedAt: string, previousProposalId?: string): string | null {
    if (output.type !== 'approval_required') return null
    const pendingProposal = { actions: output.actions }
    validateInput({ ...input, pendingProposal })
    const proposalId = randomUUID()
    this.proposals.set(proposalId, {
      response: { ...structuredClone(output), proposalId },
      eventUpdatedAt: updatedAt,
      sourceText: input.userMessage,
      status: 'pending',
    })
    if (previousProposalId) {
      const previous = this.proposals.get(previousProposalId)
      if (previous?.status === 'pending') previous.status = 'superseded'
    }
    return proposalId
  }

  approve(request: ApproveProposalRequest): EventState {
    validateApproval(request)
    this.assertPendingCurrent(request.proposalId)
    const proposal = this.pending(request.proposalId)
    const actions = structuredClone(proposal.response.actions)
    const configured = new Set<number>()
    for (const setting of request.settings) {
      const action = actions[setting.actionIndex]
      if (!action || action.type === 'delete_constraint') throw new Error('settings は追加・更新アクションの actionIndex を指定してください。')
      if (configured.has(setting.actionIndex)) throw new Error('settings の actionIndex が重複しています。')
      configured.add(setting.actionIndex)
      action.constraint.hardness = setting.hardness
      action.constraint.priority = setting.priority
    }
    if (actions.some((action, index) => action.type !== 'delete_constraint' && !configured.has(index))) {
      throw new Error('追加・更新アクションすべての settings を指定してください。')
    }
    const context = applyProposal({
      context: this.state.context,
      recentMessages: [],
      userMessage: proposal.sourceText,
      pendingProposal: { actions },
    })
    this.state = { context, updatedAt: this.nextTimestamp() }
    proposal.status = 'approved'
    return this.snapshot()
  }

  reject(proposalId: string): EventState {
    this.pending(proposalId).status = 'rejected'
    return this.snapshot()
  }
}
