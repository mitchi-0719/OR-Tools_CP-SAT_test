import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from './app.js'
import { buildGeminiRequest, SYSTEM_INSTRUCTION } from './gemini.js'
import { buildInput } from './input.js'
import { MockState } from './state.js'
import { validateOutput } from './validation.js'
import type { AIChatInput, AIChatOutput, ApprovalResponse, Constraint, EventState } from './types.js'

function post(app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function proposalInput(): Promise<AIChatInput> {
  const input = await buildInput('Everythingを第2部にしたい')
  input.pendingProposal = {
    actions: [{
      type: 'add_constraint',
      constraint: {
        type: 'in_range',
        targets: { band_ids: ['band-003'] },
        params: { kind: 'parts', part_ids: [1] },
        hardness: null,
        priority: null,
      },
    }],
  }
  return input
}

async function outputFixture(): Promise<Extract<AIChatOutput, { type: 'approval_required' }>> {
  const input = await proposalInput()
  return { type: 'approval_required', message: 'Everythingを第2部に配置する条件を追加します。', actions: input.pendingProposal!.actions }
}

const settings = [{ actionIndex: 0, hardness: 'soft', priority: 'high' }]
async function getState(app: ReturnType<typeof createApp>) {
  return await (await app.request('/context')).json() as EventState
}

test('model text passes through unchanged and system instructions are separate from the four input fields', async () => {
  const input = await proposalInput()
  input.userMessage = 'やっぱり第3部にして'
  input.recentMessages = [{ role: 'user', text: 'Everythingを第2部にしたい' }]
  const raw = '  {\n "type":"answer", "message":"そのまま返す日本語", "actions":[] }\n'
  const app = createApp(async (received) => {
    assert.deepEqual(received, input)
    const request = buildGeminiRequest(received)
    assert.equal(request.config.systemInstruction, SYSTEM_INSTRUCTION)
    assert.equal(request.contents.length, 1)
    assert.deepEqual(JSON.parse(request.contents[0].parts[0].text), input)
    return raw
  })
  const response = await post(app, '/chat', input)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), raw)
  assert.match(response.headers.get('content-type') ?? '', /text\/plain/)
  assert.equal(response.headers.get('X-Proposal-Id'), null)
  assert.equal(response.headers.get('X-Proposal-Status'), null)
})

test('BE supplies the reduced CSV context for message-only requests', async () => {
  const app = createApp(async ({ context, recentMessages, userMessage, pendingProposal }) => {
    assert.equal(context.bands.length, 20)
    assert.equal(context.members.length, 63)
    assert.equal(context.memberships.length, 110)
    assert.deepEqual(context.constraints, [])
    assert.deepEqual(context.currentPlacements, [])
    assert.deepEqual(recentMessages, [])
    assert.equal(userMessage, '出演バンドを教えて')
    assert.equal(pendingProposal, null)
    const member = context.members.find((m) => m.memberName === 'ダミー003')!
    assert.deepEqual(context.memberships.filter((m) => m.memberId === member.memberId).map((m) => m.bandId), ['band-001', 'band-002'])
    return '{"type":"answer","message":"出演バンド一覧です。","actions":[]}'
  })
  assert.equal((await post(app, '/chat', { userMessage: '出演バンドを教えて' })).status, 200)
})

test('the output union allows actions only for approvals and forbids model-generated proposal IDs', async () => {
  const output = await outputFixture()
  validateOutput(output)
  validateOutput({ type: 'answer', message: '回答', actions: [] })
  validateOutput({ type: 'clarification_required', message: '対象はどれですか？', actions: [] })
  for (const invalid of [
    { ...output, actions: [] },
    { ...output, type: 'answer' },
    { ...output, type: 'clarification_required' },
    { ...output, proposalId: 'made-by-model' },
    { ...output, type: 'legacy_type' },
  ]) {
    assert.throws(() => validateOutput(invalid))
  }
})

test('invalid output and invalid action references remain raw but are never registered for approval', async () => {
  const output = await outputFixture()
  const action = output.actions[0]
  if (action.type !== 'add_constraint' || !('band_ids' in action.constraint.targets)) throw new Error('bad fixture')
  action.constraint.targets.band_ids = ['unknown']
  for (const raw of ['not JSON\n', JSON.stringify(output), '{"type":"clarification_required","message":"質問","actions":[{}]}']) {
    const app = createApp(async () => raw)
    const response = await post(app, '/chat', { userMessage: '質問' })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), raw)
    assert.equal(response.headers.get('X-Proposal-Id'), null)
    assert.equal(response.headers.get('X-Proposal-Status'), 'invalid_output')
  }
})

