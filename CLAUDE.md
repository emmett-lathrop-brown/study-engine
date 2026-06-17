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
- データは素の **JSON**(問題・状態・履歴)+ 平文 md(`learned/` のみ)。ビューアロックインなし。問題は構造化が要るので 1 問 1 JSON、`learned/` は人が肉付けする散文なので md。

## 1. リポジトリ構成

- `study-engine`(**public**)= 仕組み層。アプリ・エンジン・スキーマ・生成プロンプト。**個人データ/問題本体は置かない。**
- `study-log`(**private**)= 記録層。問題本体・回答ログ・SM-2 状態・`learned/`。**全部ここ。**

```
study-log/                       # private
  subjects/<domain-a>/<domain-b>/  # 例: subjects/aws/clf, subjects/english/core
    questions/  *.json           # 1問1ファイル(構造化 JSON オブジェクト)
    learned/    *.md             # 第2の脳(人が肉付けする散文だけ md)
    logs/       reviews.jsonl    # 回答履歴(追記型 JSON Lines)
    chats/      <id>.json        # 問題ごとの Claude チャット履歴(アプリ内チャット。md書き出しに同梱)
    CONTEXT.md                   # Claude Code 用ドメイン文脈(問題生成の前に読む。§5)
  srs/state.json                 # 全問の SM-2 状態(ID基準・グローバル)
```

> ドメインデータは **`subjects/` 配下**に集約(`srs/` だけ root)。`domain` 文字列・ID・`state.json` のキーは `subjects/` を含まない(`aws/clf` のまま)。エンジンは `src/engine/store.ts` の `domainDir()`(=`<root>/subjects/<domain>`)経由で必ずアクセスし、`subjects/` を直書きしない。

## 2. 問題ファイル仕様(1問1JSON)

`templates/question.json` と `schema/question.schema.json` が正本。問題は構造化 JSON オブジェクト 1 個 = 1 ファイル(`questions/*.json`)。エンジンの読み取りは `src/engine/store.ts` の `parseQuestionJson`。

- 必須キー: `id`(一意) / `domain` / `topic` / `type` / `grade_scale` / `source`(一次情報URLの**配列**・必須) / `created`(`YYYY-MM-DD`) / `q`(問題文) / `answer` / `explanation`。
- `type`: `single_choice | multi | cloze | translation | free`。
- `choices`: **選択式(`single_choice`/`multi`)のときだけ**文字列配列(各要素は `"A. …"` の形)。それ以外は `null`。
- `answer`: `single_choice` は正解の記号(`"B"`)、`multi` は記号をカンマ連結(`"A,C"`)、`cloze`/`translation`/`free` は模範解答テキスト。
- 任意キー: `hint`(答えを言わない一言ヒント。`null` 可。未設定でもアプリが学習時に Claude へ即席ヒストを頼める) / `speak`(`say` で読み上げる対象言語テキスト。非言語問題は `null`) / `answer_ruby`(英語回答のカタカナルビ＝`[単語, カナ]` 対の配列。**サーフェス(各対の第1要素)を連結すると `answer` に完全一致**させる＝空白・句読点・日本語は読み `""` のトークンにする。英語を含む回答に付け、それ以外は `null`/省略。アプリが回答にふりがな(`<ruby>`)表示)。
- **粒度は混在OK**。守るのは「各問に一意 ID」だけ(`state.json` が ID 基準で吸収)。AWS は `topic` でグルーピング(ファイル名 `s3-01.json`…)、英語は連番(`0001.json`…)。
- **設計判断**: md フロントマター+本文ではなく **構造化 JSON 1 オブジェクト**に統一(パース自明・キー欠落をスキーマで検出・renderer が `import type` でそのまま扱える)。`learned/` だけは人が散文を育てるので md のまま。トピックのまとまりは `topic` フィールドとファイル名で表現する。

### ID 規約
`<domain を - で繋ぐ>-<topic>-<NN>`(例 `aws-clf-s3-03`)または `<domain を - で繋ぐ>-<NNNN>`(例 `english-core-0001`)。
ドメイン → ID プレフィックスは `domain.replace('/','-') + '-'`。`pick` はこのプレフィックスではなく実ファイル(`questions/*.json`)を走査して state と突き合わせる。

## 3. 採点・忘却曲線

