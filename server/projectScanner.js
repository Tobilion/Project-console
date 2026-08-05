import { discoverProjects } from './projectScanContainer.js';
import { scanSingleProject } from './projectScanSingle.js';

/**
 * Project discovery orchestrator (Phase 14 split, 2026-08-05). The container scan
 * (discoverProjects) and the single-folder scan (scanSingleProject) live in
 * projectScanContainer.js / projectScanSingle.js; the shared recognition/parsing helpers
 * (isRecognizableByCodeAlone, sanitizeChatReplies, buildFallbackConfig, CONTEXT_FILENAMES,
 * readProjectContextDocs, commandEntriesFromDocs) live in projectScanHelpers.js. All bodies
 * moved verbatim from this file's pre-split 349 lines.
 */
export { discoverProjects, scanSingleProject };
