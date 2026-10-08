/**
 * Entry point for owner trust decisions (#5575 ENG-4): loads every checked
 * handler, then dispatches. Callers (the confirm/review ops, the CLI, IPC
 * delegation) establish the owner's confirmation first (trust/confirm.ts).
 */
import './supersede-handlers.ts';
import './page-handlers.ts';

export { decideTrustProposal } from './proposals.ts';