- **履歴(事実)**= `reviews.jsonl`(`{id, ts, grade, session}` を末尾追記)。
- **状態(計算結果)**= `srs/state.json`(`{interval, ease, due, reps, lapses, ...}`)。状態は履歴から再計算できる関係を保つ(`state.json` は実質キャッシュ)。
- **rebuild-state**(`rebuildState()` / `pnpm rebuild-state`): `reviews.jsonl` を `review()` で再生して `state.json` を再計算する**安全網**。スケジューラ数値を変えたり FSRS に移行した後、履歴から状態を作り直せる。**ライブ記録分は fuzz 込みで完全再現**(`record()` が seed 用の日と ts を同一クロックで読むため `day === ts.slice(0,10)`)。`on` 上書き記録や手動注入した状態は再現対象外。`smoke` が「記録した状態 == reviews から再生した状態」を往復検証。
- **grade**: 1=Again / 2=Hard / 3=Good / 4=Easy。
- アルゴリズム = **SM-2 を 4 ボタンに適応**(`src/engine/srs.ts`、純関数 `review()`)。後で FSRS 等に差し替え可。
- single_choice/multi は正誤から**仮 grade を自動ハイライト**(正解→Good、誤り→Again)。最終判断はユーザー。cloze/translation/free は模範解答を見て自己評価。

## 4. セッションの流れ(アプリが実行)

1. アプリ起動(`pnpm dev`)。ダッシュボードで対象ドメインを選ぶ。
2. `pick`: `state.json` から `due <= 今日` を**復習優先**で抽出 + 新規を数問混ぜ計 10〜20 問。
3. 1 問ずつ出題 → 回答 →(`single_choice` は**選択肢クリック/A–Dキーで即フィードバック**=Quizlet流。`multi` は複数選んでから確定、記述は Cmd+Enter で「答え合わせ」)→ 正解+解説 → **4 段階で自己評価**(1〜4 キー or クリック)。
4. 学習中に **💡ヒント**(`hint` があれば即表示、無ければ Claude が答えを伏せて生成)/ **💬チャット**(右パネル。今の問題を文脈にマルチターン会話、問題 ID 単位で保存=§7)を任意で呼べる。
5. `speak` のある問題は 🔊 で読み上げ(`say`)。
6. 各回答ごとに `reviews.jsonl` 追記 + `state.json` 更新(クラッシュ耐性)。
7. セッション終了でサマリ(正答率・弱点トピック)→ **「コミット & プッシュ」で study-log に 1 コミット**。

> 一問一答で毎回完結はしない。**10〜20 問の塊 = 1 セッション = 1 コミット** が基本リズム。

## 5. 問題生成の方針(著作権配慮・重要)

**ネットから問題を「収集」しない。一次情報を根拠に「生成」してストックする(逐次生成)。**

- **各ドメインに `CONTEXT.md`(必須ルール)**: `subjects/<domain>/CONTEXT.md` に、そのドメインの範囲・レベル・出題スタイル・一次情報源・ID規約・**現在のカバレッジ(既存トピック)とギャップ**を書く。**問題生成の前に必ずこの CONTEXT.md を読む**(一貫した粒度・重複回避・出典方針のため)。`aws/clf`・`english/core` の既存 `CONTEXT.md` が見本。
- **生成の起点**: アプリ ダッシュボードの「📝 問題を作る」ボタンが、`CONTEXT.md` + スキーマ(§2)+ ID規約 + **既存ID/トピックのギャップ**を1つの生成プロンプトに同梱してクリップボードへ出す → それを **実 Claude Code(チャット)に貼って生成**(アプリ内チャットは sandboxed でファイルを書けない=§7)。生成された `questions/*.json` は人がレビューしてからコミット。
- **AWS**: 公式ドキュメント+公開サンプルを**根拠**にオリジナル生成。丸写し禁止、出典URL併記。市販テキストは地図としてのみ。
- **英語**: 中学〜高校の確立範囲で文法・語彙・例文を生成。`speak` に読み上げ英文、英語回答に `answer_ruby`。
- **逐次生成**: まず各対象 20〜30 問で開始、足りなければ CONTEXT.md のギャップに沿ってトピックを足す。
- プロンプト雛形: `templates/gen_aws_prompt.md` / `gen_english_prompt.md` / `gen_domain_prompt.md`(保存先は `study-log/subjects/<domain>/questions/`)。

## 6. `learned/`(第2の脳)の運用

- 一定回数正解 or 本人が「腹落ち」した項目を、Claude が `learned/` に md 化して追記。
- ユーザーが Obsidian 等で開き、**自分の言葉で肉付け** + `[[wikilink]]` で関連付け。
- `learned/` は問題生成時の**参照元**にもなる(既習を踏まえた出題)。
- 昇格判断 = Claude の提案 + 本人の最終判断。コミットは Claude/アプリに一本化(Obsidian の自動コミット系は使わない)。

