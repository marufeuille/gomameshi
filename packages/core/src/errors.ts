// コアが投げるエラー。
//
// 検証の失敗は、どちらの版でも同じ語彙で表せるようにする。コードは受領票
// （`types/receipt.ts` の `ErrorCode`）と同じものを使い、ちゃんと版では
// そのまま `SubmitError` に積める。Space 版は `Error` として扱えばよく、
// メッセージは Space 版が今まで返していた文言のまま。

import type { ErrorCode } from "./types/receipt";

export class CoreError extends Error {
  readonly code: ErrorCode;
  /** 入力の中のどこが問題か（例: ["items", 1, "amount", "unit"]）。 */
  readonly path: ReadonlyArray<string | number>;
  /** エージェントに示せる次の手。無ければ null。 */
  readonly hint: string | null;
  /** 単位が使えないときに、その食品で使える単位。 */
  readonly allowedUnits: ReadonlyArray<string> | null;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      path?: ReadonlyArray<string | number>;
      hint?: string | null;
      allowedUnits?: ReadonlyArray<string> | null;
    } = {},
  ) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.path = options.path ?? [];
    this.hint = options.hint ?? null;
    this.allowedUnits = options.allowedUnits ?? null;
  }
}

export function isCoreError(e: unknown): e is CoreError {
  return e instanceof CoreError;
}
