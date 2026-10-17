import { randomUUID } from 'node:crypto'
import { MOCK_EVENT_ID } from './config.js'
import { validateInput, validateResolved } from './validation.js'
import type { AIChatInput, Constraint } from './types.js'

export function applyProposal(input: AIChatInput): AIChatInput['context'] {
  validateInput(input)
  if (!input.pendingProposal?.actions.length) throw new Error('承認待ちの変更案がありません。')
  const context = structuredClone(input.context)
  for (const action of input.pendingProposal.actions) {
    if (action.type === 'delete_constraint') {
      context.constraints = context.constraints.filter((c) => c.constraint_id !== action.constraintId)
      continue
    }
    validateResolved(action.constraint)
    if (action.type === 'add_constraint') {
      context.constraints.push({
        schema_version: '1.0.0',
        constraint_id: randomUUID(),
        event_id: MOCK_EVENT_ID,
        source_text: input.userMessage,
        enabled: true,
        ...action.constraint,
      } as Constraint)
    } else {
      const index = context.constraints.findIndex((c) => c.constraint_id === action.constraintId)
      context.constraints[index] = { ...context.constraints[index], ...action.constraint } as Constraint
    }
  }
  validateInput({ ...input, context, pendingProposal: null })
  return context
}
