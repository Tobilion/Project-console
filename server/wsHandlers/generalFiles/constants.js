// Shared caps + category maps for the general-files domain (Phase 2, split 2026-09-09).
// Single source of truth so find/tidy/duplicates/rename/move can never drift apart on
// their answer caps, scan bounds, or the tidy category vocabulary.

export const MAX_RESULTS = 20;          // find/duplicates answer cap (matches big-list intent conventions)
export const MAX_CONTENT_FILE_BYTES = 20000; // don't substring-scan huge files (codebaseData.MAX_FILE_READ_BYTES)
export const MAX_HASH_FILES = 2000;     // duplicates scan cap — bounded walk, never a full-disk hash storm
export const MAX_HASH_FILE_BYTES = 50 * 1024 * 1024; // skip bigger files with a note rather than hashing them
export const MAX_PREIMAGE_BYTES = 1_000_000; // same inline pre-image cap as tools.js wrapMutatingTool
export const MAX_TIDY_MOVES = 100;      // one tidy run is bounded; the user re-runs for the rest
export const MAX_PREVIEW_LINES = 12;    // confirm prompt shows a sample, not a wall of moves

// Extension -> category folder for "organize by type". Deliberately conservative: only these
// well-known media/document families move; unknown extensions stay where they are.
export const CATEGORY_BY_EXT = {
  images: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic'],
  documents: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt', '.epub'],
  spreadsheets: ['.xls', '.xlsx', '.csv', '.ods'],
  presentations: ['.ppt', '.pptx', '.odp'],
  archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'],
  audio: ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'],
  video: ['.mp4', '.mkv', '.avi', '.mov', '.webm'],
};
export const EXT_TO_CATEGORY = new Map();
for (const [cat, exts] of Object.entries(CATEGORY_BY_EXT)) {
  for (const ext of exts) EXT_TO_CATEGORY.set(ext, cat);
}
export const CATEGORY_LABEL = {
  images: 'Images', documents: 'Documents', spreadsheets: 'Spreadsheets',
  presentations: 'Presentations', archives: 'Archives', audio: 'Audio', video: 'Video',
};