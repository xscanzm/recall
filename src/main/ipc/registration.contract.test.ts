import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EXPECTED_INVOKE_CHANNEL_COUNT = 81;
const DECOMPOSED_DOMAIN_PREFIXES = [
  "reports:",
  "timeline:",
  "personalReview:",
  "workReport:",
  "unfinishedThreads:",
] as const;

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
    const duplicateDecomposedChannels = [...registeredChannels]
      .filter(
        (channel) =>
          DECOMPOSED_DOMAIN_PREFIXES.some((prefix) => channel.startsWith(prefix)) &&
          registrationOccurrences.filter((registered) => registered === channel).length > 1,
      )
      .sort();

    expect(preloadChannels.size).toBe(EXPECTED_INVOKE_CHANNEL_COUNT);
    expect(registeredChannels.size).toBe(EXPECTED_INVOKE_CHANNEL_COUNT);
    expect(missingChannels).toEqual([]);
    expect(duplicateDecomposedChannels).toEqual([]);
  });
});
