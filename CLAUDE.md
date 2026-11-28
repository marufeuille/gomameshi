# CLAUDE.md

このリポジトリは食事ログアプリ「ごまめし」。いま `main` で配布しているのは Muse の Space 版（簡易版）で、このブランチ（`dev/two-tier`）では、個人データをスマホに置く「ちゃんと版」との二段構えを開発している。

- 計画書: `docs/plan.md`（目的、設計方針、作業フェーズ P0〜P6、未決事項）
- 型の下書き: `packages/core/src/types`（`bun test` で12件）
- 作業の単位は GitHub Issues の `[準備]`、`[P0]`〜`[P6]`

## 守ること

- `main` は配布中の Space 版。このブランチの作業で `main` を直接変えない
- Space 版（`client/`、`server/`、`drizzle/`、`space.json`）の配置は動かさない。Muse が今まで通り読めることを優先する
- `packages/core` は `@hatch/space-sdk` を import しない（Muse の外でビルド・テストできるようにするため）
- 栄養値を発明しない。数値はすべて「マスタ食品 × グラム」からコアで計算する。エージェントが送ってきた栄養値は使わない
- 不明な栄養素は null のまま。0 や推測値で埋めない
- 個人データ（食事ログ、目標値）は、イベントを通してしか変えない。直接 DB を書き換えて辻褄を合わせない。訂正は「取り消し＋再登録」
- 食品マスタは公開情報として扱う。出典は引用で持ち、「ai」という出典は作らない
- 照合ロジック（`coreMatchKey`、`topFoodMatches` など）をコアへ移すときは、書き換えずにそのまま移す。検索精度は評価セットで今の Space 版と比べる

## コマンド

```sh
cd packages/core
bun install
bun test
bunx tsc --noEmit -p .
```
