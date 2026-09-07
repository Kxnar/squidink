# Handwriting benchmark

Recognition has not been measured yet. The plan requires **60 real sections from the owner's mathematics notes**, with **40 development examples and 20 held-out examples**. Synthetic QA drawings must not be used to claim handwriting accuracy.

## Collect and freeze the dataset

```powershell
npm run benchmark -- init
```

This creates `benchmark/private/manifest.json` with 60 empty slots and image/reference folders. That directory is ignored by Git. No sample handwriting or reference answers are invented.

1. Select distinct source sections and assign the 40/20 split **before** creating crops. Keep all crops of one source on the same side of the split.
2. Include fractions, roots, indices, sums, integrals, Greek letters, quantifiers, matrices, cases, aligned derivations, proof prose, cramped notation, crossings-out and deliberately incorrect equations.
3. In Squid's image preview, use **Save prepared PNG**. Copy the resulting vault image to its manifest path. These are the exact inputs the plugin prepares; check their framing by eye.
4. Write independently checked reference Markdown/LaTeX at each reference path. Keep the author's mistakes. Use the same unresolved-content convention rather than inventing an answer.
5. Add meaningful `tags`. Add optional `equation-crop` rows for the TexTeller comparison with the same `sourceSectionId` and split as their parent. Whole sections and equation crops are scored separately.
6. Freeze the held-out references and model/prompt choices before running held-out evaluation.

```powershell
npm run benchmark -- validate benchmark/private/manifest.json
```

Validation requires all 60 sources and their files. A newly initialised manifest intentionally fails because its 120 image/reference assets are still missing. Validation makes no API calls.

## Optional paid runs

Live API credentials are read from a locally configured `OPENAI_API_KEY` environment variable. The plugin itself uses Obsidian SecretStorage; it does not read this environment variable.

Before running, check model access, current prices, actual billing conversion/tax/fees, account funding requirements, and all previous evaluation spending. The runner reserves at least US $0.50 per request and stops when there is insufficient room under **£10**. This guard is not a provider billing guarantee. Do not proceed if funding requirements alone exceed the available evaluation budget.

Example commands below use **planning inputs** of £1 per US dollar and £0 previous spending; replace both with your actual accounting. `--previous-spend-gbp` includes costs outside this runner, such as plugin trials and funding fees. Reuse the same output directory so both models share the ledger.

```powershell
npm run benchmark -- run benchmark/private/manifest.json --allow-paid --model gpt-5.6-sol --split development --gbp-per-usd 1 --previous-spend-gbp 0
npm run benchmark -- run benchmark/private/manifest.json --allow-paid --model gpt-5.6-luna --split development --gbp-per-usd 1 --previous-spend-gbp 0
```

Run held-out explicitly with `--split held-out` after finishing development. Previously completed identical example/model/image/prompt combinations are skipped. No automatic retry occurs. A failed request stops the run; check `ledger.json` and provider billing before any explicit retry. A pending/unknown charge blocks the next run until it is reconciled with a checked GBP amount (`state: "reconciled"`, `estimatedGBP: <checked amount>`). Do not delete a ledger to make the budget appear unused.

Each result is appended to `benchmark/results/results.jsonl`; charges are persisted separately in `ledger.json`. A lock prevents simultaneous runs against that output directory. After a crash, confirm no runner is active before removing a leftover `.run.lock`.

## Scoring and human review

For each result, independently annotate these optional fields in the JSONL record:

| Field | Meaning |
| --- | --- |
| `wrongSymbols` | Wrong or missing symbols counted against the handwriting/reference |
| `omittedLines` | Whole handwritten lines omitted |
| `alteredReasoningSteps` | Steps changed, added, reordered, solved or corrected by the model |
| `renderingSuccess` | Boolean from a separate Obsidian rendering check |
| `reviewSeconds` | Time to review and correct this result |
| `manualTypingSeconds` | Time to type the same section manually |

Counterbalance typing/review order across comparable examples to reduce familiarity effects. Report time distributions and unsuccessful examples, not just the fastest notes.

```powershell
npm run benchmark -- score benchmark/private/manifest.json benchmark/results/results.jsonl
```

The scorer writes `scores.json` with order-preserving exact formula matches after conservative formatting normalisation. It reports precision and recall so omitted and extra formulae are both visible. It does not simplify algebra or equate a plausible correction with the written expression. Human error counts, rendering checks and time measurements remain `null` until supplied; null is never interpreted as zero errors or success.

TexTeller execution is a separate optional local experiment. Import its records with `model: "texteller"` and `kind: "equation-crop"`, matching the source/split metadata. The scorer refuses to compare TexTeller records labelled as whole sections. Local runtime setup, GPU performance and TexTeller results are not included in the first plugin implementation.

Keep all raw handwriting, keys, transcripts and detailed results in the ignored private/results folders. Commit an aggregate, reviewed report only when ready to share it.
