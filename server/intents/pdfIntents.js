// Phase 3 (UPGRADE-ROADMAP.md, 2026-08-11): PDF toolkit trigger intents — merge, split,
// extract text, extract pages, watermark. Every intent carries the `opensPanel: 'pdf-tools'`
// wire-contract tag (Phase 1.5): builtinPdfTools.js answers with the additive `openPanel`
// field when the input lacks parameters, so typing "merge pdfs" lands in the interactive
// panel; a fully-specified command ("merge a.pdf and b.pdf into c.pdf") executes in chat.
// Phrase shapes are verb+noun only (Phase 1.5 calibration lesson): "show me ..." shapes are
// corpus-collision bait, and "read ..." shapes belong to file_read. Not in
// WORKSPACE_DEV_ONLY_INTENTS — PDFs are a general-workspace capability by design.
export const PDF_INTENTS = {
  'pdf.merge': {
    opensPanel: 'pdf-tools',
    examples: [
      'merge these pdfs into combined.pdf', 'merge a.pdf and b.pdf into merged.pdf',
      'merge the pdf files into one file', 'merge my pdfs into merged.pdf',
      'combine these pdfs into combined.pdf', 'join these pdfs into joined.pdf',
      'merge all pdfs into all.pdf', 'merge pdfs', 'combine the pdfs',
    ],
  },
  'pdf.split': {
    opensPanel: 'pdf-tools',
    examples: [
      'split this pdf into one file per page', 'split report.pdf at page 5',
      'split the pdf at page 3', 'split my pdf into separate pages',
      'split the document into one file per page', 'split a pdf per page',
      'split this pdf into single pages',
    ],
  },
  'pdf.extract_text': {
    opensPanel: 'pdf-tools',
    examples: [
      'extract text from report.pdf', 'extract the text from this pdf',
      'extract text from the pdf', 'extract text from a pdf',
      'get the text from document.pdf', 'pull the text out of this pdf',
      'extract all text from the pdf',
    ],
  },
  'pdf.extract_pages': {
    opensPanel: 'pdf-tools',
    examples: [
      'extract pages 2-5 from report.pdf into excerpt.pdf',
      'extract pages 3 to 7 from this pdf', 'extract page 1 from the pdf into cover.pdf',
      'extract a range of pages from the pdf into range.pdf',
      'extract the middle pages from this pdf',
    ],
  },
  'pdf.watermark': {
    opensPanel: 'pdf-tools',
    examples: [
      'watermark report.pdf with confidential', 'watermark the pdf with draft',
      'watermark this pdf with private', 'watermark the document with internal',
      'add a watermark to this pdf', 'stamp this pdf with approved',
    ],
  },
};
