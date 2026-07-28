import fs from 'fs';
import path from 'path';

/**
 * On non-Windows dev/sandbox environments where Tobi's real `Projects` directory
 * doesn't exist, seed a couple of fake projects so the console has something to show.
 * No-op on Windows or when the target path already exists.
 */
export function setupMockProjectsIfMissing(targetPath, dirname) {
  if (process.platform === 'win32' || fs.existsSync(targetPath)) return targetPath;

  const mockDir = path.join(dirname, '../mock_projects');
  if (fs.existsSync(mockDir)) return mockDir;

  fs.mkdirSync(mockDir, { recursive: true });

  const cuBetDir = path.join(mockDir, 'cu-bet-simulator');
  fs.mkdirSync(cuBetDir, { recursive: true });
  fs.writeFileSync(path.join(cuBetDir, 'console.config.json'), JSON.stringify({
    projectName: 'CU Bet Simulator',
    entries: [
      {
        triggers: ['start dev server', 'run dev'],
        type: 'command',
        action: "echo 'Starting Vite dev server...' && sleep 1 && echo 'Ready on http://localhost:5173'"
      },
      {
        triggers: ['run tests', 'test app'],
        type: 'command',
        action: "echo 'Running tests...' && sleep 1 && echo 'All tests passed!'"
      },
      {
        triggers: ['deploy to vercel', 'push live'],
        type: 'command',
        action: "echo 'Deploying to Vercel production...'",
        risky: true
      },
      {
        triggers: ['describe project', 'overview', 'what is cu bet'],
        type: 'answer',
        response: 'CU Bet is a football simulation & sportsbook web app with live odds, a custom bet builder, club ownership, and 14 casino mini-games.'
      },
      {
        triggers: ['explain more', 'architecture', 'odds engine'],
        type: 'answer',
        response: '### CU Bet Architecture:\n- **Frontend**: React 19 + TS + Vite + Tailwind v4 + Framer Motion.\n- **Odds Engine**: Located in `src/engine/odds.ts` using implied-probability calculations.\n- **Casino Mini-games**: 14 standalone games in `src/components/casino` driven by `src/engine/casinoLogic.ts`.'
      }
    ]
  }, null, 2));

  const dupDir = path.join(mockDir, 'duplicate-file-analyzer');
  fs.mkdirSync(dupDir, { recursive: true });
  fs.writeFileSync(path.join(dupDir, 'console.config.json'), JSON.stringify({
    projectName: 'Duplicate File Analyzer',
    entries: [
      {
        triggers: ['run analyzer', 'start python app', 'scan duplicates'],
        type: 'command',
        action: "echo 'Scanning directories for byte-level duplicates...' && sleep 1 && echo 'Found 0 duplicate files.'"
      },
      {
        triggers: ['run tests', 'pytest'],
        type: 'command',
        action: "echo 'Running pytest...' && sleep 1 && echo '5 passed in 0.42s'"
      },
      {
        triggers: ['describe project', 'overview', 'what is this'],
        type: 'answer',
        response: 'Duplicate File Analyzer is a Python desktop utility that scans directories, computes cryptographic hashes (MD5/SHA-256), flags identical files, and allows safe deduplication.'
      },
      {
        triggers: ['explain more', 'architecture', 'how it works', 'details'],
        type: 'answer',
        response: '### Duplicate File Analyzer Architecture:\n- **Core Engine**: `main.py` scans directories recursively, groups files by size to avoid redundant hashing, then computes SHA-256.\n- **Interface**: Built as a clean Python desktop/CLI utility using `hashlib`, `os`, and `pathlib`.\n- **Safety**: Generates a preview manifest before performing any file deletions or moves.'
      }
    ]
  }, null, 2));

  return mockDir;
}
