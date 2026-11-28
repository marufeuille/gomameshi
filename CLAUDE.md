# CLAUDE.md

このリポジトリは食事ログアプリ「ごまめし」。いま `main` で配布しているのは Muse の Space 版（簡易版）で、このブランチ（`dev/two-tier`）では、個人データをスマホに置く「ちゃんと版」との二段構えを開発している。

- 計画書: `docs/plan.md`（目的、設計方針、作業フェーズ P0〜P6、未決事項）
- 型の下書き: `packages/core/src/types`（型15件＋計算・検証45件で `bun test` 60件）
- 作業の単位は GitHub Issues の `[準備]`、`[P0]`〜`[P6]`

## リポジトリの構成

リポジトリ直下は Space 版そのまま（`client/`、`server/`、`drizzle/`、`space.json`、`package.json`）で、共通コアだけが `packages/core/` にいる。

`packages/core/src` の中身（P1 で切り出したもの）:

| 置き場所 | 中身 |
| --- | --- |
| `types/` | 型の下書き（マスタ・イベント・受領票・ビュー） |
| `db/schema.ts` | Drizzle のスキーマ。**正本はここ**で、`server/src/schema.ts` は再 export するだけ |
| `db/storedJson.ts` | 保存 JSON の版付け（`{ v, data }`） |
| `nutrition/` | 丸め、微量栄養素、マスタ食品 × 量 の計算、日次集計、日付、目標値の導出 |
| `ports.ts` | データの読み書きのアダプタ。Space 版は `server/src/store.ts` が `ctx.db` で実装する |
| `usecases/` | 検証＋計算＋読み書きの組み立て（P1 は食事記録の縦一本） |
| `errors.ts` | `CoreError`（コードは受領票の `ErrorCode` と同じ語彙） |

Space 版の `server/src/actions.ts` に残るのはホストとの境界だけ: アクション定義（ホストの zod での request / response）、推論・`ctx.agent`・Web 取得、画面の更新通知、そして Space 版だけの関心（利用回数のカウンタ、`ai_metrics`、期限切れ処理）。

`packages/core` は **独立したパッケージ**で、自前の `package.json` と `bun.lock` を持ち、`packages/core` の中で install する。リポジトリ直下から見た workspace のメンバーにはしない。

bun workspaces を入れないのは、入れると Muse の外で `packages/core` の install が通らなくなるため。直下の `package.json` が `@hatch/space-sdk` を `file:/opt/hatch/...` で参照しているので、workspace にすると `packages/core` の中で `bun install` してもワークスペース全体が解決対象になり、`@hatch/space-sdk@file:/opt/hatch/... failed to resolve` でこける（bun 1.3 で実測）。Space 版からコアを参照するときは、相対パスの import で足りる。

## 守ること

- `main` は配布中の Space 版。このブランチの作業で `main` を直接変えない
- Space 版（`client/`、`server/`、`drizzle/`、`space.json`）の配置は動かさない。Muse が今まで通り読めることを優先する。直下の `package.json` と `bunfig.toml` も、必要がなければ触らない
- `packages/core` は `@hatch/space-sdk` を import しない。依存にローカルパス（`file:`、`link:`）も入れない。どちらも `src/no-host-deps.test.ts` が落ちて気づけるようにしてある
- `packages/core` が外から使う npm パッケージ（`zod`、`drizzle-orm`）は、直下の `package.json` と**同じバージョンに固定**する。Muse の中では `packages/core/node_modules` を作らないので、コアの import もリポジトリ直下の node_modules に解決される（二重に入らない）。`drizzle-orm` は `peerDependencies` にも置いて、器が持ち込むものだと分かるようにしてある
- アクションの request / response スキーマはホストの zod（`@hatch/space-sdk` の `z`）のまま。コアの zod インスタンスをホストの `defineAction` に渡さない（同じ版でも別コピーになり得るため）。同じ範囲の指定がコアとアクションの両方にあるのは承知の上で、P3 でイベント型から生成して一本化する
- `server/tsconfig.json` に `rootDir` を置かない。Space 版は共通コアを相対 import で参照するので、`rootDir` を `server/` に固定すると TS6059 で型検査が通らない
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
bun run typecheck
```

直下での `bun install` や `bun run typecheck` は Muse の中（`/opt/hatch` がある環境）でしか通らない。手元や CI では `packages/core` の中だけで作業する。

Space 版（`server/`、`client/`）を手元で型検査する手段は無い。`server/src/actions.ts` を触ったら、少なくとも

```sh
bun build server/src/actions.ts --target=bun \
  --external '@hatch/space-sdk' --external 'drizzle-orm' --external 'drizzle-orm/*' \
  --external '@space/privileged' --external 'zod' --outfile=/tmp/actions.bundle.js
```

で構文と相対 import の解決だけは確かめる。型の確認は Muse の中の `bun run typecheck` で行う。

## CI

`.github/workflows/core.yml` が `packages/core` の install・型検査・テストを回す（`main` と `dev/two-tier` への push、および全 PR）。Space 版はホスト SDK がないと install できないので CI では触らない。

`bun.lock` は Muse 側の新しい bun（`lockfileVersion` 2）が書いたもので、1.3.11 などの古い bun では読めない。そのため CI は `--frozen-lockfile` を付けずに `bun install` する。手元で `bun install` するとロックファイルが古い形式に書き戻されることがあるので、意図しない差分はコミットしない。
