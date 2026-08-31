# Anonymization & pseudonymization — where it belongs, and where it does not

> **TL;DR** — The question "should we anonymize?" has no single answer; it has one answer **per
> surface**, and the deciding variable is always the same: **does the purpose of this copy require
> identity?** Chat to the in-tenancy model: yes, it does — don't mask. The primary conversation
> store: yes — don't mask; bound it with retention instead. Private file uploads: yes — same.
> **Derived copies whose purpose does not need identity — memories about third parties, logs,
> traces, search replicas, reports — are where pseudonymization pays**, and a 2025 CJEU ruling
> quietly made it pay *more*. Shared agent knowledge files are the special case: the audience is
> wider than the uploader, so scan-and-flag before embed, with policy-driven masking for
> designated corpora.
>
> And one terminology correction that is itself a compliance requirement: almost nothing an LLM
> pipeline does is *anonymization* in the GDPR sense. It is **pseudonymization** — reversible,
> still personal data, still fully in GDPR scope. Calling it "anonymization" in a DPIA or a DPO
> conversation overstates the protection and creates exactly the false-confidence risk the
> KK20-207 assessment's risk register warns about.

Companion to [workstream.md](./workstream.md) (the executable plan — this doc is the design
rationale behind its Phases 3–4) and the KK20-207
[assessment](./pii-masking-and-anonymization.md) (whose §3 strategy this deepens). Drafted
2026-08-31.

---

## 1. Terminology decides the legal analysis

Three words that get used interchangeably and must not be:

| Term | GDPR meaning | Reversible? | Still personal data? |
|---|---|---|---|
| **Anonymization** | Recital 26: the subject is no longer identifiable by *any means reasonably likely to be used*, by anyone. Tested against **singling out, linkability, inference** (WP29 Opinion 05/2014) | No — irreversibly | **No** — out of GDPR scope entirely |
| **Pseudonymization** | Art. 4(5): attribution to a subject is impossible **without additional information kept separately** under technical/organisational protection | Yes — via the mapping | **Yes** (Recital 26) — a *safeguard* (Art. 25, 32(1)(a)), not an exit |
| **Masking / redaction** | Not a GDPR term; irreversible removal of specific values from one copy | No (for that copy) | The copy may still be personal data via what remains |

Three consequences that shape everything below:

