# アクションの棚卸し（P0）

対象: `server/src/actions.ts`（5,736行）。2026-11-28 時点の `dev/two-tier`（`14f5907` 以降 Space 版のコードは未変更）。

計画書 `docs/plan.md` の P0 の完了条件（全アクションに分類が付いている／推論API・`ctx.agent`・`fetchPageText` の使用箇所が漏れなく列挙されている）に対応する。以降のフェーズはこの一覧を前提にする。

**アクションは 48 個**。計画書の「47個のアクション」は1件少ない（`grep -c '^  \w*: defineAction({' server/src/actions.ts` → 48）。

## 分類の定義

| 分類 | 定義 | 件数 |
| --- | --- | --- |
| 書き込み | 利用者の意思でデータを変える。ちゃんと版では**イベントとして投函**する | 16 |
| 読み取り | データを返すだけ。ちゃんと版では**スマホが公開する閲覧ビュー**から返す | 17 |
| AI処理 | 推論API・`ctx.agent`・Web取得のいずれかを使う。ちゃんと版では**アプリから外してエージェント側**でやる | 7 |
| 内部用 | 利用者が直接呼ばない。初期投入（3）、バックグラウンドタスクからのコールバック（4）、運用の観測（1） | 8 |

読み取りに分類したもののうち4件は、**読み取りなのに書き込みの副作用がある**（期限切れ処理・メトリクス）。表の「副作用」欄で明示した。

## 一覧

ホスト依存の記号: `db`=`ctx.db`、`推論`=推論API、`agent`=`ctx.agent.spawnTask`、`page`=`fetchPageText`（特権）、`search`=`ctx.tool.web_search`、`inv`=`ctx.invalidateQueries`。
テーブルの記号: `M`=公開マスタ、`P`=個人データ、`O`=運用（後述の「テーブルの分類」参照）。

### 書き込み（16）

| アクション | 行 | 読むテーブル | 書くテーブル | ホスト依存 | 備考 |
| --- | --- | --- | --- | --- | --- |
| `upsertFood` | 2686 | — | `foods`(M) | db, inv | 食品マスタの新規・更新。ラベル写真／AI調査の結果を利用者が確認して登録する出口 |
| `deleteFood` | 2743 | — | `foods`(M) | db, inv | 過去ログのスナップショットは不変 |
| `saveBlendFood` | 2823 | `foods`(M) | `foods`(M) | db, inv | 配合食品。部品×グラムからサーバが再計算して100g換算で登録 |
| `deleteResearch` | 3739 | — | `food_research`(O) | db, inv | 調査記録の削除。次回は再検索になる |
| `saveRecipe` | 4138 | `foods`(M) | `recipes`(M) | db, inv | 丸ごと置き換え。`food` 行はマスタから再計算 |
| `deleteRecipe` | 4204 | — | `recipes`(M) | db, inv | |
| `logRecipe` | 4223 | `recipes`(M) | `meal_logs`(P) | db, inv | 1食分の栄養値×食べた量をスナップショット。`use_count` は更新しない（`logMeal` との非対称） |
| `logMeal` | 5014 | `foods`(M) | `meal_logs`(P), `foods`(M) | db, inv | **`foods.use_count`／`last_used_at` を更新**（5070行） |
| `logAssistParts` | 5077 | `foods`(M) | `meal_logs`(P), `foods`(M) | db, inv | 分解モードの部品を1行の記録に。**`use_count` 更新**（5209行）。マスタには足さない |
| `deleteMealLog` | 5217 | — | `meal_logs`(P) | db, inv | 現状は物理削除。ちゃんと版では取り消しイベントになる |
| `setMealLogEatingOut` | 5235 | — | `meal_logs`(P) | db, inv | 外食フラグのみ。栄養値は触らない |
| `updateSettings` | 5346 | `settings`(P), `target_history`(P) | `settings`(P), `target_history`(P) | db, inv | 目標値の変更時に当日付の履歴行を追記する |
| `upsertTargetHistory` | 5402 | `target_history`(P) | `target_history`(P), `settings`(P) | db, inv | 書き換え後に最新行から現在値を再導出 |
| `deleteTargetHistory` | 5462 | `target_history`(P) | `target_history`(P), `settings`(P) | db, inv | 同 |
| `saveConsumptionGroup` | 5675 | `foods`(M) | `consumption_groups`(P) | db, inv | 所属だけ保存。数値は読み取り時計算 |
| `deleteConsumptionGroup` | 5722 | — | `consumption_groups`(P) | db, inv | |

