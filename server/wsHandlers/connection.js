/**
 * WebSocket connection layer — thin re-export shim since the Phase 11 modularization
 * (was 1274 lines before the split). The real implementation lives in the sibling
 * wsHandlers modules:
 *   - connectionLifecycle.js — heartbeat / initWebSocketServer / onConnection
 *   - connectionRoutes.js    — routeMessage message dispatch + sendAiStatus
 *   - connectionExecute.js   — handleExecute orchestrator (head + direct-command blocks)
 *   - connectionInterceptors.js / connectionTelemetry.js / connectionAdminCommands.js /
 *     connectionDevServer.js / connectionMatching.js — handleExecute's per-domain blocks
 *   - connectionConfirm.js   — handleConfirmResponse
 *   - connectionToolCall.js  — handleToolCall
 *   - connectionState.js     — shared pendingMemorySuggestions map
 * server/index.js imports { initWebSocketServer } from this module — keep that path stable.
 */
export { initWebSocketServer } from './connectionLifecycle.js';
export { DEV_URL_WHERE_RE, DEV_URL_WHAT_RE, DEV_URL_BARE_RE } from './connectionDevServer.js';
