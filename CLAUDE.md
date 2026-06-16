# CLAUDE.md — study-engine 常設ルール

Claude Code が**出題・採点・SM-2・問題生成・知識育成**を担うための運用仕様。
このファイルは「エンジンの取扱説明書」兼「常設ルール」。日々のセッションは **Electron アプリ**が回し、Claude Code は**問題生成**と**深掘り(チャット)**を担当する。

## 0. 役割分担(設計の背骨)

| 層 | 担当 | 管轄 |
|---|---|---|
| 暗記エンジン | **study-engine**(このリポ。TS + Electron/React) | 出題・採点・SM-2 計算・読み上げ・記録・push |
| 問題生成 / 深掘り | **Claude Code(チャット)** | 一次情報からの問題生成、回答の深掘り、`learned/` 育成 |
| 第2の脳(平文ナレッジ) | **Obsidian 系(差し替え可)** | `learned/` を読む・繋ぐ・育てる |
| 版管理・保存 | **Git / GitHub** | すべてをテキストで保存 |

- 忘却曲線の管理は **エンジン(`src/engine/srs.ts`)に一本化**。Obsidian の Spaced Repetition プラグイン等は**使わない**(二重管理回避)。
- データは素の md / json。ビューアロックインなし。

## 1. リポジトリ構成

- `study-engine`(**public**)= 仕組み層。アプリ・エンジン・スキーマ・生成プロンプト。**個人データ/問題本体は置かない。**
- `study-log`(**private**)= 記録層。問題本体・回答ログ・SM-2 状態・`learned/`。**全部ここ。**

```
study-log/                       # private
  <domain-a>/<domain-b>/         # 例: aws/clf, english/core
    questions/  *.md             # 1問1ファイル(フロントマター + 本文)
    learned/    *.md             # 第2の脳
    logs/       reviews.jsonl    # 回答履歴(追記型)
  srs/state.json                 # 全問の SM-2 状態(ID基準・グローバル)
```

## 2. 問題ファイル仕様(1問1md)

`templates/question.md` と `schema/question.schema.json` が正本。

- フロントマター: `id`(必須・一意) / `domain` / `topic` / `type` / `grade_scale` / `source`(一次情報URL・必須) / `created` / 任意 `speak`。
- 本文セクション: `## Q`、(選択式のみ)`## Choices`、`## A`、`## Explanation`、(任意)`## Speak`。
- `type`: `single_choice | multi | cloze | translation | free`。
- **粒度は混在OK**。守るのは「各問に一意 ID」だけ(`state.json` が ID 基準で吸収)。AWS は `topic` でグルーピング(ファイル名 `s3-01.md`…)、英語は連番(`0001.md`…)。
- **設計判断**: 「1トピック複数問を1md」ではなく **1問1ファイル**に統一(パースが堅牢・差分が追いやすい・SRS は元々問単位)。トピックのまとまりは `topic` フィールドとファイル名で表現する。

### ID 規約
`<domain を - で繋ぐ>-<topic>-<NN>`(例 `aws-clf-s3-03`)または `<domain を - で繋ぐ>-<NNNN>`(例 `english-core-0001`)。
ドメイン → ID プレフィックスは `domain.replace('/','-') + '-'`。`pick` はこのプレフィックスではなく実ファイルを走査して state と突き合わせる。

## 3. 採点・忘却曲線

- **履歴(事実)**= `reviews.jsonl`(`{id, ts, grade, session}` を末尾追記)。
- **状態(計算結果)**= `srs/state.json`(`{interval, ease, due, reps, lapses, ...}`)。状態は履歴から再計算できる関係を保つ。
- **grade**: 1=Again / 2=Hard / 3=Good / 4=Easy。
- アルゴリズム = **SM-2 を 4 ボタンに適応**(`src/engine/srs.ts`、純関数 `review()`)。後で FSRS 等に差し替え可。
- single_choice/multi は正誤から**仮 grade を自動ハイライト**(正解→Good、誤り→Again)。最終判断はユーザー。cloze/translation/free は模範解答を見て自己評価。

## 4. セッションの流れ(アプリが実行)

1. アプリ起動(`pnpm dev`)。ダッシュボードで対象ドメインを選ぶ。
2. `pick`: `state.json` から `due <= 今日` を**復習優先**で抽出 + 新規を数問混ぜ計 10〜20 問。
3. 1 問ずつ出題 → 回答(クリック/テキスト)→「答え合わせ」で正解+解説 → **4 段階で自己評価**(1クリック)。
4. 英語問題で `speak` があれば**自動読み上げ**(`say`)。🔊 で再生。
5. 各回答ごとに `reviews.jsonl` 追記 + `state.json` 更新(クラッシュ耐性)。
6. セッション終了でサマリ(正答率・弱点トピック)→ **「コミット & プッシュ」で study-log に 1 コミット**。