### 読み取り（17）

| アクション | 行 | 読むテーブル | 副作用 | ホスト依存 | 備考 |
| --- | --- | --- | --- | --- | --- |
| `listFoods` | 2500 | `foods`(M) | — | db | 約2,500件の検索口。**`use_count`／`last_used_at` の降順**（2514行） |
| `getFoodsByIds` | 2539 | `foods`(M) | — | db | id 解決用 |
| `listResearch` | 3723 | `food_research`(O) | — | db | |
| `getDeepFoodResearch` | 3801 | `food_research_jobs`(O), `food_research`(O) | `food_research_jobs` 更新, `ai_metrics` | db, inv | 6分無応答の pending を failed に落とす（`expireStaleDeepJobs`, 850行） |
| `listDeepFoodResearchJobs` | 3820 | `food_research_jobs`(O), `food_research`(O) | 同上 | db, inv | |
| `listUnregisteredResearchDrafts` | 3849 | `food_research`(O), `food_research_jobs`(O), `foods`(M) | 同上 | db, inv | 未登録の調査結果をアプリ全体に出す |
| `listRecipes` | 4122 | `recipes`(M), `foods`(M) | — | db | |
| `getRecipeImport` | 4564 | `recipe_imports`(O) | `recipe_imports` 更新, `ai_metrics` | db, inv | 6分無応答の pending を failed に落とす（`expireStaleRecipeImport`, 2286行） |
| `listMealLogs` | 5257 | `meal_logs`(P) | — | db | |
| `getDailySummary` | 5268 | `meal_logs`(P) | — | db | 体組成ダッシュボードとスキルの連携面。クライアントからは呼ばれない |
| `getDailySummaries` | 5280 | `meal_logs`(P) | — | db | 最大366日 |
| `getSettings` | 5317 | `settings`(P) | — | db | |
| `listTargetHistory` | 5387 | `target_history`(P) | — | db | ダッシュボードの同期面 |
| `getConsumptionStats` | 5541 | `meal_logs`(P), `recipes`(M), `foods`(M) | — | db | 消費ペース。読み取り時に全部計算 |
| `listUsedFoods` | 5555 | `foods`(M) | — | db | **`use_count > 0`** で絞る（5567行） |
| `suggestRelatedFoods` | 5578 | `foods`(M) | — | db | 栄養プロファイルのコサイン類似＋名前の類似。同点時は `use_count` 順（5646行） |
| `listConsumptionGroups` | 5658 | `consumption_groups`(P), `foods`(M) | — | db | |

### AI処理（7）