## 7. ヒント・チャット(Claude 連携)

すべてアプリ内で完結。認証は既存の Claude Code ログイン共有(キーチェーン)で、アプリは API キーを保存しない。`claude` CLI を headless print モード(`-p --output-format json --max-turns 1`・`cwd` は temp・ツール無し=ファイル読み書きなし)で叩く(`src/main/index.ts` の `claudeAsk`)。

- **💡ヒント**(出題前): `hint` があれば即表示、無ければ Claude(haiku)が**答えを伏せた**ヒントを1つ生成。
- **💬チャット**(セッション右パネル, Claude(sonnet)): その問題を文脈に渡したマルチターン会話。理解の掘り下げ・つまずき相談に使う。会話は**問題 ID に紐づけて** `<domain>/chats/<id>.json` に保存され、開き直すと復元、md 書き出しにも同梱される(`ChatPanel` → `chat:get`/`chat:save` → `store.readChat`/`writeChat`)。会話継続は CLI の `--resume` ではなく**保存済み transcript を毎回文脈として送る**方式(再起動耐性・ログから再現可能)。

> アプリ内チャットは sandboxed(temp cwd・ツール無し)なので**ファイルは書けない**。`learned/`(第2の脳)を育てたいときは、別途 **Claude Code チャットを直接開いて** `questions/*.json` を読ませ、関連知識・誤解・問われ方を掘り下げ → `learned/` 追記案(本人の言葉ベース、丸写し禁止)→ 必要なら `questions/` に関連問題を追加、という運用。`learned/` を増やすのはこの経路のみ。

## 8. ドメイン追加手順(AWS・英語以外を増やす)

エンジンは**完全にドメイン汎用**。新しい学習対象はデータを置くだけで増える。

1. `study-log/subjects/<a>/<b>/{questions,learned,logs}` を作る(例 `subjects/aws/saa`, `subjects/chinese/hsk1`, `subjects/it/fe`)。
2. `subjects/<a>/<b>/CONTEXT.md` を作る(範囲・レベル・出題スタイル・一次情報源・ID規約・カバレッジ/ギャップ。§5。`aws/clf` の CONTEXT.md が見本)。
3. `templates/gen_domain_prompt.md` を使い、CONTEXT.md を読ませて 20〜30 問を**生成**(出典付き・丸写し禁止)。`templates/question.json` 形式の JSON で `questions/` に保存(1問1 `.json`)。ID は一意に。
4. `srs/state.json` に各 ID を `{"interval":0,"ease":2.5,"due":"<今日>","reps":0,"lapses":0}` で追加(全問 due=今日)。
5. 空の `logs/reviews.jsonl` を作る。
6. アプリを再読み込み → ダッシュボードに新ドメインが自動表示。
7. 言語学習なら `say` の声を対象言語に(設定の声: 中国語 Tingting、仏語 Thomas、独語 Anna 等)。`speak` に対象言語テキストを入れ、英語等は `answer_ruby` を付ける。

> 既存の `aws/clf`・`english/core` がそのままお手本。最初は**小さく 1 セッション通す**ことを最優先。

## 9. 認証・コミット

- `gh` / SSH 認証済み前提。アプリの push は `git push`(study-log の origin = SSH)。
- public(study-engine)には認証情報・個人データ・問題本体を**一切含めない**。
- トークンを平文で持たない/直書きしない。

## 10. 開発コマンド / ファイルマップ

```
pnpm install     # 初回(Electron 本体を取得; .npmrc=node-linker=hoisted)
pnpm dev         # アプリ起動(日々の学習)
pnpm smoke       # エンジンの headless 検証(SM-2 + pick/record/summary + rebuild-state 往復)
pnpm typecheck   # 型チェック(node 側 + web 側 + scripts/)
pnpm rebuild-state          # reviews.jsonl→state.json 再計算(既定 dry-run=差分表示のみ)
                            #   --write       適用(rebuilt を現状にマージ; 履歴の無い項目は保持)
                            #   --write --prune  適用(履歴由来の項目だけに置換)/ -v 全件表示
pnpm build       # 本番ビルド(electron-vite)
pnpm dist        # .app 生成(electron-builder, dir)

src/engine/      # 純TSエンジン(electron非依存): types/srs/store/session
src/main/        # Electron main(fs/say/git IPC)
src/preload/     # contextBridge(window.api)
src/renderer/    # React UI
schema/ templates/   # 仕様・雛形
```

データの既定パス: `STUDY_LOG` env → 設定ファイル(`settings.json` の `root`)→ 無ければ起動時にフォルダ選択(ハードコードされた既定パスは無し)。
