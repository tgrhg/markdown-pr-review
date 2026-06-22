# Master Design

## 1. System Goal

`Markdown Review Overlay` は、`GitHub` および `GitHub Enterprise` の Pull Request `Files changed` 画面において、Markdown の rich diff 上から直接レビューコメントを作成できる `Chrome Extension` である。

主目的は、Markdown をソース表示ではなくレンダリング済みの見た目のままレビューできることにある。

## 2. Non-Negotiable Constraints

- 外部サーバーへデータを送らない
- GitHub 以外の SaaS や API を利用しない
- ユーザーの既存ログインセッションを利用する
- `GitHub Enterprise` で動作できるよう、ホスト名を固定しない
- 参照元 `MIT` ライセンスの条件を守る

## 3. Primary Use Case

1. ユーザーが PR の `Files changed` を開く
2. Markdown ファイルを rich diff で表示する
3. ユーザーが段落や見出しなどのレンダリング済みブロックへホバーする
4. 拡張が `Comment` アクションを表示する
5. ユーザーがコメントを入力して投稿する
6. 拡張が現在の GitHub / GHE ホストへ same-origin リクエストでレビューコメントを送信する

## 4. Scope

### In Scope

- Markdown rich diff ブロックへのコメント導線
- 既存レビューコメントの inline 再描画
- ホストローカルな HUD による状態表示と手動 `Reload / Rescan`
- レンダリング済みブロックから diff 行番号へのマッピング
- same-origin の内部 API によるコメント投稿
- ライト / ダーク両対応のモダン UI

### Out of Scope

- 外部 DB や外部通知
- テレメトリや解析
- GitHub 以外のレビュー基盤対応
- 現時点でのスレッド一覧 UI や既存コメントの完全再構成

## 5. Architecture

構成はできるだけ小さく保つ。

- `manifest.json`
  `MV3` 設定、対象 URL、注入ファイル定義
- `content.js`
  PR 判定、diff 取得、行マッピング、UI 注入、コメント投稿
- `page-bridge.js`
  same-origin の GitHub / GHE 内部パスだけを許可する page context fetch bridge
- `background.js`
  allowlist 付き fallback fetch proxy
- `styles.css`
  注入 UI の見た目。hover button、thread card、composer、HUD を含む
- `popup.html`, `popup.css`
  拡張の説明、プライバシー方針、利用範囲の表示

## 6. Runtime Flow

### 6.1 Page Detection

- URL から `owner`, `repo`, `pull number` を抽出する
- `Files changed` 以外では何もしない
- GitHub 系ページらしさを meta tag や PR link で確認する
- SPA 遷移を考慮して URL 変化を監視する

### 6.2 Diff Acquisition

- `pull/<number>/changes` の route data を same-origin で取得する
- route data から diff summary と marker thread 情報を取得する
- 各 Markdown file の raw content を same-origin で取得する
- same-origin の `changes`, `page_data`, `blob` 取得は page context bridge 経由で行う
- page bridge は PR 文脈の current origin と allowlist path のみを許可する
- cross-origin が必要な場合のみ background service worker 側の allowlist proxy を使う
- route data の path digest と rich diff DOM を突き合わせる
- Markdown 拡張子のファイルのみを対象にする

### 6.3 Rendered Block Mapping

- rich diff DOM から commentable block を列挙する
- ブロックのレンダリング済みテキストを正規化する
- diff から作成した検索インデックスと前方一致的に照合する
- 照合位置から行番号を求める
- exact match と fallback match を区別して UI に出す

### 6.4 Review Comment Posting

- ページ内スクリプトやリンクから PR 比較用の commit OID を推定する
- 現在のホストの `page_data/create_review_comment` へ `fetch` する
- `credentials: include` により現在のログインセッションを使う
- reply / resolve / delete も同じ `page_data` 系 endpoint を same-origin で使う

### 6.5 Runtime Guidance UI

- 右上 HUD で host、route file 数、Markdown file 数、commentable block 数を表示する
- HUD に手動 `Reload / Rescan` を持たせ、Rich Diff 切り替え後に再読込できるようにする
- 既存レビューコメントは対象ブロック直下に thread card として挿入する
- composer 上で file と line を明示し、必要に応じて手修正できるようにする

## 7. Data Handling Policy

### Stored Data

- 現状、永続保存する独自データは持たない

### Network Data

- 送信先は現在の GitHub または GitHub Enterprise ホストのみ
- 送信内容はレビューコメント投稿に必要な情報のみ
- 外部ログ送信、クラッシュレポート送信、利用解析送信は行わない
- unified diff 取得も同じ host のみを利用する

## 8. GitHub Enterprise Strategy

- `window.location.origin` を送信先の起点にする
- `github.com` 固定の API URL を使わない
- URL パターンは PR ページを広めに拾い、実行時判定で GitHub 画面かどうかを絞る
- 拡張の host permission は広めに持つが、実際に動作する画面と通信先は PR 文脈の current host に限定する

## 9. UX Design Principles

- 読書体験を邪魔しない
- ホバー時だけ操作を見せる
- 投稿 UI は短時間で意図が分かる
- 「どのファイルの何行に投稿するか」を明確に見せる
- セキュリティ上の挙動を UI 上でも説明する

## 10. Known Risks

- GitHub 内部 API は非公開であり、将来的に変わる可能性がある
- rich diff DOM 構造が変わると block 検出がずれる可能性がある
- diff ベースのテキスト照合は複雑な markdown で誤差が出る可能性がある
- 差分 hunk 外の行は GitHub 側で reject される場合がある
- `raw file fallback` 利用時は hunk 情報が弱くなるため、行番号の手修正が必要になる可能性が上がる

## 11. Evolution Plan

次に拡張しやすい順で進める。

1. reply / resolve などのスレッド操作
2. file ごとのナビゲーション強化
3. host allowlist や enterprise 向け設定 UI
4. テスト追加と DOM 差分耐性の強化
5. GitHub DOM 変更への追従性改善

## 12. License and Attribution Policy

- このリポジトリ自体のライセンスは `MIT`
- 参照元 `rich-diff-comments` の `MIT` 表記は `THIRD_PARTY_NOTICES.md` に保持する
- 参照は設計思想と実装アプローチに対するものであり、本リポジトリは独立実装として維持する