| アクション | 行 | 読むテーブル | 書くテーブル | ホスト依存 | ちゃんと版での扱い |
| --- | --- | --- | --- | --- | --- |
| `parseBlendText` | 2762 | `foods`(M) | `ai_metrics`(O) | db, 推論 | 配合テキストの読み取り。エージェント側へ。登録は `saveBlendFood` のまま |
| `parseLabelImage` | 2962 | — | `ai_metrics`(O) | 推論（画像） | 成分表示写真。エージェント側へ。結果は `upsertFood` で受け取る |
| `lookupFoodInfo` | 3060 | `foods`(M), `food_research`(O), `food_research_jobs`(O) | `food_research`(O), `food_research_jobs`(O), `ai_metrics`(O) | db, 推論, page, search, agent, inv | **ホスト依存がいちばん重い**。段階的エスカレーション（既存→記録→検索スニペット→ページ本文→深掘りジョブ）。全段をエージェント側へ |
| `startDeepFoodResearch` | 3758 | `foods`(M), `food_research_jobs`(O) | `food_research_jobs`(O), `ai_metrics`(O) | db, agent, inv | 深掘り調査の起動。ちゃんと版ではエージェント自身の仕事になり、アクションは不要になる見込み |
| `startRecipeImportFromUrl` | 4320 | — | `recipe_imports`(O) | db, agent, inv | URLからのレシピ取り込み起動。同 |
| `importRecipeFromPhoto` | 4368 | `foods`(M) | `recipe_imports`(O), `ai_metrics`(O) | db, 推論（画像）, inv | レシピ写真。エージェント側へ |
| `assistMealInput` | 4582 | `foods`(M), `assist_proposals`(P) | `assist_proposals`(P), `ai_metrics`(O) | db, 推論×3, inv | 食事入力アシスト。**推論2役（検索語の展開／基準食品の選定）＋分解**。計画書の「検索の精度を落とさない」の対象 |

### 内部用（8）

| アクション | 行 | 読むテーブル | 書くテーブル | ホスト依存 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `seedFoods` | 2462 | `foods`(M) | `foods`(M) | db, inv | 初期投入（主要15品）。`DEPLOY.md` の手順から呼ぶ。クライアントからは呼ばれない |
| `importFoodTable` | 2556 | `foods`(M) | `foods`(M) | db, inv | 初期投入（成分表 約2,500件、冪等）。`DEPLOY.md` の手順 |
| `seedTargetHistory` | 5482 | `target_history`(P) | `target_history`(P), `settings`(P) | db, inv | 目標履歴のサンプル1件。クライアントからは呼ばれない |
| `reportDeepFoodResearchProgress` | 3926 | `food_research_jobs`(O) | `food_research_jobs`(O) | db, inv | 深掘り調査エージェントからの進捗コールバック |
| `completeDeepFoodResearch` | 3963 | `food_research_jobs`(O), `food_research`(O) | `food_research_jobs`(O), `food_research`(O) | db, inv | 同・結果コールバック（`spawnTask` の `expectsAction`） |
| `reportRecipeImportProgress` | 4531 | `recipe_imports`(O) | `recipe_imports`(O) | db, inv | レシピ取り込みエージェントからの進捗コールバック |
| `completeRecipeImport` | 4465 | `recipe_imports`(O), `foods`(M) | `recipe_imports`(O) | db, inv | 同・結果コールバック。材料をマスタに照合して下書きを保存 |
| `getAiMetrics` | 5512 | `ai_metrics`(O) | — | db | 運用の観測（推論の試行・失敗・スキーマ違反・リトライ数） |

クライアント（`client/src/App.tsx`）から呼ばれないアクションは7件。内部用の6件（`seedFoods`・`seedTargetHistory`・コールバック4件）と、連携面の `getDailySummary`。内部用でも `importFoodTable` と `getAiMetrics` は画面から呼ぶ。

## ホスト依存の確定

計画書の表は名前からの推測だったので、実際の呼び出し箇所を確定させた。

### 推論API（`ctx.inference.complete`）— 実呼び出し8箇所／5アクション

計画書は「成分表示の写真読み取り、食事入力アシスト、食品リサーチなど」としていたが、実際には**配合テキストの読み取り**と**レシピ写真**も推論を使う。

