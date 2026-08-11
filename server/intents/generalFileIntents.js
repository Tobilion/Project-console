// Phase 2 (UPGRADE-ROADMAP.md, 2026-08-11): general-mode file tool intents — find-by-name/
// content search, folder tidy, and duplicate detection/deletion. All four are usable from any
// workspace type (never hard-gated); the phrase sets deliberately avoid file_find's locate
// shapes ("where is main.py", "find the config file") so the two name-search intents stay
// apart in the matcher. Mutating shapes (tidy, delete-duplicates) are confirm-gated in
// builtinGeneralFiles.js and journaled through actionHistory.js — read-only find/duplicates
// never confirm.
export const GENERAL_FILE_INTENTS = {
  'general.files.find': {
    examples: [
      'find files matching invoice', 'find files containing tax', 'search my files for budget',
      'search for budget in my files', 'search all my files for expenses', 'search my documents for recipe',
      'look through my files for lease', 'find files with the word meeting', 'search the files for contract',
      'grep my files for rent', 'find files that mention vacation', 'find documents containing warranty',
      'find files that contain insurance', 'find any file about the warranty', 'look for the file about rent',
      'find files named like report', 'find files with report in the name', 'search all documents for invoice',
      'find the files about the lease', 'search my folder for budget', 'search my project for meeting notes',
      'find files about taxes', 'search for contract in my files', 'search for vacation in my documents',
    ],
  },
  'general.files.tidy': {
    examples: [
      'tidy this folder', 'tidy up this folder', 'organize this folder by type', 'organize this folder by date',
      'organize my files by type', 'organize my files by date', 'sort this folder', 'sort my files by type',
      'clean up this folder', 'organize files by category', 'tidy my files', 'organize this folder',
      'sort my files by date', 'organize the files by type', 'tidy the folder', 'sort files by type',
      'organize by year', 'organize by month', 'organize these files by type', 'tidy up my files',
      'sort these files by type', 'organize this folder by year',
    ],
  },
  'general.files.duplicates': {
    examples: [
      'find duplicate files', 'find duplicates', 'find duplicate files in this folder',
      'look for duplicate files', 'check for duplicate files', 'find duplicate documents',
      'are there any duplicate files', 'find files that are duplicated', 'detect duplicate files',
      'find identical files', 'scan for duplicate files', 'find duplicate photos',
      'search for duplicate files', 'check the folder for duplicates',
    ],
  },
  'general.files.duplicates_delete': {
    examples: [
      'delete duplicate files', 'remove duplicate files', 'delete duplicates keep newest',
      'delete duplicates', 'remove duplicates', 'delete all duplicate files',
      'get rid of duplicate files', 'delete the duplicates', 'remove duplicate files keep the newest',
      'delete duplicate files keep newest', 'clean up duplicate files', 'remove the duplicate files',
      'delete every duplicate file',
    ],
  },
};
