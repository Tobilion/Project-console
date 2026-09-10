// Phase 2 (UPGRADE-ROADMAP.md, 2026-08-11): general-mode file tool intents — find-by-name/
// content search, folder tidy, and duplicate detection/deletion. All four are usable from any
// workspace type (never hard-gated); the phrase sets deliberately avoid file_find's locate
// shapes ("where is main.py", "find the config file") so the two name-search intents stay
// apart in the matcher. Mutating shapes (tidy, delete-duplicates) are confirm-gated in
// builtinGeneralFiles.js and journaled through actionHistory.js — read-only find/duplicates
// never confirm.
export const GENERAL_FILE_INTENTS = {
  'general.files.find': {
    opensPanel: 'file-tools',
    examples: [
      'find files matching invoice', 'find files containing tax', 'search my files for budget',
      'search for budget in my files', 'search all my files for expenses', 'search my documents for recipe',
      'look through my files for lease', 'find files with the word meeting', 'search the files for contract',
      'grep my files for rent', 'find files that mention vacation', 'find documents containing warranty',
      'find files that contain insurance', 'find any file about the warranty', 'look for the file about rent',
      'find files named like report', 'find files with report in the name', 'search all documents for invoice',
      'find the files about the lease', 'search my folder for budget', 'search my project for meeting notes',
      'find files about taxes', 'search for contract in my files', 'search for vacation in my documents',
    
      'QUICKLY FIND HI, DOCUMENTS WARRANTY CONTAINING',
      'contract for search yo files in my :)',
      'find docs named like rfport',
      'please in my searchh for budget files',
      'search my documents for budget',
      'hi, search all documents for invoice :)',
      'hey, search all documents for invocie',
      'search all documents for invoice quickly',
      'Find files asap like report named',
      'search the files for contrract',
      'can you search my documents for recipe',
      'anmed documents like quickly find yo report',
      'Hey, search all documents for invoice asap',
      'find docs htat mention vacation',
      'Find docs with report in the naxe!!',
      'find like report named hey, documents'
      ],
  },
  'general.files.tidy': {
    opensPanel: 'file-tools',
    examples: [
      'tidy this folder', 'tidy up this folder', 'organize this folder by type', 'organize this folder by date',
      'organize my files by type', 'organize my files by date', 'sort this folder', 'sort my files by type',
      'clean up this folder', 'organize files by category', 'tidy my files', 'organize this folder',
      'sort my files by date', 'organize the files by type', 'tidy the folder', 'sort files by type',
      'organize by year', 'organize by month', 'organize these files by type', 'tidy up my files',
      'sort these files by type', 'organize this folder by year',
    
      'up you fiiles tidy my could!',
      'Sort docs by type :)',
      'tidy this folder asap :p',
      'ORGANIZE THESE DOCUMENTS BY TYPE',
      'folder could up tidy this you',
      'so sort my docs by type',
      'THE TIDY FOLDER',
      'hi, tidy the folder now 🙏',
      'Folder up could you tidy thiss',
      'FOR BY FILES TYPE THE ME ORGANIZE',
      'type by files sort :)',
      'hi, tidy up my documents',
      'by type organize this please please folder',
      'the can folder you tidy',
      'sort these documents by type',
      'hi, organize by yeaj quickly :p',
      'folder this up clean please',
      'Organige my docs by type',
      'UM CATEFORY ORGANIZE BY FILES :)'
      ],
  },
  'general.files.duplicates': {
    opensPanel: 'file-tools',
    examples: [
      'find duplicate files', 'find duplicates', 'find duplicate files in this folder',
      'look for duplicate files', 'check for duplicate files', 'find duplicate documents',
      'are there any duplicate files', 'find files that are duplicated', 'detect duplicate files',
      'find identical files', 'scan for duplicate files', 'find duplicate photos',
      'search for duplicate files', 'check the folder for duplicates',
    
      'Hey check for duplicate files for me 🙏',
      'are there any duplicate documents',
      'Are duplicate documents there any thanks',
      'documents find hey, duplicate!',
      'hey now files find duplicate',
      'duplicate files detect quickl',
      'Coud you search for duplicate files',
      'DOCUMENTS THANKS DDUPLICATE FIND',
      'check for duplicate dcuments'
      ],
  },
  'general.files.duplicates_delete': {
    opensPanel: 'file-tools',
    examples: [
      'delete duplicate files', 'remove duplicate files', 'delete duplicates keep newest',
      'delete duplicates', 'remove duplicates', 'delete all duplicate files',
      'get rid of duplicate files', 'delete the duplicates', 'remove duplicate files keep the newest',
      'delete duplicate files keep newest', 'clean up duplicate files', 'remove the duplicate files',
      'delete every duplicate file',
    
      'FILES DUPLICATE REMOVE',
      'you keep the could newest remove duplicate doocs',
      'remove duplicate documents',
      'Now duplicate please files delete all 🙏',
      'cllean up duplicate documents',
      'hi, delete every duplicate doocument',
      'So remove duplicate documents :p',
      'duplicate all asap delete documents',
      'delete duplicate documents',
      'hi, remove the duplicate documents',
      'files duplicate all delete hi,',
      'dehete duplicate docs',
      'delete all duplicate documents',
      'Duplicate me remove files for',
      'all files delete duplicate',
      'get duplicate files of rid',
      'remove please tthanks duplicates',
      'asap file duplicate of rid get please!',
      'hey drop duplicates for me',
      'hi, remove the duplicate documents :p',
      'dupilcate delete files hey, all',
      'of rid files get hey dupliate',
      'NEWEST DUPLICATE DELETE KEEP YOU COULD DOCS'
      ],
  },
  // Phase 8 follow-up (2026-08-24): file rename + move — the Folder Explorer's in-place
  // rename and drag-and-drop move ride these chat commands (the terminal stays the source of
  // truth; both are confirm-gated + journaled as file_move like tidy). Phrases are narrow and
  // start with the verb so they can't drift into file_find/tidy shapes.
  'general.files.rename': {
    examples: [
      'rename notes.txt as diary.txt', 'rename report.pdf to final-report.pdf',
      'rename index.html to home.html', 'rename app.ts to main.ts',
      'rename the file to newname.txt',
      // "rename main.py to app.py" is deliberately NOT in the examples: its main.py token
      // pulled the intent within closeSecond of every other main.py-bearing input (probed
      // live: "good job on fixing main.py" gained a stray rename chip). The pre-semantic
      // override pins the shape anyway, and the matcher battery keeps it covered.
    ],
  },
  'general.files.move': {
    examples: [
      'move main.py into src', 'move report.pdf into documents',
      'move the file into archive', 'move app.ts into src/components',
      'move notes.txt into backups', 'move main.py into the folder src',
    ],
  },
};
