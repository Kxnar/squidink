# Acceptance status

Checked on **7 September 2026**. This is an implementation candidate, not a declaration that the handwriting beta has met its accuracy and time-saving threshold.

## Completed software verification

`npm run check`: TypeScript production build and **72 automated checks** pass.

| Case | Evidence |
| --- | --- |
| Different viewports over one SVG | Parser tests, rasterisation/frame checks, and actual Obsidian image comparison |
| Current and older SVG metadata | Synthetic format/visual tests; known guide removal preserves fraction bars |
| Missing/broken/legacy/unsupported inputs | Parser/SVG tests; empty and oversized gating exercised in Obsidian |
| Source edit while recognition runs | Real Obsidian vault modification invalidates the mocked request; no late insertion |
| Unrelated note edits while recognition runs | Real Obsidian insertion preserves a newly added heading and surrounding text |
| Manual corrections and regeneration | Unit guards and real Obsidian toggle/replacement checks |
| Transcript edits after review opened | Real Obsidian rejects replacement even when explicit replacement was enabled |
| Pair movement and note rename | Pure destination re-finding tests and an actual Obsidian note rename; user-vault movement remains on the manual checklist |
| Copies, duplicate IDs, deleted sources, missing markers | Unit tests across notes and within a note; selected-copy re-keying tests |
| Undo | Actual editor history reverts insertion, allowing a Windows file-watcher no-op history entry; surrounding text survives |
| Plugin disable/reload | Service disposal tests; actual persisted pair records survive plugin unload/reload |
| Auth failures, rate limits, malformed/refused/truncated output | Mocked provider contract tests; truncated output's returned usage is recorded |
| Cancelled/late output, single active request, cache identity | Lifecycle tests including a provider which resolves after cancellation |
| £10 guard and unknown charges | Reservation, reported-token pricing and unreconciled charge tests; no real spending |
| Benchmark integrity | 40/20 split validation, no source/crop leakage, no symbolic correction in formula normalisation, null for unmeasured metrics |

The installed app test ran against **Obsidian 1.13.7 on Windows** with original synthetic fixtures and an injected mock provider. It tests real public editor transactions, windows, settings controls, SVG-to-PNG rendering and MathJax. It does not measure OpenAI recognition, authenticate to the real API, or run Ink's own editor.

## Manual acceptance before calling the personal beta ready

- [ ] Run the full workflow with a real API key and confirm model access and billed usage for Sol and Luna.
- [ ] Write representative notes in Ink, save, preview and check all superscripts, roots, fraction bars, tiny notation and frame boundaries.
- [ ] Check a real older Ink-authored tldraw SVG; the generated older-format QA fixture is visual-only.
- [ ] Move, copy, rename and delete complete pairs in a disposable vault. Confirm duplicate-ID repair and broken-link handling before replacing anything.
- [ ] Open one note in multiple editor panes and check insertion/Undo in the active source view.
- [ ] Disable Squid during preparation, an API request, and review; confirm no stale transcript is inserted.
- [ ] Test reopening notes and Obsidian with your normal theme and other plugins.
- [ ] Populate **60 actual source sections**, split **40 development / 20 held-out** before making equation crops.
- [ ] Compare Sol and Luna on complete sections. Import a separately run TexTeller baseline for equation crops only.
- [ ] Independently assess symbol errors, omitted lines, altered reasoning and over-correction, including deliberately false equations.
- [ ] Record rendering success separately from transcription correctness.
- [ ] Record correction/review time and manually typed baseline time; demonstrate a net saving on held-out notes.
- [ ] Reconcile all retries, funding requirements, fees and usage within **£10 total paid evaluation spending**.

## Current recognition results

| Measure | Result |
| --- | --- |
| Real source sections supplied | 0 |
| Live OpenAI recognition requests in implementation/testing | 0 |
| Paid evaluation spend in this implementation session | £0 |
| Sol / Luna handwriting accuracy | Not measured |
| TexTeller equation-crop accuracy | Not measured |
| Correction-time benefit | Not measured |
| Real API latency and processing cost | Not measured |

Do not turn synthetic tests, mock latency or example token arithmetic into portfolio accuracy/performance claims. Fill the remaining measurements after collecting the user's handwriting.
