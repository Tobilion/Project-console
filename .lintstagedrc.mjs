// lint-staged config — one mapper: scripts/guard-staged.mjs decides which check-* batteries
// a staged file affects (see its header comment for the mapping). Running everything through
// the mapper keeps the rules in one place instead of duplicating them in .lintstagedrc globs.
export default {
  '*': ['node scripts/guard-staged.mjs'],
};