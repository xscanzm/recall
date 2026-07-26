import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * safeStorage 用一个可逆的假实现替代（前缀 + base64 反转），只为了断言
 * "写进文件的不是明文" 以及 "读回来等于写进去的"。真正的 DPAPI 行为不在单测范围内。
 */
const secretsMock = vi.hoisted(() => ({
  userDataDir: "",
  encryptionAvailable: true,
  encryptCalls: 0,
}));

const CIPHER_PREFIX = "enc:";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return secretsMock.userDataDir;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => secretsMock.encryptionAvailable,
    encryptString: (plain: string) => {
      secretsMock.encryptCalls += 1;
      return Buffer.from(CIPHER_PREFIX + [...plain].reverse().join(""), "utf8");
    },
    decryptString: (buf: Buffer) => {
      const raw = buf.toString("utf8");
      if (!raw.startsWith(CIPHER_PREFIX)) throw new Error("bad ciphertext");
      return [...raw.slice(CIPHER_PREFIX.length)].reverse().join("");
    },
  },
}));

import { DATA_DIR, SECRETS_FILENAME } from "../../shared/constants";
import { SecretService } from "./SecretService";

function secretsFilePath(): string {
  return path.join(secretsMock.userDataDir, DATA_DIR, SECRETS_FILENAME);
}

function readRawFile(): string {
  return fs.readFileSync(secretsFilePath(), "utf8");
}

describe("SecretService", () => {
  let service: SecretService;

  beforeEach(() => {
    secretsMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-secrets-"));
    secretsMock.encryptionAvailable = true;
    secretsMock.encryptCalls = 0;
    service = new SecretService();
  });

  afterEach(() => {
    fs.rmSync(secretsMock.userDataDir, { recursive: true, force: true });
  });

  it("round-trips a key through the encrypted file", async () => {
    await service.setApiKey("cfg-1", "sk-secret-value");
    expect(await service.getApiKey("cfg-1")).toBe("sk-secret-value");
    expect(secretsMock.encryptCalls).toBe(1);
  });

  it("never writes the plaintext key to disk", async () => {
    await service.setApiKey("cfg-1", "sk-plaintext-canary");
    const raw = readRawFile();
    expect(raw).not.toContain("sk-plaintext-canary");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it("keys secrets per config so configs cannot read each other", async () => {
    await service.setApiKey("cfg-a", "sk-a");
    await service.setApiKey("cfg-b", "sk-b");

    expect(await service.getApiKey("cfg-a")).toBe("sk-a");
    expect(await service.getApiKey("cfg-b")).toBe("sk-b");
  });

  it("overwrites an existing key without disturbing the others", async () => {
    await service.setApiKey("cfg-a", "sk-a");
    await service.setApiKey("cfg-b", "sk-b");
    await service.setApiKey("cfg-a", "sk-a-rotated");

    expect(await service.getApiKey("cfg-a")).toBe("sk-a-rotated");
    expect(await service.getApiKey("cfg-b")).toBe("sk-b");
  });

  it("returns null for a config that was never stored", async () => {
    expect(await service.getApiKey("missing")).toBeNull();
  });

  it("deletes a key and reports whether anything was removed", async () => {
    await service.setApiKey("cfg-1", "sk-1");

    expect(await service.deleteApiKey("cfg-1")).toBe(true);
    expect(await service.getApiKey("cfg-1")).toBeNull();
    // 第二次删除没有可删的东西，调用方据此判断"配置已经没有 key 了"。
    expect(await service.deleteApiKey("cfg-1")).toBe(false);
  });

  it("refuses to store anything when system encryption is unavailable", async () => {
    // 底线：safeStorage 不可用时不能退化成明文落盘。
    secretsMock.encryptionAvailable = false;

    await expect(service.setApiKey("cfg-1", "sk-1")).rejects.toThrow();
    expect(fs.existsSync(secretsFilePath())).toBe(false);
    expect(secretsMock.encryptCalls).toBe(0);
  });

  it("reads as empty instead of throwing when encryption is unavailable", async () => {
    await service.setApiKey("cfg-1", "sk-1");
    secretsMock.encryptionAvailable = false;

    expect(await service.getApiKey("cfg-1")).toBeNull();
  });

  it("survives a corrupt secrets file", async () => {
    // 一个坏文件不能让所有模型调用都抛错，只能表现为"读不到 key"。
    await service.setApiKey("cfg-1", "sk-1");
    fs.writeFileSync(secretsFilePath(), "{ not json", "utf8");

    expect(await service.getApiKey("cfg-1")).toBeNull();
    await expect(service.setApiKey("cfg-1", "sk-recovered")).resolves.toBeUndefined();
    expect(await service.getApiKey("cfg-1")).toBe("sk-recovered");
  });

  it("returns null when the stored ciphertext cannot be decrypted", async () => {
    await service.setApiKey("cfg-1", "sk-1");
    const file = JSON.parse(readRawFile()) as { secrets: Record<string, string> };
    const account = Object.keys(file.secrets)[0];
    file.secrets[account] = Buffer.from("garbage", "utf8").toString("base64");
    fs.writeFileSync(secretsFilePath(), JSON.stringify(file), "utf8");

    expect(await service.getApiKey("cfg-1")).toBeNull();
  });

  it("leaves no temp file behind after a write", async () => {
    await service.setApiKey("cfg-1", "sk-1");
    const dataDir = path.join(secretsMock.userDataDir, DATA_DIR);
    const leftovers = fs.readdirSync(dataDir).filter((f) => f !== SECRETS_FILENAME);
    expect(leftovers).toEqual([]);
  });
});
