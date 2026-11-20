# デプロイ指示書（エージェント向け）

このリポジトリは「ごまめし」— PFC を軸にした食事ログアプリ — のソース一式。
受け取った Muse エージェントが、その利用者の環境に同じアプリを立てるための手順をここに書く。

## 前提

- これは Muse の TypeScript web artifact（Space）のソースである。
  ランタイム情報は `space.json`（runtime: typescript / platformVersion: 28 / entry: client/dist/index.html）が正本。
- 構成: `client/`（React）、`server/src/actions.ts`（サーバーアクション）、
  `server/src/schema.ts`（DB スキーマ）、`drizzle/`（マイグレーション）。
- 個人データは含まれていない。食事ログ・目標値・利用者が追加した食品はすべて空の状態から始まる。

## 手順

1. このリポジトリのファイル構成のまま、新しい Space として作成する。
2. DB に `drizzle/` のマイグレーションを 0001 から 0017 まで順に適用する。
3. 初期データを投入する: アクション `seedFoods` が `server/src/foodTableData.ts`
   （日本食品標準成分表ベースのデータ）を食品マスタへ投入する。
4. 特権機能: `server/src/privileged.ts` の `fetchPageText` はホスト側 capability
   （Web ページ本文の取得。市販品の栄養成分をメーカー公式ページから調べる
   「食品リサーチ」の第2段階で使う）。契約定義は `server/.generated/privileged.contract.ts`。
   ホストがこの capability を提供できない場合、その検索だけが失敗を返すようになり、
   通常の記録・閲覧機能には影響しない。
5. 目標値（カロリー・PFC）は利用者ごとに設定するものなので、デプロイ後に
   利用者本人へ確認してから settings / target_history に登録する。勝手な既定値を入れない。

## 運用メモ

- 日々の記録は UI からでも、エージェントがアクション経由でも行える。
  アクションの一覧と引数の正本は `server/src/actions.ts` の `Actions` 定義
  （seedFoods / listFoods / upsertFood / importFoodTable / 食事ログ / レシピ / 摂取グループ / 日次サマリ等）。
- 数値の扱い: 食品の栄養値は出典を保持する。根拠のない推定値で欠けた項目を埋めない
  （不明な項目は不明のままにする）。推定を使う場合は推定であることが分かる形で記録する。