test('invalid proposal IDs, part ID types and unsupported constraints in input never call the model', async () => {
  const app = createApp(async () => { assert.fail('Must not call the LLM') })
  for (const constraint of [
    { type: 'in_range', targets: { band_ids: ['unknown'] }, params: { kind: 'parts', part_ids: [1] }, hardness: null, priority: null },
    { type: 'in_range', targets: { band_ids: ['band-003'] }, params: { kind: 'parts', part_ids: ['part-2'] }, hardness: null, priority: null },
    { type: 'unknown', targets: {}, params: {}, hardness: null, priority: null },
  ]) {
    const input = await buildInput('修正して')
    assert.equal((await post(app, '/chat', { ...input, pendingProposal: { actions: [{ type: 'add_constraint', constraint }] } })).status, 400)
  }
})

test('BE issues IDs, accepts only ID/settings on approval, applies stored actions and prevents replay', async () => {
  const output = await outputFixture()
  const raw = JSON.stringify(output, null, 2) + '\n'
  let calls = 0
  const app = createApp(async () => { calls++; return raw })
  const response = await post(app, '/chat', { userMessage: 'Everythingを第2部にしたい' })
  const proposalId = response.headers.get('X-Proposal-Id')!
  assert.match(proposalId, /^[a-f0-9-]{36}$/)
  assert.equal(await response.text(), raw)
  const held = await (await app.request('/proposals/' + proposalId)).json() as ApprovalResponse
  assert.deepEqual(held, { ...output, proposalId })
  const injected = await post(app, '/proposals/approve', { proposalId, settings, actions: [] })
  assert.equal(injected.status, 400)
  const approved = await post(app, '/proposals/approve', { proposalId, settings })
  assert.equal(approved.status, 200)
  const result = await approved.json() as EventState
  assert.equal(result.context.constraints.length, 1)
  const constraint = result.context.constraints[0]
  assert.equal(constraint.hardness, 'soft')
  assert.equal(constraint.priority, 'high')
  assert.equal(constraint.source_text, 'Everythingを第2部にしたい')
  assert.equal(constraint.constraint_id === proposalId, false)
  assert.deepEqual(constraint.targets, { band_ids: ['band-003'] })
  assert.deepEqual(constraint.params, { kind: 'parts', part_ids: [1] })
  assert.equal((await post(app, '/proposals/approve', { proposalId, settings })).status, 409)
  assert.equal(calls, 1)
})

test('rejection needs no settings and never calls the model or changes the event', async () => {
  const output = await outputFixture()
  let calls = 0
  const app = createApp(async () => { calls++; return JSON.stringify(output) })
  const before = await getState(app)
  const response = await post(app, '/chat', { userMessage: '追加して' })
  const proposalId = response.headers.get('X-Proposal-Id')
  const rejected = await post(app, '/proposals/reject', { proposalId })
  assert.equal(rejected.status, 200)
  assert.deepEqual(await getState(app), before)
  assert.equal((await post(app, '/proposals/reject', { proposalId })).status, 409)
  assert.equal((await post(app, '/proposals/reject', { proposalId: 'unknown' })).status, 404)
  assert.equal(calls, 1)
})

test('settings are validated atomically for missing, duplicate, out-of-range, hardness and priority errors', async () => {
  const output = await outputFixture()
  const app = createApp(async () => JSON.stringify(output))
  const response = await post(app, '/chat', { userMessage: '追加して' })
  const proposalId = response.headers.get('X-Proposal-Id')
  const before = await getState(app)
  for (const invalidSettings of [
    [],
    [...settings, ...settings],
    [{ actionIndex: 99, hardness: 'hard', priority: null }],
    [{ actionIndex: 0, hardness: null, priority: null }],
    [{ actionIndex: 0, hardness: 'hard', priority: 'high' }],
    [{ actionIndex: 0, hardness: 'soft', priority: null }],
  ]) {
    assert.equal((await post(app, '/proposals/approve', { proposalId, settings: invalidSettings })).status, 400)
    assert.deepEqual(await getState(app), before)
  }
  assert.equal((await post(app, '/proposals/approve', { proposalId, settings })).status, 200)
})

