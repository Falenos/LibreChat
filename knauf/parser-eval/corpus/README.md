# Corpus

Drop test documents into the category folders below. Files here are **gitignored**
(may be proprietary/large) — only the folder structure is tracked.

```
digital_pdf/    born-digital PDFs (text layer present)
scanned_pdf/    scanned / image-only PDFs (need OCR)
tables/         table-heavy documents
multicol/       multi-column / complex layout
office/         .docx / .xlsx / .pptx
ground_truth/   <stem>.md   reference markdown → enables CER/WER/TEDS for that doc
qa/             <stem>.yaml  Q&A pairs → enables Phase 2 RAG eval
```

`ground_truth/<stem>.md` and `qa/<stem>.yaml` are matched to a document by filename stem
(e.g. `tables/report.pdf` ↔ `ground_truth/report.md` ↔ `qa/report.yaml`).

`qa/<stem>.yaml` format:
```yaml
qa:
  - question: "What is the rated voltage?"
    answer: "5V"
  - question: "How many camera channels are supported?"
    answer: "4"
```
