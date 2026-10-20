// CLI launcher environment (2026-10-20, hardening pass 2).
//
// This module exists purely for IMPORT ORDER. ESM evaluates every import of a module
// before the module body, so an assignment in bin/cli.js's body happens AFTER the whole
// server graph — including server/logger.js — has been evaluated. The logger picks its
// destination at module load, so setting CONSOLE_LOG_TO_STDERR in the launcher body was
// too late: the in-process server's log lines still landed on stdout, in the middle of
// the chat answer and in the middle of the --json stream.
//
// Importing this module FIRST makes the flag effective before the logger is evaluated.
process.env.CONSOLE_LOG_TO_STDERR = '1';