> 一問一答で毎回完結はしない。**10〜20 問の塊 = 1 セッション = 1 コミット** が基本リズム。

## 5. 問題生成の方針(著作権配慮・重要)

**ネットから問題を「収集」しない。一次情報を根拠に「生成」してストックする(逐次生成)。**

- **AWS**: 公式ドキュメント+公開サンプルを**根拠**にオリジナル生成。丸写し禁止、出典URL併記。市販テキストは地図としてのみ。
- **英語**: 中学〜高校の確立範囲で文法・語彙・例文を生成。`## Speak` に読み上げ英文。
- **逐次生成**: まず各対象 20〜30 問で開始、足りなければトピックを足す。
- プロンプト雛形: `templates/gen_aws_prompt.md` / `gen_english_prompt.md` / `gen_domain_prompt.md`。

## 6. `learned/`(第2の脳)の運用

- 一定回数正解 or 本人が「腹落ち」した項目を、Claude が `learned/` に md 化して追記。
- ユーザーが Obsidian 等で開き、**自分の言葉で肉付け** + `[[wikilink]]` で関連付け。
- `learned/` は問題生成時の**参照元**にもなる(既習を踏まえた出題)。
- 昇格判断 = Claude の提案 + 本人の最終判断。コミットは Claude/アプリに一本化(Obsidian の自動コミット系は使わない)。

## 7. 深掘り(チャット連携)

アプリの「🤔 Claudeで深掘り」は、問題 ID・ファイルパス・ユーザーの回答を載せたプロンプトをクリップボードにコピーする。ユーザーがそれを Claude Code チャットに貼ったら、Claude は:

1. 該当 `questions/*.md` を読む。
2. 関連サービス/語法との違い・よくある誤解・試験/実運用での問われ方の観点で掘り下げる。
3. 腹落ちしたら `learned/` への追記案を出す(本人の言葉ベース、丸写ししない)。
4. 必要なら関連問題を追加生成して `questions/` に足す。

## 8. ドメイン追加手順(AWS・英語以外を増やす)

エンジンは**完全にドメイン汎用**。新しい学習対象はデータを置くだけで増える。

1. `study-log/<a>/<b>/{questions,learned,logs}` を作る(例 `aws/saa`, `chinese/hsk1`, `it/fe`)。
2. `templates/gen_domain_prompt.md` を使って 20〜30 問を**生成**(出典付き・丸写し禁止)。`templates/question.md` 形式で `questions/` に保存。ID は一意に。
3. `srs/state.json` に各 ID を `{"interval":0,"ease":2.5,"due":"<今日>","reps":0,"lapses":0}` で追加(全問 due=今日)。
4. 空の `logs/reviews.jsonl` を作る。
5. アプリを再読み込み → ダッシュボードに新ドメインが自動表示。
6. 言語学習なら `say` の声を対象言語に(設定の声: 中国語 Tingting、仏語 Thomas、独語 Anna 等)。`## Speak` に対象言語テキストを入れる。

> 既存の `aws/clf`・`english/core` がそのままお手本。最初は**小さく 1 セッション通す**ことを最優先。

## 9. 認証・コミット

- `gh` / SSH 認証済み前提。アプリの push は `git push`(study-log の origin = SSH)。
- public(study-engine)には認証情報・個人データ・問題本体を**一切含めない**。
- トークンを平文で持たない/直書きしない。

## 10. 開発コマンド / ファイルマップ

```
pnpm install     # 初回(Electron 本体を取得; .npmrc=node-linker=hoisted)
pnpm dev         # アプリ起動(日々の学習)
pnpm smoke       # エンジンの headless 検証(SM-2 + pick/record/summary)
pnpm typecheck   # 型チェック(node 側 + web 側)
pnpm build       # 本番ビルド(electron-vite)
pnpm dist        # .app 生成(electron-builder, dir)

src/engine/      # 純TSエンジン(electron非依存): types/srs/store/session
src/main/        # Electron main(fs/say/git IPC)
src/preload/     # contextBridge(window.api)
src/renderer/    # React UI
schema/ templates/   # 仕様・雛形
```

データの既定パス: `STUDY_LOG` env → 設定ファイル → `…/akira-toriyama/study-log`。無ければ起動時にフォルダ選択。
