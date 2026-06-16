# study-engine

**Claude Code と組む、忘却曲線(SM-2)ベースの学習アプリ。** AWS 認定・英語、そして任意の学習対象を、出題ラリー形式で続けられる。

- 暗記管理は **アプリ + Git** に一本化(Anki/外部SRS は使わない)。
- 問題は**収集せず生成**(一次情報を根拠に Claude Code が作る、出典URL併記)。
- データは全部**素の JSON**(問題・状態・履歴)+ md(`learned/` ノートのみ)。個人データは private な [`study-log`](https://github.com/akira-toriyama/study-log) に置き、このリポ(public)は**仕組みだけ**。

## スタック

**Electron + React + TypeScript**。エンジン(`src/engine`)は Electron 非依存の純 TS で、main process が `fs` / macOS `say` / `git push` を叩く。別サーバ不要。

```
┌─ study-log (private) ─ 問題json / reviews.jsonl / state.json / learned md
│        ▲ fs 読み書き
├─ src/engine   srs.ts(SM-2) + store.ts(JSON/状態IO) + session.ts(pick/record/summary)
├─ src/main     Electron main(IPC: session / grade / speak / git / claude / deepdive)
├─ src/preload  contextBridge → window.api
└─ src/renderer React UI(ダッシュボード → 出題 → 採点 → サマリ → push)
```

## セットアップ

```sh
pnpm install     # Electron 本体を取得(初回は時間がかかる)
pnpm dev         # アプリ起動
```

初回起動でデータフォルダ(`study-log`)を聞かれたら選択(または `STUDY_LOG` env で指定)。

## 使い方(1 セッション)

1. ダッシュボードでドメイン(`aws/clf` / `english/core` …)を選ぶ。
2. 復習(due)優先 + 新規数問で 10〜20 問が出る。
3. `single_choice` は**選択肢クリック / A–D キーで即フィードバック**(Quizlet流)、`multi` は複数選んで確定、記述は Cmd+Enter で答え合わせ → 解説を見て **Again/Hard/Good/Easy** を 1 クリック(キー 1〜4 も可)。
4. 学習中に **💡ヒント** / **🤔深掘り** を任意で呼べる(Claude CLI 連携・アプリ内表示)。
5. `speak` のある問題は 🔊 で読み上げ(`say`)。
6. 終了時にサマリ → **コミット & プッシュ**で study-log に 1 コミット。
7. さらに掘り下げて `learned/` を育てたい問題は **📋 Claude Codeへコピー** → プロンプトを Claude Code チャットに貼る。

## その他

- 学習対象の追加(AWS/英語以外): [`CLAUDE.md`](./CLAUDE.md) の「ドメイン追加手順」。
- アルゴリズムの差し替え(FSRS 等): `src/engine/srs.ts` の `review()` を置換。履歴から再計算できる設計。
- エンジン検証: `pnpm smoke`。型: `pnpm typecheck`。
- 💡ヒント / 🤔深掘りは **`claude` CLI**(既存の Claude Code ログイン)を共有して動く任意機能。未導入でも学習自体は動作する。ダッシュボードの「接続確認」で状態を確認。API キーはアプリに保存しない。
- 問題データの形式: 1 問 1 JSON([`schema/question.schema.json`](./schema/question.schema.json) / [`templates/question.json`](./templates/question.json) が正本)。

## トラブルシュート(Electron)

- 起動時に `Cannot read properties of undefined (reading 'whenReady')` → 環境変数 `ELECTRON_RUN_AS_NODE=1` が残っている(VSCode等のElectronホスト由来)。`dev`/`preview` スクリプトは自前で空にして回避済み。手動起動時は `env -u ELECTRON_RUN_AS_NODE ...`。
- `Library not loaded: Electron Framework` / `Electron failed to install correctly` → pnpm 環境で electron の展開が途中で止まり `dist/` がスタブ + `path.txt` 欠落になる既知事象。`postinstall`(`scripts/fix-electron.mjs`)がキャッシュ済み zip から再展開し `path.txt` を補完して自己修復する。直らなければ `pnpm rebuild electron`。

設計の詳細・常設ルールは [`CLAUDE.md`](./CLAUDE.md)。
