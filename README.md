# Markdown Review Overlay

`Markdown Review Overlay` is a `Manifest V3` Chrome extension for reviewing Markdown in pull request rich diff views on `GitHub` and `GitHub Enterprise`.

It adds a modern inline comment action to rendered Markdown blocks on the PR `Files changed` tab and posts the review comment back to the current host using the browser's existing authenticated session.

## Documents

- `docs/sdd.md`: SDD の進め方と文書ルール
- `docs/design.md`: マスター設計書
- `docs/manual.md`: 利用者向けマニュアル

## Goals

- No external server calls
- No analytics or telemetry
- Works with GitHub Enterprise by using `location.origin`
- Keeps the interaction focused on Markdown rich diff

## Current scope

- Supports PR `Files changed` pages
- Supports Markdown-like file extensions: `.md`, `.markdown`, `.mdown`, `.mkdn`, `.mdx`
- Adds inline comment entry points to headings, paragraphs, list items, blockquotes, code blocks, and table rows
- Shows a lightweight host-local HUD with mapped-block and rich-diff status
- Shows per-file badges to indicate whether a Markdown file is ready for rendered commenting
- Maps rendered blocks back to diff lines by matching rendered text against the PR unified diff
- Posts comments through the current host's internal review-comment endpoint with same-origin authenticated requests

## Limitations

- This version focuses on creating comments; it does not yet render existing review threads inline
- If GitHub rejects a line outside the visible diff hunk, adjust the suggested line manually in the composer
- Matching is best-effort for complex HTML-heavy markdown or diagrams
- The extension intentionally does not send data to any third-party service

## Install

1. Open `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder
5. Open a PR `Files changed` page on GitHub or GitHub Enterprise
6. Switch a Markdown file to rich diff and hover a rendered block

## Files

- `manifest.json`: extension manifest
- `content.js`: PR detection, diff parsing, line mapping, and comment posting
- `styles.css`: injected modern UI styles
- `popup.html`, `popup.css`: compact extension info panel
- `docs/design.md`: master design document
- `docs/manual.md`: operator and user manual
- `THIRD_PARTY_NOTICES.md`: attribution for referenced MIT-licensed work

## Privacy

The extension only sends requests to the same GitHub or GitHub Enterprise origin currently open in the browser. It does not use external APIs, remote storage, analytics, or telemetry.

## License

This repository is released under the `MIT` license. See `LICENSE`.

The project design was informed by `chienyuanchang/rich-diff-comments`, which is also MIT licensed. See `THIRD_PARTY_NOTICES.md`.
