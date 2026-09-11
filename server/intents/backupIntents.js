// Phase 9 (UPGRADE-ROADMAP.md, 2026-08-12): backup/zip intents — "backup this folder",
// "export this project as a zip", "list backups". Tagged `opensPanel: 'backup'`.
export const BACKUP_INTENTS = {
  'backup.create': {
    opensPanel: 'backup',
    examples: [
      'backup this folder', 'backup this project', 'backup the project', 'export this project as a zip',
      'make a backup of this folder', 'create a backup', 'zip this project',
    ],
  },
  'backup.list': {
    opensPanel: 'backup',
    examples: [
      'list backups', 'show my backups', 'what backups do i have',
    ],
  },
};
