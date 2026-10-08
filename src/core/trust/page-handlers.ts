/**
 * Checked handler for `lower_page` trust proposals (#5575 CEO-12): accept
 * keeps the agent edit at its lowered tier; revert restores the prior owner
 * version's content and tier through the CEO-9 rule.
 */
import type { TrustProposalAction } from './proposals.ts';

export const PAGE_HANDLER_ACTIONS: readonly TrustProposalAction[] = [];
