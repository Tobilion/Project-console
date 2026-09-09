// Shared WebSocket reply helpers (Phase B.2 consolidation, 2026-09-09): the identical
// `answer(ws, data)` one-liner and the trailing `end(ws)` marker were copy-pasted across a
// dozen wsHandlers leaves (builtinBackup/builtinClipboard/builtinCsvTools/builtinGeneralFiles/
// builtinNotes/builtinPdfTools/connectionHistoryAdmin used the exact answer sender; five
// connection*Admin files used the exact end sender). This is the single source of truth for
// the two most common reply shapes so a future protocol change edits one file, not twelve.
// Zero further imports — safe for any leader to reuse without pulling in the rest of the
// server graph (same contract as server/portProbe.js and server/atomicWrite.js).

export const answer = (ws, data) => ws.send(JSON.stringify({ type: 'answer', data }));

export const end = (ws) => ws.send(JSON.stringify({ type: 'end' }));

export const answerWithPanel = (ws, data, panelId) => ws.send(JSON.stringify({ type: 'answer', data, openPanel: panelId }));