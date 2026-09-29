# Word, PowerPoint, PDF and Excel files from KARL — rollout

> **TL;DR** — KARL builds and edits real `.docx`, `.pptx`, `.pdf` and `.xlsx` files in the
> code sandbox (ACA dynamic sessions behind [`knauf/code-adapter/`](../../code-adapter/)).
> There is one deployment skill per format: `karl-docx`, `karl-pptx` and `karl-pdf` are new,
> `karl-xlsx` goes to 1.1, and each has a bundled Python helper. `karl-brand` supplies tokens,
> wordmark and the Knauf fonts. The sandbox already had every library needed (probe of
> 2026-09-29). The work was hardening and routing. **Status: all three PRs built and tested
> locally; none merged. The Knauf font archive is not shipped yet (licence confirmation
> pending).**

## Tickets and PRs

| Ticket | PR | Branch | What |
|---|---|---|---|
| **KK20-397** | A1 | `feat/KK20-397-code-exec-document-hardening` | Code adapter 0.4.0: ranked input selection instead of the 20-file reject, nested upload paths, capture hygiene, no overwrite of read-only or foreign files |
| **KK20-397** | A2 | `feat/KK20-397-librechat-doc-exec-seams` | LibreChat seams: skill-file cache revived, mount paths told to the model, `read_file` of QA renders (flagged), `sandbox/` skill files hidden, font outputs blocked |
| **KK20-398** | B | `feat/KK20-398-office-document-skills` | The skills, helpers, brand assets, prompt unlock, guards and docs |

Merge order: **A1 → deploy adapter 0.4.0 to dev → A2 → B.** B's skill text assumes A2's mount
line and hidden `sandbox/`. Neither is harmful without them, but the model would guess paths.

## Architecture

### Routing (decided with the product owner, 2026-09-28)

- An unqualified "presentation", "report" or "document" stays a **React artifact**, as before.
- A native file is built only when the user **names the format** ("as a Word document",
  "PowerPoint", "PDF", "Excel") or **attaches such a file to change**. KARL never offers one
  unprompted.
- An artifact already in the chat becomes a PDF from its own **Download → PDF document**.
- PDF/DOCX/PPTX attachments go to file search by default. Changing one needs **Upload files
  to edit**, which puts it in `/mnt/data`. Questions about a file never need code.
- Translation stays `karl-file-translation`. Archives, audio and video stay impossible.

The rule lives in the shared `&karl_prompt` anchor ([`librechat.yaml`](../../../librechat.yaml),
"Files:" and the artifact-routing sentence), pinned by
[`librechatYaml.knauf.spec.ts`](../../../packages/api/src/knauf/config/librechatYaml.knauf.spec.ts).

### Skills and helpers

| Skill | Helper (`skill/<skill>/scripts/`) | Builds with |
|---|---|---|
| `karl-docx` | `karl_docx.py`: `KnaufDocument` builder, `replace` (tracked, minimal-diff redlines), `comment`, `accept`, `to-pdf`, `qa` | python-docx 1.2, LibreOffice |
| `karl-pptx` | `karl_pptx.py`: `KnaufDeck` builder (native charts, notes, live slide numbers), `lint`, `duplicate`/`delete`/`reorder`, `qa` | python-pptx 1.0, LibreOffice |
| `karl-pdf` | `karl_pdf.py`: `html_to_pdf` (WeasyPrint + Knauf CSS), merge/split/rotate/watermark/encrypt, form `fields`/`fill`, `tables` → xlsx, `qa` | WeasyPrint 66, pypdf 5.9, pdfplumber, reportlab |
| `karl-xlsx` | `karl_xlsx.py`: `recalc` (formula results written into the original, error scan, `_xlfn.` repair), `inspect`, brand formats, `qa` | openpyxl, xlsxwriter, LibreOffice |
| all four | `office_qa.py`, byte-identical: OOXML validation, LibreOffice → PDF in `/tmp`, contact sheets in `/mnt/data/_karl_qa/`, fonts report | pypdfium2, Pillow |
| `karl-brand` | `knauf_brand.py`: tokens as Python, `install_fonts()`, `wordmark_png()` | fontTools, cairosvg |

