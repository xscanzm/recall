import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EXPECTED_INVOKE_CHANNEL_COUNT = 85;

/**
 * handleValidated 覆盖率地板（棘轮）。
 *
 * 只准涨不准跌：迁移一个 channel 到 handleValidated 就把这个数往上抬。
 * 目的是让"新加 raw ipcMain.handle"在 review 之外还有一道自动拦截。
 *
 * 2026-07 基线：41 个已迁移。
 * 2026-08 todo-24：handlers.ts 剩余 33 个裸 ipcMain.handle 全部迁出
 * （endOfDayReview×5 / reports:notification×3 / model×5 / memory×15 / debug×3 / mac×2），
 * 其中 30 个此前无契约的 channel 已在 ipcContracts.ts 补契约并走 handleValidated
 * （3 个 reports:notification 契约原已存在），总数抬至 74。
 * 注：reports:getImage 已有契约但仍在 reportsHandlers.ts 以裸 ipcMain.handle 注册，
 * 不在本计数内（留待后续迁移）。
 */
const MIN_VALIDATED_CHANNELS = 74;

function extractChannels(source: string, pattern: RegExp): Set<string> {
  return new Set(Array.from(source.matchAll(pattern), (match) => match[1]));
}

function extractChannelOccurrences(source: string, pattern: RegExp): string[] {
  return Array.from(source.matchAll(pattern), (match) => match[1]);
}

describe("IPC registration contract", () => {
  it("registers every invoke channel exposed by preload", () => {
    const root = process.cwd();
    const preloadSource = readFileSync(resolve(root, "src/main/preload.ts"), "utf8");
    const handlerDirectory = resolve(root, "src/main/ipc/handlers");
    const handlerSources = [
      readFileSync(resolve(root, "src/main/ipc/handlers.ts"), "utf8"),
      ...readdirSync(handlerDirectory)
        .filter((fileName) => fileName.endsWith(".ts") && !fileName.endsWith(".test.ts"))
        .map((fileName) => readFileSync(resolve(handlerDirectory, fileName), "utf8")),
    ].join("\n");

    const preloadChannels = extractChannels(
      preloadSource,
      /(?:ipcRenderer\.invoke\s*\(\s*|invokeValidated\s*\(\s*ipcRenderer\s*,\s*)["']([^"']+)["']/g,
    );
    const registrationPattern =
      /(?:ipcMain\.handle\s*\(\s*|handleValidated\s*\(\s*ipcMain\s*,\s*)["']([^"']+)["']/g;
    const registrationOccurrences = extractChannelOccurrences(
      handlerSources,
      registrationPattern,
    );
    const registeredChannels = new Set(registrationOccurrences);
    const missingChannels = [...preloadChannels]
      .filter((channel) => !registeredChannels.has(channel))
      .sort();

    // 任何 channel 被注册两次都算问题，不再只查分解后的几个域前缀。
    //
    // 背景：handleValidated 内部会先 removeHandler(channel) 再 handle(channel)，
    // 所以重复注册不会像裸 ipcMain.handle 那样抛错——后注册的那个静默胜出，
    // 先注册的实现变成永远不会执行的死代码。此前 handlers.ts 里就有 6 个
    // channel（memory:ask / capture:forgetRecent / screenshot:clear / data:export
    // / data:clearAll / data:getCacheSize）以这种方式被悄悄覆盖。
    const duplicateChannels = [...registeredChannels]
      .filter(
        (channel) =>
          registrationOccurrences.filter((registered) => registered === channel).length > 1,
      )
      .sort();

    expect(preloadChannels.size).toBe(EXPECTED_INVOKE_CHANNEL_COUNT);
    expect(registeredChannels.size).toBe(EXPECTED_INVOKE_CHANNEL_COUNT);
    expect(missingChannels).toEqual([]);
    expect(duplicateChannels).toEqual([]);
  });

  it("keeps the handleValidated share above the ratchet floor", () => {
    const root = process.cwd();
    const handlerDirectory = resolve(root, "src/main/ipc/handlers");
    const handlerSources = [
      readFileSync(resolve(root, "src/main/ipc/handlers.ts"), "utf8"),
      ...readdirSync(handlerDirectory)
        .filter((fileName) => fileName.endsWith(".ts") && !fileName.endsWith(".test.ts"))
        .map((fileName) => readFileSync(resolve(handlerDirectory, fileName), "utf8")),
    ].join("\n");

    const validatedChannels = extractChannels(
      handlerSources,
      /handleValidated\s*\(\s*ipcMain\s*,\s*["']([^"']+)["']/g,
    );

    expect(validatedChannels.size).toBeGreaterThanOrEqual(MIN_VALIDATED_CHANNELS);
  });
});