| 呼び出し | 行 | 経路 | メトリクスラベル | 入力 | 時間予算 |
| --- | --- | --- | --- | --- | --- |
| `parseBlendText` | 2779 | `completeWithRetry`（最大2回） | `blend_parse` | テキスト | `timeout_secs: 30` |
| `parseLabelImage` | 3016 | `ctx.inference.complete` 直接（自前で最大2回＋`raceDeadline`） | `label_photo` | 画像 | 残り予算から算出 |
| `lookupFoodInfo` 第1段 | 3399 | `completeOnce`（リトライなし） | `lookup_extract` | 検索結果スニペット | `timeout_secs: 20` |
| `lookupFoodInfo` 第2段 | 3665 | `completeOnce`（リトライなし） | `lookup_extract` | ページ本文 | `timeout_secs: 20` |
| `importRecipeFromPhoto` | 4394 | `completeWithRetry`（最大2回） | `recipe_photo` | 画像 | 全体55秒 |
| `assistMealInput` 読み取り | 4694 | `completeWithRetry`（最大2回） | `assist_parse` | テキスト | `timeout_secs: 30` |
| `assistMealInput` 分解 | 4813 | `completeWithRetry`（最大2回） | `assist_decompose` | テキスト | `timeout_secs: 30` |
| `assistMealInput` 選定 | 4940 | `completeWithRetry`（最大2回） | `assist_pick` | 候補一覧 | `timeout_secs: 30` |

共通のラッパは `completeWithRetry`（368行、スキーマ違反もリトライする）と `completeOnce`（417行、同じ材料での再試行はしない）。どちらも `InferenceSchemaError`（SDK）を参照し、試行ごとに `ai_metrics` を加算する。`raceDeadline`（458行）で、アクション側が自前の締め切りを持っている。

`assistMealInput` の分解（4813）と選定（4940）は**並行して走る**（分解待ちで予算を使い切らないため）。

### `ctx.agent.spawnTask` — 2箇所（計画書どおり）

| 呼び出し | 行 | 呼ぶアクション | `expectsAction` |
| --- | --- | --- | --- |
| `spawnDeepResearchJob`（885行のヘルパー） | 918 | `startDeepFoodResearch`（3758）と `lookupFoodInfo` の引き継ぎ（3060）の**2つが共有** | `completeDeepFoodResearch` |
| `startRecipeImportFromUrl` | 4334 | `startRecipeImportFromUrl` | `completeRecipeImport` |

どちらも長いプロンプトの中で、エージェントが呼び返すアクション（`reportDeepFoodResearchProgress` / `completeDeepFoodResearch`、`reportRecipeImportProgress` / `completeRecipeImport`）の引数スキーマを文章で指示している。P3 でツール定義を生成するときは、この指示文も生成対象になる。

### `fetchPageText`（特権機能）— 1アクションのみ

- 契約の定義: `server/src/privileged.ts`（24行、`timeoutMs: 20000`、本文は最大120,000文字・リンク250件）
- `privileged: [...]` の宣言は `lookupFoodInfo` の**1箇所だけ**（3086行）
- 実行は `ctx.executePrivileged(privileged.fetchPageText, { url })`（3504行、候補URLを並列に取得）

### `ctx.tool.web_search` — 計画書の表に無いホスト依存

- `lookupFoodInfo` の1箇所（3188行）。クエリを最大7本（メーカー名ありのとき）**並列**に投げ、各10秒でタイムボックス
- アクションサンドボックスには外向きの通信が無いため、検索もページ取得もホスト経由。ちゃんと版ではエージェント自身のWeb取得に任せる

### `ctx.db` — 52箇所（計画書どおり）

### `ctx.invalidateQueries` — 36箇所（計画書どおり）

書き込み16件すべて、内部用7件（`getAiMetrics` 以外）、AI処理5件、そして**読み取り4件**（期限切れ処理の副作用）で呼ばれる。

## テーブルの分類

11テーブル（`server/src/schema.ts`、マイグレーション17本）。

### 公開マスタ（クラウドに平文で置ける）

