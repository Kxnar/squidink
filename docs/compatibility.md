# Compatibility

## Tested environment

- Windows desktop, Obsidian **1.13.7** installed locally.
- Manifest requires **1.11.4+** because the public SecretStorage/SecretComponent methods used here were introduced there. The minimum version has not been run separately.
- Ink format and embed contracts checked against **0.5.6**, commit [`eba2b1200d9db1b64edb86d0ed6b90cfaa45f267`](https://github.com/daledesilva/obsidian_ink/tree/eba2b1200d9db1b64edb86d0ed6b90cfaa45f267). No dependency on Ink's live canvas, React components, atom stores, or private editor instances.

## Supported input

| Input | Behaviour |
| --- | --- |
| Standalone `![InkWriting](<path.svg>)` with optional Ink Edit link | Uses the saved SVG viewBox. |
| Standalone `![InkDrawing](<path.svg>)` plus Edit link with all four viewBox values | Uses that embed's viewport. Two views of one attachment remain distinct. |
| SVG containing `metadata ink-canvas` | Uses saved visual paths; removes only labelled `ink-type-writing-line` guides. |
| SVG containing `metadata tldraw` | Uses saved self-contained vector artwork. Unknown/unlabelled guides remain. |
| Spaces or URL-encoded characters in attachment paths | Decoded once, then resolved by Obsidian's link resolver. |
| CRLF or LF Markdown | Offsets and insertion preserve the note's line endings. |

Writing and drawing embeds inside lists, callouts, blockquotes, HTML blocks, fenced code, or indented code are outside the first beta's standalone-line parser. An embed line with other prose is not rewritten. SVG drawings without a complete explicit viewport require opening/saving the embed in Ink first.

## Rejected input

- Old `.writing` / `.drawing` JSON attachments and `handwritten-ink` / `handdrawn-ink` code blocks: use **Ink settings → migration options**.
- Broken attachment links; invalid, incomplete, zero-size, or non-finite viewports.
- Malformed XML, XML entities/DOCTYPE, scripts, event handlers, external resources, raster-image SVG elements, foreignObject HTML, or unsupported SVG tags. Resave with current Ink, or use a simpler source. Squid does not silently drop unsupported visible artwork.
- Empty recognition crops after known guide removal.
- SVG sources over 12 million characters or 50,000 visible XML elements.
- Recognition images above 4,096 pixels on either edge or 4,194,304 pixels in total. The overview may be smaller, but its **Send** action stays disabled until a readable crop is prepared.

The plugin transcribes the saved SVG, not unsaved strokes. Exit/save Ink editing before starting. A source save or viewport change during a request invalidates the session even if the old image remains visible in a review.

## Note history and movement

Applying uses one Obsidian editor transaction and prefers the active editor when the note has multiple open views. If the destination is closed, Squid opens it in editing mode and checks the pair again before writing.

On the tested Windows installation, Obsidian's file watcher can add an identical-content `set` history entry after a save. In that case the first Undo has no visible text change; the next Undo reverts the insertion. The smoke test permits this host-generated no-op and checks that the transcript is removed without changing surrounding text.

Complete pairs can move or survive note renames because IDs carry the association. Renaming the link does not by itself change the source-content revision. During an active session, moving the source embed or renaming its attachment can invalidate it; restart from the new location. Duplicate IDs, detached output, missing markers, and deleted sources are unresolved rather than guessed.

The integration contract is based on Ink's saved format, which may change. Recheck against a newer Ink release before claiming compatibility with it. Actual older user-authored tldraw notes still need the acceptance pass below.
