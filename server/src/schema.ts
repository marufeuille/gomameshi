// Drizzle schema for 食事とPFC — the definition itself now lives in the
// shared core (`packages/core/src/db/schema.ts`), because the ちゃんと版
// (Expo + expo-sqlite) has to read and write the same tables.
//
// This file stays as the Space 版's import path so nothing in
// `server/src/actions.ts` has to change: Drizzle's sqlite-core dialect
// works on both hosts, so the table definitions are shared as-is.
export * from "../../packages/core/src/db/schema";
