type ConstraintFields =
  | { type: 'before'; targets: { before_band_id: string; after_band_id: string }; params: Record<string, never> }
  | { type: 'at_position'; targets: { band_id: string }; params: { position: number } }
  | { type: 'min_gap_member'; targets: { member_id: string }; params: { min_diff: number; same_part_only: boolean } }
  | { type: 'min_gap_bands'; targets: { band_ids: string[] }; params: { min_diff: number; same_part_only: boolean } }
  | {
      type: 'in_range'
      targets: { band_ids: string[] }
      params:
        | { kind: 'positions'; position_from: number; position_to: number }
        | { kind: 'parts'; part_ids: number[] }
    }
  | {
      type: 'count'
      targets: { band_ids: string[] }
      params:
        | { scope: 'per_part'; min: number; max: number }
        | { scope: 'in_parts'; part_ids: number[]; min: number; max: number }
    }

export type Priority = 'high' | 'mid' | 'low'

export type Constraint = ConstraintFields & {
  schema_version: '1.0.0'
  constraint_id: string
  event_id: string
  source_text?: string
  enabled: boolean
} & (
  | { hardness: 'hard'; priority: null }
  | { hardness: 'soft'; priority: Priority }
)

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type ProposedConstraint = DistributiveOmit<
  Constraint,
  'schema_version' | 'constraint_id' | 'event_id' | 'source_text' | 'hardness' | 'priority' | 'enabled'
> & {
  hardness: 'hard' | 'soft' | null
  priority: Priority | null
}

export type ConstraintProposalAction =
  | { type: 'add_constraint'; constraint: ProposedConstraint }
  | { type: 'update_constraint'; constraintId: string; constraint: ProposedConstraint }
  | { type: 'delete_constraint'; constraintId: string }

export type AIChatInput = {
  context: {
    event: { title: string }
    parts: { partId: string; sortOrder: number; partName: string | null }[]
    bands: { bandId: string; bandName: string }[]
    members: { memberId: string; memberName: string }[]
    memberships: { bandId: string; memberId: string }[]
    constraints: Constraint[]
    currentPlacements: { bandId: string; partId: string; order: number }[]
  }
  recentMessages: { role: 'user' | 'assistant'; text: string }[]
  userMessage: string
  pendingProposal: { actions: ConstraintProposalAction[] } | null
}

export type AIChatOutput =
  | { type: 'approval_required'; message: string; actions: ConstraintProposalAction[] }
  | { type: 'clarification_required'; message: string; actions: [] }
  | { type: 'answer'; message: string; actions: [] }

export type ApprovalResponse = Extract<AIChatOutput, { type: 'approval_required' }> & {
  proposalId: string
}

export type ApproveProposalRequest = {
  proposalId: string
  settings: {
    actionIndex: number
    hardness: 'hard' | 'soft'
    priority: Priority | null
  }[]
}

export type EventState = { context: AIChatInput['context']; updatedAt: string }
