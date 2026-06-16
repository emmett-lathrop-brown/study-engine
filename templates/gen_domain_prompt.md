# 新ドメイン 汎用 生成プロンプト雛形

> AWS・英語以外の学習対象(例: 別のAWS認定 `aws/saa`、別言語 `chinese/hsk1`、資格 `it/fe` など)を増やすとき用。
> エンジンは完全にドメイン汎用。`<root>/<a>/<b>/questions/` を作ればダッシュボードに自動で出る。

あなたは「**{DOMAIN_TITLE}**」(domain id: `{DOMAIN}`)の学習問題を作る出題者です。
トピック: **{TOPIC}**

要件(共通方針):

- **収集ではなく生成**。一次情報(公式ドキュメント・確立した公開知識)を根拠に、丸写しせずオリジナルで作る。`source` に実在する安定URLを併記。
- `type` は対象に合うものを選ぶ: `single_choice`(知識確認)・`cloze`(用語/数値の暗記)・`translation`/`free`(言語学習)。
- `grade_scale` は基本 4(Again/Hard/Good/Easy)。
- 各問に **一意 ID**(`<domain-with-dashes>-<topic>-NN` または連番)。これさえ守れば粒度は混在してよい(state.json が ID 基準で吸収する)。
- 言語学習なら **`## Speak` に読み上げ用の対象言語テキスト**を入れる(`say` の声をその言語のものに設定: 中国語 Tingting、フランス語 Thomas 等)。
- `explanation` は学習者の言葉ベースで。

生成後、`templates/question.md` のスキーマで `study-log/{DOMAIN}/questions/` に保存し、`CLAUDE.md`「ドメイン追加手順」に沿って state を初期化する。
