# AGENTS.md

## Working Rules For This Repository

### RAG Regression Gate

This repository has an offline RAG non-regression suite that must be treated as a standard acceptance check for major retrieval changes.

Run this command after every major modification to RAG-related logic:

```powershell
node --env-file-if-exists=.env scripts/rag-eval.js
```

You can also use:

```powershell
npm run test:rag
```

Major modification means any change that affects one or more of the following:

- source routing between docs and tickets
- query-mode classification
- exact ticket lookup
- latest-ticket selection
- ticket-topic scoring or reranking
- prompt construction for RAG context
- ticket ingestion/chunking rules
- candidate generation or retrieval limits

### Expected Workflow

At the beginning of a new session, before changing RAG logic, read:

- `README.md` sections `Ticket Query Behavior` and `RAG Regression Testing`
- `scripts/rag-eval-cases.js`

After major RAG changes:

1. run `npm test`
2. run `npm run test:rag`
3. review failures before handoff

Do not claim a RAG change is complete if the regression suite was not run, unless the user explicitly asks to skip it or the environment prevents running it.

### What The Offline Suite Is For

`scripts/rag-eval.js` is an offline evaluation harness. It is not part of the live runtime path.

It exists to catch regressions in:

- docs vs tickets routing
- exact ticket-number retrieval
- latest related ticket resolution
- broad ticket-summary ranking
- report-topic retrieval such as DSR, monthend, CTP, billing, and corruption/root-cause prompts

The cases in `scripts/rag-eval-cases.js` are representative, not exhaustive. Treat the suite as a regression gate, not as proof that all prompts are correct.

### Failure Handling

If `npm run test:rag` fails after a major change:

- identify whether the failure is expected or a real regression
- fix the logic or update the test case only when the expected behavior has genuinely changed
- document any intentional expectation change in `README.md`

### Documentation Rule

If you change the RAG behavior materially, update `README.md` so the documented behavior stays aligned with the code.