| テーブル | 中身 | 注意 |
| --- | --- | --- |
| `foods` | 食品マスタ。`source` は `table`（成分表 約2,500件）/ `label` / `manual` / `ai` / `blend` | **`use_count` と `last_used_at` は個人の利用履歴**。公開マスタのテーブルに個人データが混ざっている。→ 公開マスタから外してログから導出する（後述の決定） |
| `recipes` | 保存したレシピ。材料行・合計値 | 自作レシピも公開マスタに置く（後述の決定）。`recipe.eaten` イベントが `{id, rev}` で参照する |

### 個人データ（ちゃんと版ではスマホが正本）

| テーブル | 中身 | 注意 |
| --- | --- | --- |
| `meal_logs` | 食事記録。1行＝1品目、記録時の栄養値のスナップショット | 正本。訂正は取り消し＋再登録 |
| `settings` | 現在の目標値（key/value） | `target_history` の最新行のキャッシュ |
| `target_history` | 日付つきの目標値の履歴 | |
| `assist_proposals` | AIアシストの成功した換算案のキャッシュ。`original_text` / `query_norm` | **利用者が打った文そのもの**。個人データ扱いが要る |
| `consumption_groups` | 消費ペース用の食品の名前つき集合 | 計画書はデータモデルから外す方針（エージェントのメモリと「よく使う組み合わせ」ビューに任せる） |

### 運用（公開でも個人でもない。クラウド側に残す／捨てる判断が別途必要）

| テーブル | 中身 | 注意 |
| --- | --- | --- |
| `food_research` | AI調査の記録（1名前1行、見つからなかったものも） | 値は公開情報だが、`query_name` は「利用者が何を調べたか」 |
| `food_research_jobs` | 深掘り調査ジョブの状態・進捗 | 同 |
| `recipe_imports` | レシピ取り込みの状態・下書き | `source_url` は利用者の関心 |
| `ai_metrics` | 推論レイヤのカウンタ（増える一方） | 個人の内容は入らない。頻度だけ分かる |

## 気づき（以降のフェーズで効くもの）

1. **アクションは48個**。計画書の「47個」は1件少ない。
2. **`ctx.tool.web_search` が計画書のホスト依存表に無い**。`lookupFoodInfo` の1箇所（3188行）。P2 の対象に含める。
3. **`foods` に個人データが混ざっている**。`use_count` / `last_used_at` を `logMeal`（5070行）と `logAssistParts`（5209行）が更新し、`listFoods`（2514行）・`assistMealInput`（4760行）・`listUsedFoods`（5567行）・`suggestRelatedFoods`（5646行）・消費ペースの名前解決（1339行、同名なら最も使われた食品を採る）が並び順に使う。マスタをクラウドに平文で置くなら、「よく使う」の情報はどこに置くかを決めないと、公開マスタから食生活が読める。→ 後述の「決定: 利用回数はログから導出する」で解消。
4. **推論を使うアクションは5件・8呼び出し**で、計画書が名前で挙げていた3種（写真読み取り・食事入力アシスト・食品リサーチ）に加えて `parseBlendText` と `importRecipeFromPhoto` がある。
5. **読み取りアクションに書き込みの副作用がある**。`getDeepFoodResearch` / `listDeepFoodResearchJobs` / `listUnregisteredResearchDrafts` が `expireStaleDeepJobs`（850行）を、`getRecipeImport` が `expireStaleRecipeImport`（2286行）を呼び、6分無応答のジョブを failed に落として `ai_metrics` を加算する。閲覧ビューに置き換えるとき、この期限切れ処理をスマホ・受け箱のどちらが持つかを決める必要がある。
6. **`ctx.agent` を使う2箇所は、エージェントが呼び返すアクションの引数スキーマをプロンプト本文で指示している**（918行・4334行）。P3 でスキーマからツール定義を生成するなら、この指示文も同じ正本から作れる。
7. `logRecipe` だけ `use_count` を更新しない（`logMeal` / `logAssistParts` は更新する）。`deleteMealLog` も減算しない。既存の非対称で、利用回数を導出に変えれば揃う（後述の決定）。
8. `deleteMealLog` / `deleteFood` / `deleteRecipe` / `deleteTargetHistory` は物理削除。ちゃんと版では取り消しイベントになるので、イベント定義に削除の表現が必要（`events.ts` の方針どおり）。