test('update/delete use stored full actions and retain disabled metadata and chosen settings', async () => {
  const input = await proposalInput()
  const existing: Constraint = {
    schema_version: '1.0.0', constraint_id: 'existing', event_id: 'event-mock',
    type: 'at_position', hardness: 'soft', priority: 'mid', enabled: false,
    targets: { band_id: 'band-001' }, params: { position: 0 },
  }
  input.context.constraints = [existing, { ...existing, constraint_id: 'to-delete' }]
  const action = input.pendingProposal!.actions[0]
  if (action.type !== 'add_constraint') throw new Error('bad fixture')
  const output: AIChatOutput = {
    type: 'approval_required', message: '条件を更新・削除します。',
    actions: [
      { type: 'update_constraint', constraintId: 'existing', constraint: { ...action.constraint, hardness: 'soft', priority: 'mid' } },
      { type: 'delete_constraint', constraintId: 'to-delete' },
    ],
  }
  const app = createApp(async () => JSON.stringify(output), new MockState(input.context))
  const before = structuredClone(input.context)
  const response = await post(app, '/chat', { userMessage: '範囲を変更して' })
  const proposalId = response.headers.get('X-Proposal-Id')
  const approved = await post(app, '/proposals/approve', { proposalId, settings: [{ actionIndex: 0, hardness: 'soft', priority: 'mid' }] })
  assert.equal(approved.status, 200)
  const result = await approved.json() as EventState
  assert.equal(result.context.constraints.length, 1)
  const updated = result.context.constraints[0]
  assert.equal(updated.constraint_id, 'existing')
  assert.equal(updated.enabled, false)
  assert.equal(updated.type, 'in_range')
  assert.equal(updated.hardness, 'soft')
  assert.equal(updated.priority, 'mid')
  assert.deepEqual(input.context, before)
})

test('event updatedAt conflicts block stale approvals, including event changes during generation', async () => {
  const output = await outputFixture()
  let release!: (value: string) => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const state = new MockState()
  const app = createApp(async () => {
    started()
    return await new Promise<string>((resolve) => { release = resolve })
  }, state)
  const original = state.snapshot()
  const pending = post(app, '/chat', { userMessage: '追加して' })
  await entered
  const changed = structuredClone(original.context)
  changed.event.title = '変更後のライブ'
  state.replaceContext(changed, original.updatedAt)
  release(JSON.stringify(output))
  const response = await pending
  assert.equal(response.headers.get('X-Event-Updated-At'), original.updatedAt)
  const proposalId = response.headers.get('X-Proposal-Id')
  assert.equal((await post(app, '/proposals/approve', { proposalId, settings })).status, 409)
  assert.equal(state.snapshot().context.event.title, '変更後のライブ')
  assert.deepEqual(state.snapshot().context.constraints, [])
  assert.equal((await post(app, '/proposals/reject', { proposalId })).status, 200)
})

test('revisions pass UI-selected settings to the model and supersede old proposal IDs', async () => {
  const first = await outputFixture()
  const revised = structuredClone(first)
  const action = revised.actions[0]
  if (action.type !== 'add_constraint' || !('part_ids' in action.constraint.params)) throw new Error('bad fixture')
  action.constraint.params.part_ids = [2]
  action.constraint.hardness = 'soft'
  action.constraint.priority = 'mid'
  let calls = 0
  const app = createApp(async (input) => {
    calls++
    if (calls === 2) {
      const originalAction = input.pendingProposal!.actions[0]
      if (originalAction.type !== 'add_constraint') throw new Error('bad fixture')
      assert.equal(originalAction.constraint.hardness, 'soft')
      assert.equal(originalAction.constraint.priority, 'mid')
    }
    return JSON.stringify(calls === 1 ? first : revised)
  })
  const initial = await post(app, '/chat', { userMessage: '第2部にして' })
  const firstId = initial.headers.get('X-Proposal-Id')!
  const uiActions = structuredClone(first.actions)
  const uiAction = uiActions[0]
  if (uiAction.type !== 'add_constraint') throw new Error('bad fixture')
  uiAction.constraint.hardness = 'soft'
  uiAction.constraint.priority = 'mid'
  const second = await post(app, '/chat', { userMessage: '第3部にして', pendingProposal: { actions: uiActions } }, { 'X-Pending-Proposal-Id': firstId })
  const secondId = second.headers.get('X-Proposal-Id')!
  assert.notEqual(firstId, secondId)
  assert.equal((await post(app, '/proposals/approve', { proposalId: firstId, settings })).status, 409)
  const approved = await post(app, '/proposals/approve', { proposalId: secondId, settings })
  assert.equal(approved.status, 200)
  const current = await getState(app)
  assert.deepEqual(current.context.constraints[0].params, { kind: 'parts', part_ids: [2] })
  assert.equal(calls, 2)
})

test('provider errors remain HTTP errors rather than successful LLM responses', async () => {
  const app = createApp(async () => { throw new Error('upstream failure') })
  assert.equal((await post(app, '/chat', { userMessage: 'こんにちは' })).status, 502)
})
