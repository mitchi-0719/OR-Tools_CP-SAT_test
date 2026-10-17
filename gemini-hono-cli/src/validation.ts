import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AIChatInput, AIChatOutput, ApproveProposalRequest, Constraint, ProposedConstraint } from './types.js'

const ajv = new Ajv2020({ allErrors: true })
const names = ['common', 'min_gap_member', 'min_gap_bands', 'before', 'at_position', 'in_range', 'count', 'constraint']
const base = 'https://setlist.local/schemas/'
const proposalRefs: { $ref: string }[] = []
for (const name of names) {
  const schema = JSON.parse(readFileSync(new URL('../schemas/' + name + '.schema.json', import.meta.url), 'utf8'))
  ajv.addSchema(schema)
  if (name === 'common' || name === 'constraint') continue
  const keys = ['type', 'targets', 'params', 'hardness', 'priority']
  const proposed = {
    ...schema,
    $id: base + 'proposed-' + name + '.schema.json',
    required: keys,
    properties: {
      ...Object.fromEntries(keys.map((key) => [key, schema.properties[key]])),
      hardness: { enum: ['hard', 'soft', null] },
      priority: { enum: ['high', 'mid', 'low', null] },
    },
  }
  ajv.addSchema(proposed)
  proposalRefs.push({ $ref: proposed.$id })
}

const text = { type: 'string', minLength: 1 }
const integer = { type: 'integer', minimum: 0 }
function object(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties }
}
function array(items: unknown) {
  return { type: 'array', items }
}
const proposedConstraint = { oneOf: proposalRefs }
const actions = array({
  oneOf: [
    object({ type: { const: 'add_constraint' }, constraint: proposedConstraint }),
    object({ type: { const: 'update_constraint' }, constraintId: text, constraint: proposedConstraint }),
    object({ type: { const: 'delete_constraint' }, constraintId: text }),
  ],
})
const checkInput = ajv.compile<AIChatInput>(
  object({
    context: object({
      event: object({ title: { type: 'string' } }),
      parts: { ...array(object({ partId: text, sortOrder: integer, partName: { type: ['string', 'null'] } })), minItems: 1 },
      bands: { ...array(object({ bandId: text, bandName: text })), minItems: 1 },
      members: array(object({ memberId: text, memberName: text })),
      memberships: array(object({ bandId: text, memberId: text })),
      constraints: array({ $ref: base + 'constraint.schema.json' }),
      currentPlacements: array(object({ bandId: text, partId: text, order: integer })),
    }),
    recentMessages: array(object({ role: { enum: ['user', 'assistant'] }, text: { type: 'string' } })),
    userMessage: text,
    pendingProposal: { anyOf: [{ type: 'null' }, object({ actions })] },
  }),
)

const checkOutput = ajv.compile<AIChatOutput>({
  oneOf: [
    object({ type: { const: 'approval_required' }, message: text, actions: { ...actions, minItems: 1 } }),
    object({ type: { const: 'clarification_required' }, message: text, actions: { type: 'array', maxItems: 0 } }),
    object({ type: { const: 'answer' }, message: text, actions: { type: 'array', maxItems: 0 } }),
  ],
})
const checkApproval = ajv.compile<ApproveProposalRequest>(object({
  proposalId: text,
  settings: array(object({
    actionIndex: integer,
    hardness: { enum: ['hard', 'soft'] },
    priority: { enum: ['high', 'mid', 'low', null] },
  })),
}))
const checkProposalId = ajv.compile<{ proposalId: string }>(object({ proposalId: text }))

export function validateOutput(value: unknown): asserts value is AIChatOutput {
  if (!checkOutput(value)) throw new Error(ajv.errorsText(checkOutput.errors, { separator: '\n' }))
}

export function validateApproval(value: unknown): asserts value is ApproveProposalRequest {
  if (!checkApproval(value)) throw new Error(ajv.errorsText(checkApproval.errors, { separator: '\n' }))
}