## 決定: 利用回数（`use_count` / `last_used_at`）はログから導出する

気づき3の未決事項を解消した。**公開マスタから外し、イベント（食事記録）から導出する個人データとして扱う**。スマホが `FrequentView`（`packages/core/src/types/views.ts:63`）として公開し、リレーはその最新コピーを返すだけにする。

コアの `Food` 型（`packages/core/src/types/master.ts:84`）には最初から利用回数が無く、`FrequentView` には `count` がある。この決定は型の下書きどおりなので、**`packages/core` に変更は要らない**。

### 理由

1. **混在の解消**。公開マスタは平文でクラウドに置く前提なので、利用回数を同じ行に持つと公開マスタから食生活が読める。
2. **今のカウンタは既に実態と合っていない**。`logMeal`（5070行）と `logAssistParts`（5209行、部品ごとの食品1件につき1回）は加算するが、`logRecipe` は加算せず、`deleteMealLog` は減算しない。つまりレシピ経由の記録を数え落とし、削除した記録を数え続ける単調増加のカウンタになっている。ログから導出すればどちらも自動的に直る。

### 導出の仕方

`computeConsumption`（1300行付近）が既に同じ解決をしている — 直接の記録・アシスト分解の部品・レシピ記録を材料行に展開する3経路。`FrequentView` の `count` はこの3経路の件数、`last_used_at` は最終記録日。

ちゃんと版ではイベントが食品の id と rev を持つので、分解部品の名前解決（1339行、同名なら最も使われた食品を採るという今の妥協）は不要になる。

### 決めたこと

- **ビューに無い食品の `count` は `null`**（0 ではない）。「使ったことがない」と「上位N件に載っていない」を区別する。不明は null の原則どおり
- **利用回数を検索の絞り込みの一次キーにしない**。`search_foods` は計画書どおり照合スコアで最大16件を返し、利用回数は同スコアの tie-break と表示に回す。ビューが古い・未取得のときは名前順にフォールバックする
- **簡易版（Space 版）は列をそのまま残す**（配置を動かさない原則）。コアへ移す照合ロジックは利用回数を引数に取らず、並び順は呼び出し側が渡す形にして、`topFoodMatches` は書き換えずに済ませる

### 精度の確認が要る点（P2 の評価セット）

今の Space 版は、利用回数が「エージェントに見える候補」を実際に決めている。

- `listFoods`（2514行）は利用回数の降順に並べてから `limit`（既定80）で切るので、どの80件が見えるかを利用回数が決めている。スキルが使う検索口はこれ
- `topFoodMatches`（2076行）のソートは安定ソートなので、入力順（＝利用回数の降順）が同スコア時の tie-break として効く。`assistMealInput` はキーワードごとに上位6件を取るので、同スコアの食品が多いときは利用回数が候補16件の中身を変える

score-first に変える影響は、計画書の評価セット（「16件に正解が入る率」「最終的に正解を選ぶ率」）で今の Space 版と比べて確かめる。

### 影響するアクション

`listFoods`（並び順）、`listUsedFoods`（`FrequentView` そのものになる）、`assistMealInput`（候補プールの tie-break）、`suggestRelatedFoods`（tie-break）、`logMeal` / `logAssistParts`（加算をやめる）、`getConsumptionStats`（個人データ側で動くのでそのまま）。

## 決定: 登録した食品とレシピも公開マスタに置く

計画書の表どおり、**利用者が登録した `foods`（ラベル写真・メーカー調査・手入力・配合）と `recipes` も公開マスタに置く**。ただし「マスタに何を入れていいか」を出典で縛り、残るリスクを配布時に明記する。

これは好みの問題ではなく、構造上そうなっている。

