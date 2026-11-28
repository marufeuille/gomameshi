// 共通コアは Muse のホスト SDK に依存しない、という設計ルールをテストで固定する。
// これが守られている限り、packages/core は Muse の外（CI や手元）でそのままビルド・テストできる。
import { test, expect } from "bun:test";
import { join } from "node:path";

const srcDir = import.meta.dir;
const packageRoot = join(srcDir, "..");

const sourceFiles = [...new Bun.Glob("**/*.ts").scanSync({ cwd: srcDir })].sort();

/** import / export / require から参照先の指定子を取り出す。 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

test("型の下書きが入ったソースを走査できている", () => {
  expect(sourceFiles.length).toBeGreaterThan(0);
});

test("@hatch/* をどこからも import していない", async () => {
  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const source = await Bun.file(join(srcDir, file)).text();
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith("@hatch/")) offenders.push(`${file}: ${specifier}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("package.json にホスト SDK もローカルパス依存も入っていない", async () => {
  const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const entries = [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
    ...Object.entries(manifest.peerDependencies ?? {}),
    ...Object.entries(manifest.optionalDependencies ?? {}),
  ];

  // ローカルパス（file:/opt/hatch/... など）を参照すると、その環境でしか install できなくなる。
  const offenders = entries
    .filter(([name, version]) => name.startsWith("@hatch/") || version.startsWith("file:") || version.startsWith("link:"))
    .map(([name, version]) => `${name}@${version}`);
  expect(offenders).toEqual([]);
});
