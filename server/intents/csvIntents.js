// Phase 7 (UPGRADE-ROADMAP.md, 2026-08-12): deterministic CSV query intents — a small fixed
// grammar ("sum column X in Y", "average column X in Y", "filter Y where X <op> value",
// "count rows in Y where X <op> value"). All tagged `opensPanel: 'csv-tools'`. Read-only:
// no filter-to-file write variant exists yet (a future one must go through the standard
// confirm + action-history path, per the roadmap).
export const CSV_INTENTS = {
  'csv.sum': {
    opensPanel: 'csv-tools',
    examples: [
      'sum column sales in data.csv', 'sum the total column in expenses.csv',
      'add up the price column in products.csv',
    ],
  },
  'csv.average': {
    opensPanel: 'csv-tools',
    examples: [
      'average column price in data.csv', 'average the rating column in reviews.csv',
    ],
  },
  'csv.count': {
    opensPanel: 'csv-tools',
    examples: [
      'count rows in data.csv where status equals done', 'how many rows in sales.csv where region contains north',
    ],
  },
  'csv.filter': {
    opensPanel: 'csv-tools',
    examples: [
      'filter data.csv where price greater than 50', 'filter sales.csv where region equals west',
      'show rows in data.csv where status contains pending',
    ],
  },
};
