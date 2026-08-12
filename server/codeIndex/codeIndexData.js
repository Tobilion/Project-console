// Pure-data registry for the semantic code index (Phase 7, 2026-08-11). All static paths,
// caps, and ignore lists shared by the chunker/store/builder — nothing here imports anything.
import { REAL_CODE_EXTS, IGNORE_DIRS } from '../codebaseData.js';

// The index lives inside the project's .console/ dir — the same folder that sessions,
// chat-log.md, and memory.md already use, which is auto-gitignored on first session creation
// (see conversationStore.js's ensureGitignored). A several-MB per-project JSON file must never
// ride along with the project's own git history.
export const INDEX_FILENAME = 'code-index.json';

// Files over this size are skipped entirely (same cap as actionHistory.js's pre-image guard —
// huge generated/bundled files would dominate the chunk budget for no search value).
export const MAX_FILE_BYTES = 1024 * 1024;

// Per-file and per-project budgets. The store evicts deterministically: the builder walks the
// project tree in readProjectTree order and stops adding files once MAX_CHUNKS_PER_PROJECT is
// reached, so a huge project gets its shallowest/earliest files indexed, never a random subset.
export const MAX_FILES_PER_PROJECT = 4000;
export const MAX_CHUNKS_PER_PROJECT = 20000;

// Fixed-window fallback for files whose language has no symbol extraction: 40 lines with 10
// lines of overlap between consecutive chunks, so a symbol spanning a window boundary still
// appears in full in at least one chunk.
export const CHUNK_LINES = 40;
export const CHUNK_OVERLAP = 10;

// A symbol-anchored chunk (a top-level function/class) can legitimately be hundreds of lines —
// cap the text embedded per chunk and split oversized bodies at this limit.
export const MAX_CHUNK_CHARS = 2000;

// How many chunks a query returns (file:line citations, most-relevant first).
export const TOP_K_QUERY = 8;

// Cap on the snippet text rendered per result in an answer (the full chunk text lives in the
// store; this only bounds what the chat bubble carries).
export const MAX_RESULT_SNIPPET_CHARS = 600;

// Bump to invalidate every persisted store and force a full rebuild (chunk schema changes).
export const INDEX_VERSION = 1;

// Directories never walked for code-content chunks. node_modules/.git/.console are non-negotiable;
// the rest mirror codebaseData's IGNORE_DIRS so generated output never gets indexed twice.
export const INDEX_IGNORE_DIRS = new Set([
  ...IGNORE_DIRS,
  '.console',
]);

export const INDEX_EXTS = REAL_CODE_EXTS;

// Phase 16 (2026-08-12): non-code documents the knowledge-base index also covers — PDFs
// (via pdfKit's extractPdfTextBytes), .docx (mammoth), and plain prose files (.md/.txt).
// Deliberately narrow: these are prose documents, not "anything with text".
export const INDEX_DOC_EXTS = new Set(['.pdf', '.docx', '.md', '.txt']);

// PDFs/docx are binary — the 1MB cap still applies but text extraction happens on bytes.
export const MAX_DOC_BYTES = 20 * 1024 * 1024;