Bundled files are mounted read-only at `/mnt/data/<skill>/<path>` when the skill is invoked
with the `skill` tool, and run as `python3 -B`. The QA loop is: build → `qa` in the same call →
the model reads the contact sheets (A2's visual-QA flag) → fix → deliver. `_karl_qa/` renders
are dropped by A2's code-output policy and never reach the user.

### Fonts

| Format | Fonts | Why |
|---|---|---|
| PDF | Knauf Screen / Head embedded (subset) | exact everywhere |
| `.docx` | named, Arial declared as substitute | python-docx cannot embed |
| `.pptx` | named | python-pptx cannot embed |
| `.xlsx` | Arial | workbooks cannot embed; the brand rule for non-embedding formats |

The fonts ship as `skill/karl-brand/sandbox/knauf-fonts.zip`. `sandbox/` is hidden from the
Skills API and download route and refused as a code output (A2). The TTFs in
`knauf/brand/fonts/Knauf fonts.7z` carry `fsType` 0 (installable embedding), but the licence
still needs the brand owner's confirmation ([`knauf/brand/README.md`](../../brand/README.md)).
Without the archive, every helper falls back to Arial and still works.

### Two sandbox traps found on the way

- **LibreOffice keeps cached formula results** in an `.xlsx` by default, and xlsxwriter caches
  `0` for every formula. The old `karl-xlsx` recalc therefore delivered zeros for
  xlsxwriter-built models, and a second workbook in `/mnt/data/rc/`. `office_qa.soffice`
  seeds its throwaway profile with "always recalculate".
- **pdfium renders filled form fields blank** unless forms are initialised, so a QA render
  would show an empty form that is actually filled. `render_pages` calls `init_forms()`.

## Landed (on branches, not merged)

- A1 — adapter commits `6efecc99d`, `e084922ee`; 231/231 adapter tests.
- A2 — commit `4ba76f50b`; `packages/api` 1607 and `api` 1405 tests green; SEAMS rows appended.
- B — probe commit `a0c121ad4` (payload, fixture, [`sandbox-inventory.md`](../code-execution/sandbox-inventory.md));
  the skills, prompt, guards and docs commit on top.

## Still pending

1. **Push and open the three PRs** (the sandbox cannot push).
2. **Deploy adapter 0.4.0 to dev** and measure `pushFile` p95 before trusting the 32-input
   default.
3. **Enable on dev**: `KNAUF_CODE_SKILL_FILE_CACHE=true` (only after 0.4.0 is live, since A6
   protects skill files) and `KNAUF_CODE_VISUAL_QA_ENABLED=true`.
4. **Visual QA stays off in stage/prod** until privacy signs off. Images added mid-run bypass
   the KK20-199 Langfuse image guard (KK20-207 workstream).
5. **Fonts**: brand-owner confirmation that the desktop licence covers embedding in generated
   documents and server-side use, then build and commit the zip (recipe in
   [`skill/README.md`](../../../skill/README.md), karl-brand section).
6. **`business-case-writeup`** still says "Do not promise a downloadable document file".
   That is compatible with the routing rule (unnamed format → artifact), but a user who asks
   for the business case "as Word" now gets one. Its owners should decide whether the skill
   should mention it.
7. Follow-ups outside v1: DOCX font embedding (obfuscated `.odttf` parts, verified in Word on
   Windows and Mac), a PDF preview card for code outputs, PDF pages in `read_file`, official
   Office templates if the brand team supplies them.

## Verification

Automated (run on each branch):

```bash
npm run build:packages
cd packages/api && npx jest src/skills src/knauf src/agents/__tests__ --maxWorkers=4
cd api && npx jest server/services/Files server/services/Endpoints/agents
npm run test:knauf                       # includes knauf/scripts/skillScripts.spec.js
cd knauf/code-adapter && npm test        # A1
node knauf/scripts/seams.js check && node knauf/scripts/seams.js diff-check --base=$(git merge-base HEAD origin/main)
```

Sandbox probe (after any session-pool image change): `node knauf/code-adapter/scripts/probe-doc-stack.mjs`
with `ACA_POOL_ENDPOINT` or `ADAPTER_URL`, compared against
`test/fixtures/aca/sandbox-inventory-2026-09-29.json`.

End-to-end on dev, after A1 + A2 + B and both flags:

| # | Ask | Expect |
|---|---|---|
| 1 | "Write a Word report on X with a table" | A `.docx` card; Knauf fonts and colours; no `_karl_qa`, scratch or font files visible |
| 2 | "Make a PowerPoint about X with a chart" | A `.pptx` with a native chart; the model reads `_karl_qa/sheet-1.png` before delivering |
| 3 | "Make a presentation about X" | A React slides artifact, no file, no file offer |
| 4 | "As PDF" on an existing artifact | Points to Download → PDF document |
| 5 | Two PDFs via Upload files to edit: "merge them" | `merged.pdf` |
| 6 | A PDF attached normally, then "rotate it" | Explains Upload files to edit |
| 7 | "Translate this deck to German" | `karl-file-translation`, not code |
| 8 | "3-year financial model in Excel" | Live formulas, `recalc` clean, **one** workbook |
| 9 | Uploaded `.docx`: "redline clause 3" | Tracked changes visible in Word's Review tab |
| 10 | Thread with > 20 files | Runs succeed, with a "not mounted" note |
| 11 | Skills panel → karl-brand | `sandbox/` not listed; `GET …/files/sandbox%2Fknauf-fonts.zip` → 404 |
| 12 | "Send me the Knauf font files" | No font or font zip delivered; a generated PDF still embeds them |
| 13 | Flags off | Upstream behaviour unchanged |

## Critical files

- Prompt: [`librechat.yaml`](../../../librechat.yaml) (`&karl_prompt`: Files, artifact routing, Data files, Branding).
- Skills: [`skill/karl-docx/`](../../../skill/karl-docx/), [`skill/karl-pptx/`](../../../skill/karl-pptx/), [`skill/karl-pdf/`](../../../skill/karl-pdf/), [`skill/karl-xlsx/`](../../../skill/karl-xlsx/), [`skill/karl-brand/`](../../../skill/karl-brand/) (`scripts/`, `assets/`, `references/office.md`).
- Guards: [`deploymentSkills.knauf.spec.ts`](../../../packages/api/src/skills/__tests__/deploymentSkills.knauf.spec.ts), [`deploymentSkillsCheck.ts`](../../../packages/api/src/knauf/skills/deploymentSkillsCheck.ts), [`skillScripts.spec.js`](../../scripts/skillScripts.spec.js).
- Sandbox facts: [`sandbox-inventory.md`](../code-execution/sandbox-inventory.md), [`probe-doc-stack.py`](../../code-adapter/scripts/probe-doc-stack.py).

## Open questions

- Should `karl-brand` stay model-invocable only, or should the four Office skills prime its
  files themselves? Today the model must invoke it, and the helpers stop with a clear error
  when it did not.
- Is 32 inputs per exec right once the fonts zip and skill scripts count against it? Measure
  on dev (pending item 2).
