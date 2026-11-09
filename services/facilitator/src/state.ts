/**
 * Settlement state machine.
 *
 * States and the ONLY legal transitions between them. Everything else fails closed.
 *
 *   created ──claim──▶ prepared ──durable hash──▶ prepared (hash bound)
 *                                       │
 *                                       └──submit claimed──▶ submitting
 *                                                              │
 *                                                              └──broadcast sent──▶ outcome_unknown
 *                                                                                      │
 *                                                        verified finality ─────────────┼──▶ finalized
 *                                                        verified rejection ─────────────┼──▶ rejected
 *                                                        not found / committed / no evidence ──▶ stays
 *
 * TASK 29 adds the pre-broadcast states. The rule that closes the TASK 27 crash window:
 *
 *   **A payment may never enter a broadcast-eligible state without a durable transaction hash.**
 *
 * `prepared` is terminal-for-preparation: the hash is committed and no submission may start
 * until a claim is taken against that exact hash. `submitting` exists so a crash between the
 * claim and the broadcast is distinguishable from "we never got to submit".
 *
 * There is deliberately no edge from `finalized` or `rejected` to anywhere, and none from
 * `rejected` to `finalized`: once terminal, always terminal.
 */

export type SettlementState =
  | 'created'
  | 'prepared'
  | 'submitting'
  | 'outcome_unknown'
  | 'observed'
  | 'finalized'
  | 'rejected'
  | 'recovery_unavailable';

export const TERMINAL_STATES: readonly SettlementState[] = ['finalized', 'rejected'];

const TRANSITIONS: Record<SettlementState, readonly SettlementState[]> = {
  // A freshly claimed payment is prepared for submission; the hash is persisted in `prepared`.
  // `created → outcome_unknown` is admitted because a submission attempt that throws before
  // the hash is durable is still ambiguous: we cannot prove nothing was broadcast. It is
  // never a success and never resubmittable.
  created: ['prepared', 'outcome_unknown', 'rejected'],
  // prepared: the hash is durable; we may take the claim and move to submitting.
  prepared: ['submitting', 'rejected'],
  // submitting: the broadcast has been claimed but may not have reached the node yet.
  submitting: ['outcome_unknown', 'rejected'],
  // outcome_unknown: the most important state. It means "we may have broadcast". It can only
  // be resolved by verified evidence, never by absence of evidence, and never by retry.
  outcome_unknown: ['observed', 'finalized', 'rejected', 'recovery_unavailable'],
  // observed: evidence says the tx exists but is not yet finalized. Still non-terminal.
  observed: ['finalized', 'rejected', 'outcome_unknown'],
  // Terminal.
  finalized: [],
  rejected: [],
  // recovery_unavailable: we cannot currently obtain evidence. Not terminal — reconciliation
  // can be retried later — but it is NOT a success and must not be retried as a submission.
  recovery_unavailable: ['outcome_unknown', 'observed', 'finalized', 'rejected'],
};

export function isTerminal(state: SettlementState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: SettlementState, to: SettlementState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(from: SettlementState, to: SettlementState) {
    super(`illegal settlement transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export type ObservedStatus = 'pending' | 'committed' | 'finalized' | 'failed' | 'rejected' | 'unknown';

export function interpretObservation(status: ObservedStatus):
  | { advance: 'finalized' }
  | { advance: 'rejected' }
  | { advance: 'stay' } {
  switch (status) {
    case 'finalized':
      return { advance: 'finalized' };
    case 'failed':
    case 'rejected':
      return { advance: 'rejected' };
    case 'committed':
    case 'pending':
    case 'unknown':
      return { advance: 'stay' };
    default:
      return { advance: 'stay' };
  }
}

export const ALLOWED_TRANSITIONS = TRANSITIONS;

/** True only when a payment is safe to reconcile against node evidence. */
export function isReconcilable(state: SettlementState): boolean {
  return state === 'outcome_unknown' || state === 'observed' || state === 'recovery_unavailable';
}
