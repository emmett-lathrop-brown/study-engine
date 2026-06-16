# 英語 問題 生成プロンプト雛形

> 使い方: `{TOPIC}` を文法/語彙トピック(例「現在完了(継続・経験・完了)」)に置き換え、Claude Code に渡す。
> 生成物は `study-log/english/<set>/questions/NNNN.md`(1 問 1 ファイル)に保存する。

あなたは中学〜高校レベルの英語教材を作る出題者です。
トピック: **{TOPIC}**

このトピックで **オリジナルの問題を 2〜3 問** 作ってください。要件:

- 範囲は中学〜高校の確立した文法・語彙(公開された一般的範囲)。市販問題集の複製は禁止、自作のこと。
- `type` は `translation`(和訳/英訳)、`cloze`(英文の空所 `___` を埋める)、`free`(短い自由英作文)を織り交ぜる。`single_choice` も可。
- `q` は「日本語の指示 + 対象の英文/和文」。`answer` は模範解答(自然な英語/和訳)。
- **`## Speak` に読み上げ用の英文(例文や解答の英文)を必ず入れる**(Mac の `say` で発音練習する)。日本語は入れない。
- `explanation` は文法ポイントを **自分の言葉で日本語で** 簡潔に。
- `source` には根拠となる **実在する安定した無料の参考 URL**(例 `dictionary.cambridge.org/grammar/…`、`learnenglish.britishcouncil.org`、`en.wikipedia.org` の文法ページ等)。
- 各問に一意 ID を振る(`english-<set>-NNNN`)。

生成後、各問を `## Q / ## A / ## Explanation / ## Speak` 形式の md にして保存する。