### 個人データ側に置けない理由

1. **記録イベントは食品・レシピを `{id, rev}` で参照し、rev はリレーが打つ**（`packages/core/src/types/events.ts:28-31`。投函時は `rev` 省略可、保存時は必須）。リレーが解決できない食品は**そもそも記録できない**。スマホを起こして答えさせる経路は当面作らない方針なので（計画書）、個人データ側に置いた食品は「記録しようとしても、スマホが次に起きるまで何も返らない」ことになる
2. **復唱が落ちる**。`packages/core/src/types/receipt.ts` の冒頭が設計の前提をそのまま書いている — リレーは公開マスタで食品を解決し、スマホと同じ計算を走らせるから即座に返せる。`echo`（「昼食に 鶏むね肉（皮なし）150g ほか2品、計 412 kcal を記録します」）は、聞き間違いを人の目で止めるための安全装置。**ラベル登録した市販品と自作レシピはいちばんよく記録するもの**なので、そこだけ復唱が落ちるのは本末転倒
3. **`search_foods` で引けなくなる**。エージェントが自分で登録した食品を見つけられない

つまり個人データ側に置くという選択は、「登録した食品とレシピは二段構えの利点をすべて失う」ことを意味する。マスタを公開にしたのは、この3つを成り立たせるためだった（計画書の「食品の特定方法：マスタを公開にしたので解消」）。

### 代わりに、マスタに入れていいものを縛る

マスタに入るのは**出典のある食品の事実だけ**。`master.ts` はすでに型で縛っている。

- `FoodSource` に `ai` が無い（出典は引用で、調べた手段ではない）
- `manual` は `note` 必須 — なぜ出典が無いかを書かせる
- `Food` に利用回数が無い（前節の決定）

マスタに入れないもの: 何をいつどれだけ食べたか（イベント）、その導出値（利用回数）、利用者についての自由記述。

配合食品（`blend`）は自家製の調合そのもので、この区分でいちばん私的だが、やはりマスタに置く。記録に使う食品なので理由1〜3がそのまま当てはまる。今の Space 版は配合の要約文を `foods.source_name` に入れている（`saveBlendFood`、2927行付近）が、コアでは `FoodSource.blend`（`parts` と `totalGrams` の構造）になっていて、出典欄に調理メモを混ぜる形は解消されている。

### 残るリスク（P6 で配布時に書く）

ちゃんと版でも、**クラウドのマスタからは「どんな食品とレシピを登録したか」が読める**。読めないのは「何をいつどれだけ食べたか」とその頻度。この線引きをそのまま README と DEPLOY.md に書く（計画書 P6 の「簡易版の割り切りを明記する」に、ちゃんと版の割り切りも足す）。

### 見送ったこと

食品・レシピごとの「非公開」フラグは作らない。非公開にした項目はリレーが解決できないので、その項目だけ復唱と即時受理が落ちる — 理由1・2と同じ問題が項目単位で起きるだけになる。本当に必要になったら「スマホだけが持つ食品＋復唱は後から返す」という別の設計が要るので、P5 以降の課題として置く。

## 未決事項

- [ ] **`assist_proposals` キャッシュをちゃんと版で残すか**。残すならスマホ側。捨てると `assistMealInput` の再試行コストが戻る
- [ ] **`consumption_groups` を落とす方針（計画書）を採るなら**、`listConsumptionGroups` / `saveConsumptionGroup` / `deleteConsumptionGroup` の3件が消え、`getConsumptionStats` / `listUsedFoods` / `suggestRelatedFoods` は「よく使う組み合わせ」ビューに寄る
- [ ] **読み取りの副作用（期限切れ処理）の持ち主**（気づき5）
- [ ] **`food_research` / `food_research_jobs` / `recipe_imports` をちゃんと版で持つか**。AI処理をエージェント側に出すと、これらの状態管理もエージェント側に移る可能性がある