export function validateProposalId(value: unknown): asserts value is { proposalId: string } {
  if (!checkProposalId(value)) throw new Error(ajv.errorsText(checkProposalId.errors, { separator: '\n' }))
}

function unique<T>(values: T[], label: string): Set<T> {
  const set = new Set(values)
  if (set.size !== values.length) throw new Error(label + ' が重複しています。')
  return set
}
function requireId<T>(id: T, ids: Set<T>, label: string) {
  if (!ids.has(id)) throw new Error(label + ' が存在しません: ' + String(id))
}

export function validateConstraintReferences(
  constraint: ProposedConstraint | Constraint,
  context: AIChatInput['context'],
) {
  const bands = new Set(context.bands.map((b) => b.bandId))
  const members = new Set(context.members.map((m) => m.memberId))
  const parts = new Set(context.parts.map((p) => p.sortOrder))
  const { targets, params } = constraint
  if ('band_id' in targets) requireId(targets.band_id, bands, 'band_id')
  if ('band_ids' in targets) targets.band_ids.forEach((id) => requireId(id, bands, 'band_id'))
  if ('before_band_id' in targets) {
    requireId(targets.before_band_id, bands, 'before_band_id')
    requireId(targets.after_band_id, bands, 'after_band_id')
    if (targets.before_band_id === targets.after_band_id) throw new Error('before の前後に同じバンドは指定できません。')
  }
  if ('member_id' in targets) requireId(targets.member_id, members, 'member_id')
  if ('part_ids' in params) params.part_ids.forEach((id) => requireId(id, parts, 'part_ids (sortOrder)'))
  if ('position_from' in params && params.position_from > params.position_to) throw new Error('position_from は position_to 以下にしてください。')
  if ('min' in params && params.min > params.max) throw new Error('min は max 以下にしてください。')
}

export function validateResolved(constraint: ProposedConstraint | Constraint) {
  if (constraint.hardness === null) throw new Error('承認前に hardness を hard / soft に設定してください。')
  if (constraint.hardness === 'hard' && constraint.priority !== null) throw new Error('hard の priority は null にしてください。')
  if (constraint.hardness === 'soft' && constraint.priority === null) throw new Error('soft の priority を high / mid / low に設定してください。')
}

export function validateInput(value: unknown): asserts value is AIChatInput {
  if (!checkInput(value)) throw new Error(ajv.errorsText(checkInput.errors, { separator: '\n' }))
  const { context } = value
  const bands = unique(context.bands.map((b) => b.bandId), 'bandId')
  const members = unique(context.members.map((m) => m.memberId), 'memberId')
  const parts = unique(context.parts.map((p) => p.partId), 'partId')
  unique(context.parts.map((p) => p.sortOrder), 'sortOrder')
  const constraints = unique(context.constraints.map((c) => c.constraint_id), 'constraint_id')
  for (const membership of context.memberships) {
    requireId(membership.bandId, bands, 'bandId')
    requireId(membership.memberId, members, 'memberId')
  }
  unique(context.memberships.map((m) => JSON.stringify([m.bandId, m.memberId])), '所属')
  unique(context.currentPlacements.map((p) => p.bandId), '配置済み bandId')
  unique(context.currentPlacements.map((p) => JSON.stringify([p.partId, p.order])), '配置位置')
  for (const placement of context.currentPlacements) {
    requireId(placement.bandId, bands, 'bandId')
    requireId(placement.partId, parts, 'partId')
  }
  for (const constraint of context.constraints) {
    validateResolved(constraint)
    validateConstraintReferences(constraint, context)
  }
  const changedIds = new Set<string>()
  for (const action of value.pendingProposal?.actions ?? []) {
    if (action.type !== 'add_constraint') {
      requireId(action.constraintId, constraints, 'constraintId')
      if (changedIds.has(action.constraintId)) throw new Error('同じ制約に複数の変更が指定されています。')
      changedIds.add(action.constraintId)
    }
    if (action.type !== 'delete_constraint') validateConstraintReferences(action.constraint, context)
  }
}
