// Phase 2 (UPGRADE-ROADMAP.md, 2026-08-11): general-mode file tools — find by name/content,
// tidy by category/date, duplicate detection + deletion, rename, move. Trigger-mode-only: no
// model involved, zero AI dependency (plain substring search, sha256 hashing). Read-only shapes
// (find, duplicates) answer immediately; mutating shapes (tidy, duplicates_delete, rename,
// move) go through the standard confirm flow with a move/delete preview and journal every
// change through actionHistory.js so `revert action <id>` undoes them. Every path is validated
// by createResolveSafe (toolSandbox.js — the same symlink-aware escape rejection the AI tools
// use), never a hand-rolled check.
//
// Design note: the handlers write via plain fs calls journaled directly through appendAction
// (new `file_move` action type) rather than via a tools.js wrapped tool — there is no move
// tool in the tool layer, and Phase 12 of the roadmap explicitly defers that refactor to a
// dedicated audit. The journal + revert contract is identical either way.
//
// Split 2026-09-09 (B.1): this file is now a thin dispatcher over the domain leaves in
// `generalFiles/` — find/tidy/duplicates/rename/move plus the shared confirm helper queue.js.
// The public export surface below (handler map + the perform*/plan* functions consumed by
// connectionConfirm.js, fileToolsRoutes.js, and checkHandlerCoverage.js) is unchanged.

import { handleFind, extractFindQuery } from './generalFiles/find.js';
export { extractFindQuery } from './generalFiles/find.js';
import { handleTidy } from './generalFiles/tidy.js';
export { planTidy, performTidy } from './generalFiles/tidy.js';
import { handleDuplicates, handleDuplicatesDelete } from './generalFiles/duplicates.js';
export { findDuplicates, planDuplicateDeletes, performDuplicateDeletes } from './generalFiles/duplicates.js';
import { handleRename } from './generalFiles/rename.js';
export { performRename } from './generalFiles/rename.js';
import { handleMove } from './generalFiles/move.js';
export { performMove } from './generalFiles/move.js';

export const generalFileHandlers = {
  'general.files.find': handleFind,
  'general.files.tidy': handleTidy,
  'general.files.duplicates': handleDuplicates,
  'general.files.duplicates_delete': handleDuplicatesDelete,
  'general.files.rename': handleRename,
  'general.files.move': handleMove,
};