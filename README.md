# markdown-pr-review

Markdown ファイルを PR で見やすくし、`GitHub` と `GitHub Enterprise` の rich diff 上からそのままレビューコメントできる `Manifest V3` Chrome Extension です。

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
- Renders existing review threads inline near the mapped rich diff block
- Maps rendered blocks back to diff lines by matching rendered text against the raw markdown source and route data
- Posts comments through the current host's internal review-comment endpoint with same-origin authenticated requests

## Limitations

- Matching is still best-effort for complex HTML-heavy markdown or diagrams
- If GitHub rejects a line outside the visible diff hunk, adjust the suggested line manually in the composer
- The extension intentionally does not send data to any third-party service

## Install

1. Open `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder
5. Open a PR `Files changed` page on GitHub or GitHub Enterprise
6. Switch a Markdown file to rich diff and use `Reload / Rescan` if needed

## Files

- `manifest.json`: extension manifest
- `content.js`: PR detection, route-data fetch, line mapping, thread rendering, and comment posting
- `page-bridge.js`: page-context same-origin fetch bridge
- `styles.css`: injected modern UI styles with light/dark support
- `popup.html`, `popup.css`: compact extension info panel
- `docs/design.md`: master design document
- `docs/manual.md`: operator and user manual
- `THIRD_PARTY_NOTICES.md`: attribution for referenced MIT-licensed work

## Privacy

The extension only sends requests to the same GitHub or GitHub Enterprise origin currently open in the browser. It does not use external APIs, remote storage, analytics, or telemetry.

## License

This repository is released under the `MIT` license. See `LICENSE`.

The project design was informed by `chienyuanchang/rich-diff-comments`, which is also MIT licensed. See `THIRD_PARTY_NOTICES.md`.
