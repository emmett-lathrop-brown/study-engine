# AWS 問題 生成プロンプト雛形

> 使い方: `{TOPIC}` をトピック(例「Amazon S3 / 耐久性・ストレージクラス」)に置き換え、Claude Code に渡す。
> 生成物は `templates/question.json` のスキーマ(`schema/question.schema.json` が正本)に従い、**1 問 1 ファイルの JSON** として `study-log/aws/<exam>/questions/<topic>-NN.json` に保存する。

あなたは AWS 認定 クラウドプラクティショナー(CLF-C02)レベルの良問を作る出題者です。
トピック: **{TOPIC}**

このトピックで **オリジナルの問題を 2〜3 問** 作ってください。要件:

- 難易度は CLF(入門)相当。実務で迷いやすい・試験で問われやすい論点を突く。
- 主に `single_choice`(選択肢 3〜4 個、`answer` は正解の記号)。
- 数値やサービス名の暗記が肝のものは `cloze`(穴埋め、空所は `___`、`answer` に入る語句)を混ぜてよい。
- 問題文・選択肢・解説はすべて **日本語**。
- `explanation` は要点を **自分の言葉で**。AWS 公式文書の丸写しは禁止。**なぜ他の選択肢が誤りか**にも触れる。
- `source` には根拠となる **実在する安定した AWS 公式 URL**(`docs.aws.amazon.com` のユーザーガイド/FAQ、`aws.amazon.com` の製品/料金ページ等。深いアンカーで 404 しそうな URL は避ける)。
- 事実は最新時点で正確に。**確信が持てない数値は出さない**(必要なら Web 検索で裏取り)。
- 各問に一意 ID を振る(`aws-<exam>-<topic>-NN`)。
- 山下本などの市販テキストは**章立て・トピックの地図**としてのみ使い、問題文は自作する。市販問題集の複製は禁止。
- 任意で `hint`(答えを言わない一言ヒント)を付けてよい。不要なら `null`。

生成後、各問を `templates/question.json` の形(キー: `id` / `domain` / `topic` / `type` / `grade_scale` / `source`(配列) / `created` / `q` / `choices`(選択式のみ。それ以外は `null`) / `answer` / `explanation` / `hint` / `speak`(AWSは通常 `null`))の **JSON オブジェクト 1 ファイル**にして `.json` で保存する。
