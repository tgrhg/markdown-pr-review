# Manual

## 1. What This Extension Does

この拡張は、PR の Markdown rich diff 上にレビューコメント用のボタンを出し、レンダリング済みの文書を読みながらその場でコメント投稿できるようにする。

## 2. Intended Environment

- `Google Chrome`
- `Microsoft Edge`
- その他 Chromium 系ブラウザ
- `GitHub.com`
- `GitHub Enterprise`

## 3. Install

1. ブラウザで拡張管理画面を開く
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. `Developer mode` を有効にする
3. `Load unpacked` を押す
4. このリポジトリのフォルダを選ぶ

## 4. How To Use

1. PR の `Files changed` を開く
2. Markdown ファイルを rich diff 表示にする
3. 段落、見出し、リスト、テーブル行、コードブロックなどへマウスを乗せる
4. 右上 HUD の `Reload / Rescan` で再読込できる
5. `+` ボタンを押す
6. 既存コメントがあれば thread card を開いて確認する
7. 必要なら行番号を調整する
8. コメント本文を書いて `Comment` を押す

## 5. What You Will See On Screen

- 右上に HUD が出る
  - 現在の host
  - route file 数
  - Markdown file 数
  - Rich Diff file 数
  - commentable block 数
- HUD には `Reload / Rescan` ボタンがある
- 既存レビューコメントは対象ブロック近くに thread card で表示される
- comment composer には file と line が表示される
- GitHub のライト / ダークテーマに追従する

## 6. Privacy Behavior

- 外部サーバーには送信しない
- 現在開いている GitHub または GitHub Enterprise のホストにだけ通信する
- 既存のログイン済みブラウザセッションを使う
- 独自のテレメトリや分析送信はしない
- 拡張 permission は host 全体に広く見えるが、実装上の通信は current PR host のみを使う

## 7. Enterprise Notes

- `github.com` 固定ではなく、現在の PR ホストへ送信する
- 社内 GHE で URL 形式が PR 標準に沿っていれば動作対象になる
- reverse proxy や独自 UI 変更が大きい場合は DOM 調整が必要になることがある

## 8. Limitations

- 現在はコメント投稿と既存スレッド表示を主対象にしている
- GitHub の diff hunk 外の行は投稿に失敗することがある
- 複雑な HTML ブロックや diagram では行推定がずれる場合がある
- line 推定がずれる場合は、投稿前に行番号を確認したほうがよい

## 9. Troubleshooting

### Comment button does not appear

- `Files changed` タブか確認する
- Markdown ファイルが rich diff 表示か確認する
- 対象ページが PR URL か確認する
- HUD の `Reload / Rescan` を押す
- 拡張を再読み込みしてページをハードリロードする

### Posting fails

- GitHub / GHE にログイン済みか確認する
- コメント対象行が diff 内にあるか確認する
- composer の行番号を近い changed line に調整して再送する
- Rich Diff 切り替え直後なら `Reload / Rescan` を押してから再送する

### Enterprise host works partially

- DOM 構造や URL が標準 GitHub から変わっていないか確認する
- ブラウザ console で `MRO` エラーを確認する

## 10. Recommended Operation

- まず社内の検証用 GHE リポジトリで試す
- コメント投稿が期待どおりの file / line に乗るか確認する
- 問題があれば `docs/design.md` の既知リスクと今後の拡張方針に沿って改善する