1. **True anonymization of free text is practically unattainable.** A chat transcript with names
   replaced still supports singling out and inference ("the plant manager in Iphofen who raised
   the Q3 complaint"). Nothing in this document claims to anonymize conversations; the honest
   design space is *pseudonymization and minimization*.
2. **The mapping is the crown jewel.** [EDPB Guidelines 01/2025 on
   Pseudonymisation](https://www.edpb.europa.eu/system/files/2025-01/edpb_guidelines_202501_pseudonymisation_en.pdf)
   require the "additional information" (the placeholder↔identity map) to be held separately,
   access-controlled, and covered by its own technical and organisational measures. A
   pseudonymization system without a governed vault is just a renaming exercise.
3. **The CJEU made pseudonymization worth more — for recipients, not for us.** In
   [*EDPS v SRB* (C-413/23 P, 4 Sept 2025)](https://curia.europa.eu/site/upload/docs/application/pdf/2025-09/cp250107en.pdf)
   the Court adopted a **relative approach**: pseudonymized data transferred to a recipient who has
   no reasonable means of re-identification may not be personal data *for that recipient* — while
   remaining personal data for the controller holding the mapping. For Knauf this changes nothing
   about Knauf's own obligations (Knauf holds the map), but it creates a real, litigated payoff for
   pseudonymizing **derived copies read by people or systems that never get the map**: support
   views, reporting exports, engineering debug access. That is precisely the assessment's
   "debug/support doctrine", now with case law behind it.

---

## 2. The decision framework: purpose decides, per surface

The GDPR lever here is Art. 5(1)(c) — minimization means *no more data than the purpose needs*.
It does **not** mean degrading data the purpose genuinely needs. So the design question per copy
is: *what is this copy for, and does that purpose require real identity?*

| # | Surface | Purpose | Needs identity? | Correct treatment |
|---|---|---|---|---|
| 1 | **Chat message → model** (in-tenancy Azure OpenAI) | Do what the user asked ("draft the email to Frau Müller") | **Yes, inherently** | **No masking by default.** The hop is inside the Art. 28 controller→processor chain, EU Data Boundary, no-training terms. Block credentials (`messageFilter.pii`); everything else flows. Exception: Phase 4 designated flows (§5) |
| 2 | **Chat message at rest** (Mongo `messages`) | The product — users reread their own history | **Yes** | **No masking.** A history the user cannot read with real names is a broken product; a *reversibly* masked one adds a vault without removing GDPR scope. The correct controls are retention (Ph2), erasure, encryption, tenant isolation |
| 3 | **Private file uploads** (chat Q&A, pgvector) | Answer the uploader's questions about their own document | **Yes** | As-is + lifecycle. The uploader already possesses the original; masking the derived copy against its only reader protects nobody and breaks answers |
| 4 | **Shared agent knowledge files** (Azure AI Search / pgvector) | Answer *other people's* questions | **Sometimes** | **The genuine masking case** — see §4. Audience > uploader means upload is an internal disclosure and a purpose change |
| 5 | **Memory store** (`memory.value`) | Help *this user* in future chats | User: yes. **Third parties: no** | Pseudonymize third-party identifiers at write (Ph 3.3); the purpose is "remember the user's context", not "profile colleagues and customers" |
| 6 | **Logs / traces / search replica / reports** | Operations, debugging, analytics | **Almost never** | Minimize fields, redact patterns, pseudonymize identifiers, bound retention (Ph 0–2). Post-*SRB*, readers without the map may not even be processing personal data |

The pattern in one sentence — and it is the whole design:

> **Fidelity in the primary copy, minimization in every derived copy.**

This is also exactly the industry consensus for LLM observability (OTel GenAI: structure always,
payloads by decision) and the [EDPB LLM privacy report's](https://www.edpb.europa.eu/system/files/2025-04/ai-privacy-risks-and-mitigations-in-llms.pdf)
data-protection-by-design framing (April 2025): the named risks — leakage, memorisation,
unintentional profiling, re-identification — all live in the *secondary* flows, not in the
user-requested processing itself.

---

## 3. "Anonymize on send" — when inline masking of chat makes sense

The industry pattern is the **anonymize → infer → de-anonymize sandwich** (a gateway detects
entities, substitutes typed placeholders, calls the model, and re-substitutes in the response).
It exists to solve one specific problem: **an untrusted or out-of-DPA model hop** — a public SaaS
API, a third-country transfer, a model provider that trains on inputs.

KARL does not have that problem. The model is Azure OpenAI in Knauf's own tenancy under
Microsoft's DPA and the EU Data Boundary — legally the same category as Exchange Online. Masking
this hop by default would:

- destroy the assistant's core jobs (names, customers, projects *are* the work);
- push users to public ChatGPT — a strictly worse privacy outcome;
- add a detection layer whose *misses* become the new compliance story (NER never reaches 100%,
  and German recall is the weak spot — assessment §7.1);
- degrade output quality in German specifically: placeholders erase gender and title, and German
  grammar (articles, declensions, `Frau/Herr` agreement) visibly breaks around `<PERSON_1>`.

**When it does make sense — the three legitimate triggers:**

1. **The hop leaves the DPA boundary.** If KARL ever adds a non-Azure model provider, the §3.1
   "least risky hop" argument does not transfer (assessment §12.2 already flags this), and
   inline pseudonymization at that provider's adapter becomes the *right* control.
2. **A designated high-risk flow** where policy says specific identifier classes must not reach
   even the in-tenancy model — an HR-casework or works-council agent. This is Phase 4, gated on
   a named flow *and* a written product decision (gate G4).
3. **Credential-shaped content** — which is blocking, not masking (`messageFilter.pii`, Ph 0),
   because the correct response to a pasted API key is refusal, not substitution.

---

## 4. Documents and agent knowledge files

### 4.1 Private uploads: don't mask

Row 3 of the table. One addition worth writing down: **embeddings are not a mask.** Vector
embeddings preserve the semantics of the source text; a nearest-neighbour query for a known
identifier retrieves the records that mention it. Storing "only vectors" is not de-identification
— the EDPB LLM report and current RAG-security practice both treat embeddings of personal data as
personal data.

### 4.2 Shared knowledge files: the real case, in three escalating modes

The moment a file is attached to a **shared** agent, its content becomes retrievable by every user
of that agent. That is an internal disclosure the uploader may not have thought through (the HR
spreadsheet attached to a team agent). Purpose limitation (Art. 5(1)(b)) and minimization both
bite here — and this is the one ingest flow where pre-embed processing has clear ROI (Ph 3.2).

| Mode | What happens | When |
|---|---|---|
| **A · Scan & flag** *(default)* | Detect PII classes pre-embed; warn the owner, require confirmation, record the acknowledgment; block only on hard classes (national IDs, IBANs, health terms) | Every shared-agent ingest. Zero utility loss, catches the accidental upload, produces an audit trail |
| **B · Selective masking** | Redact designated high-risk classes; keep business-relevant names | Corpora where policy demands it (per-agent setting), decided by the owner + DPO rules |
| **C · Entity-consistent pseudonymization** | Every entity replaced by a stable typed token (`PERSON_007`) across the whole corpus | Regulated corpora only. Heavy machinery — see §5 for what it drags in |

Two implementation invariants, both learned from RAG-privacy failures in the field:

- **Mask before embed, never after.** The vector must be computed from the *masked* text. Masking
  the stored chunk while the embedding was computed on raw text leaves the identity retrievable by
  similarity search; the reverse leaves citations showing text the vector does not represent.
- **Deterministic per entity per corpus.** The same person must map to the same token in every
  chunk, or multi-chunk retrieval loses coreference and answers degrade. (Presidio supports
  deterministic and reversible operators, including AES-based encrypt/decrypt, for exactly this.)

### 4.3 KARL-specific note

There are **two** ingest chokepoints now (`VectorDB/crud.js:207` sync;
`Files/knauf/generationRagClient.js` async worker) and **two** vector sinks (pgvector, Azure AI
Search). Whatever mode ships must sit in both paths or it is theatre — this is already Ph 3.2's
acceptance criterion.

---

## 5. The round-trip question: "does it map back to the original names?"

The user-visible question: *if knowledge files are pseudonymized, can someone still ask "what did
Frau Müller order?" and get an answer with her real name?*

**Yes — but only by building genuine machinery, and every piece of it has a cost.** This is the
sandwich pattern extended to RAG, and it is where most designs quietly fall over:

1. **The mapping must be shared between query and corpus.** The corpus was masked at ingest with
   corpus-scoped tokens. The user's question arrives later and mentions "Frau Müller" in the
   clear. For retrieval to work, the query must be masked *under the same mapping* before
   embedding — which means the pseudonymization function must be **global, deterministic, and
   keyed** (an HMAC-style token per entity), not per-session random. A session-random `<PERSON_1>`
   in the query will never match the corpus's `PERSON_007`.
2. **That mapping is now the most sensitive store in the platform.** A single table linking every
   placeholder to every real name, queryable in both directions. EDPB 01/2025's separation and
   access-control requirements apply to it in full; it needs its own retention, its own erasure
   leg (Art. 17 must cascade *into the vault*), and its own entry in the Art. 30 record. You have
   not removed personal data from the system; you have concentrated it.
3. **Re-hydration happens only at the authorized boundary.** The reverse substitution runs after
   the model responds, for the entitled viewer, on the final channel — never inside logs, traces,
   or stored copies (or the pseudonymization of every upstream store silently unravels).
4. **Streaming breaks it.** KARL streams token-by-token; a placeholder can split across SSE chunks
   (`<PERS` … `ON_007>`), so naive re-hydration corrupts output. The options are buffering (losing
   streaming), stateful cross-chunk scanning (fragile), or not re-hydrating streamed output. This
   is the same §5.2 constraint the assessment documented for masking, mirrored.
5. **Multi-turn coherence forces vault growth.** The mapping must persist across the conversation
   (or the model sees the same person under different tokens across turns), so the vault
   accumulates per-conversation identity maps — each one personal data with a lifecycle.

**Consequence for KARL:** the full round-trip belongs only in **Phase 4** (a designated flow,
input-side, non-streamed or buffer-tolerant), and even there mode A/B from §4.2 should be
exhausted first. It is genuinely how the commercial tools work (Private AI, Skyflow's detokenize-
on-response, the "PII Shield" reference design) — but those tools exist to protect *untrusted
model hops*, which KARL does not have. Building the vault to protect an in-tenancy hop covered by
a DPA inverts the risk: it adds the platform's most attractive attack target to mitigate its
least risky data flow.

For **memory** (Ph 3.3) the round-trip is cheap and worth it, because the scope is tiny: the
memory value is read back *to the same user it belongs to*, so the mapping is per-user, small, and
never crosses a trust boundary. Pseudonymize third-party names in `memory.value` at write via
`setMemory()`; resolve them at read for that user only.

---

## 6. EU compliance summary for this design

| Instrument | What it says for this design |
|---|---|
| **GDPR Art. 5(1)(c), 25** | Minimization is judged against purpose — it compels minimizing *derived copies*, not degrading the primary function. Fidelity-primary/minimized-derived is a defensible Art. 25 architecture |
| **GDPR Art. 4(5) + Recital 26** | Everything reversible here is pseudonymization; it stays in scope. Never write "anonymized" in a DPIA for placeholder substitution |
| **[EDPB Guidelines 01/2025](https://www.edpb.europa.eu/system/files/2025-01/edpb_guidelines_202501_pseudonymisation_en.pdf)** | The mapping/vault needs separation, access control, and its own TOMs; pseudonymization is an Art. 32 measure and can support Art. 6(4) compatibility — but exempts nothing |
| **[CJEU *EDPS v SRB*, C-413/23 P](https://curia.europa.eu/site/upload/docs/application/pdf/2025-09/cp250107en.pdf)** | Relative approach: recipients without reasonable means of re-identification may fall outside "personal data" for that copy. Strengthens the case for pseudonymized support/reporting/debug views; changes nothing for Knauf-held stores |
| **[EDPB LLM privacy report (Apr 2025)](https://www.edpb.europa.eu/system/files/2025-04/ai-privacy-risks-and-mitigations-in-llms.pdf)** | Risk methodology for LLM systems; names leakage, memorisation, unintentional profiling, re-identification — all mitigated by the derived-copy controls (Ph 0–2), none by inline masking of the primary flow |
| **WP29 Opinion 05/2014 (WP216)** | The three anonymization tests (singling out, linkability, inference) — the reason this doc never claims anonymization of free text |

---

## 7. Design rules (extend the assessment's R1–R11)

- **A1 — Purpose decides per copy.** Fidelity in the primary store; minimization/pseudonymization
  in every derived copy. No blanket "anonymize everything" and no blanket "we're in-tenancy so
  nothing needed".
- **A2 — Never call reversible masking "anonymization"** in any document, ticket, DPIA, or UI
  string. Pseudonymization, always, with the vault named as personal data.
- **A3 — No inline masking of the in-tenancy model hop by default.** Triggers that reopen the
  question: a non-Azure provider, a G4-designated flow, credential-shaped content (block).
- **A4 — Shared-agent ingest: scan & flag is the floor** (mode A); masking modes are per-corpus
  policy. Mask before embed; deterministic per entity; both chokepoints, both sinks.
- **A5 — Any vault is a first-class PII store**: separated, access-controlled, retained,
  erasable (Art. 17 cascades into it), listed in the Art. 30 record — per EDPB 01/2025.
- **A6 — Re-hydration only at the authorized boundary**, never into logs/traces/stores, and never
  on live token streams.
- **A7 — Memory pseudonymization is the cheap round-trip** (per-user scope) — do it at
  `setMemory()`; do not generalize its vault to cross-user use.
- **A8 — Embeddings of personal data are personal data.** Vector stores inherit every obligation
  of the text they were computed from.

---

## 8. What this changes in the workstream

Nothing structural — this analysis *confirms* the phase ordering and sharpens three tickets:

- **P3-2 (RAG ingest):** default is mode A (scan & flag with owner acknowledgment); masking modes
  B/C are per-corpus policy switches, and mode C requires the §5 vault machinery — cost it
  honestly before choosing it.
- **P3-3 (memory pseudonymization):** scope the mapping per-user; re-hydrate at read for the
  owning user only (A7).
- **P4 (inline masking):** the design doc for gate G4 must answer §5's five costs explicitly —
  shared mapping, vault governance, boundary-only re-hydration, streaming, multi-turn growth —
  before any implementation ticket is cut.
