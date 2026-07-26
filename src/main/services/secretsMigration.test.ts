import { describe, expect, it, vi } from "vitest";
import { migrateKeytarSecrets, parseConfigId } from "./secretsMigration";

interface FakeKeytar {
  findCredentials: (service: string) => Promise<Array<{ account: string; password: string }>>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
}

function makeKeytar(
  entries: Array<{ account: string; password: string }>,
  overrides: Partial<FakeKeytar> = {},
): { keytar: FakeKeytar; deleted: string[] } {
  const deleted: string[] = [];
  const keytar: FakeKeytar = {
    findCredentials: () => Promise.resolve(entries),
    deletePassword: (_service, account) => {
      deleted.push(account);
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { keytar, deleted };
}

describe("parseConfigId", () => {
  it("extracts the config id from the keytar account name", () => {
    expect(parseConfigId("model:abc-123:apiKey")).toBe("abc-123");
  });

  it("tolerates colons inside the config id", () => {
    expect(parseConfigId("model:a:b:apiKey")).toBe("a:b");
  });

  it("rejects unrelated account names", () => {
    expect(parseConfigId("model:abc")).toBeNull();
    expect(parseConfigId("apiKey")).toBeNull();
    expect(parseConfigId("")).toBeNull();
  });
});

describe("migrateKeytarSecrets", () => {
  it("moves each key into safeStorage and deletes the source", async () => {
    const setApiKey = vi.fn().mockResolvedValue(undefined);
    const { keytar, deleted } = makeKeytar([
      { account: "model:one:apiKey", password: "sk-one" },
      { account: "model:two:apiKey", password: "sk-two" },
    ]);

    const result = await migrateKeytarSecrets({
      secretService: { setApiKey },
      loadKeytar: () => keytar,
      isEncryptionAvailable: () => true,
    });

    expect(result).toEqual({ status: "done", migrated: 2, failed: 0 });
    expect(setApiKey.mock.calls).toEqual([
      ["one", "sk-one"],
      ["two", "sk-two"],
    ]);
    expect(deleted).toEqual(["model:one:apiKey", "model:two:apiKey"]);
  });

  it("keeps the keytar entry when the new write fails", async () => {
    // 关键行为：写不进 safeStorage 就不能删源，否则 key 直接丢了。
    const setApiKey = vi.fn().mockRejectedValue(new Error("encryption failed"));
    const { keytar, deleted } = makeKeytar([{ account: "model:one:apiKey", password: "sk-one" }]);

    const result = await migrateKeytarSecrets({
      secretService: { setApiKey },
      loadKeytar: () => keytar,
      isEncryptionAvailable: () => true,
    });

    expect(result).toEqual({ status: "done", migrated: 0, failed: 1 });
    expect(deleted).toEqual([]);
  });

  it("skips entries whose account name is not a model key", async () => {
    const setApiKey = vi.fn().mockResolvedValue(undefined);
    const { keytar, deleted } = makeKeytar([
      { account: "something:else", password: "x" },
      { account: "model:ok:apiKey", password: "sk-ok" },
    ]);

    const result = await migrateKeytarSecrets({
      secretService: { setApiKey },
      loadKeytar: () => keytar,
      isEncryptionAvailable: () => true,
    });

    expect(result).toEqual({ status: "done", migrated: 1, failed: 1 });
    expect(setApiKey.mock.calls).toEqual([["ok", "sk-ok"]]);
    expect(deleted).toEqual(["model:ok:apiKey"]);
  });

  it("treats an empty password as a failure rather than storing it", async () => {
    const setApiKey = vi.fn().mockResolvedValue(undefined);
    const { keytar, deleted } = makeKeytar([{ account: "model:one:apiKey", password: "" }]);

    const result = await migrateKeytarSecrets({
      secretService: { setApiKey },
      loadKeytar: () => keytar,
      isEncryptionAvailable: () => true,
    });

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);
    expect(setApiKey).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("is a no-op second run because the source was already drained", async () => {
    const setApiKey = vi.fn().mockResolvedValue(undefined);
    const { keytar } = makeKeytar([]);

    const result = await migrateKeytarSecrets({
      secretService: { setApiKey },
      loadKeytar: () => keytar,
      isEncryptionAvailable: () => true,
    });

    expect(result).toEqual({ status: "done", migrated: 0, failed: 0 });
    expect(setApiKey).not.toHaveBeenCalled();
  });

  it("skips when safeStorage is unavailable", async () => {
    const setApiKey = vi.fn().mockResolvedValue(undefined);
    const { keytar } = makeKeytar([{ account: "model:one:apiKey", password: "sk-one" }]);

    const result = await migrateKeytarSecrets({
      secretService: { setApiKey },
      loadKeytar: () => keytar,
      isEncryptionAvailable: () => false,
    });

    expect(result).toEqual({
      status: "skipped",
      migrated: 0,
      failed: 0,
      reason: "encryption_unavailable",
    });
    expect(setApiKey).not.toHaveBeenCalled();
  });

  it("skips when the keytar module is gone", async () => {
    // keytar 从 dependencies 移除后走这条路径，不能抛错。
    const setApiKey = vi.fn().mockResolvedValue(undefined);

    const result = await migrateKeytarSecrets({
      secretService: { setApiKey },
      loadKeytar: () => null,
      isEncryptionAvailable: () => true,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("keytar_unavailable");
  });

  it("skips when the credential store cannot be read", async () => {
    const setApiKey = vi.fn().mockResolvedValue(undefined);
    const { keytar } = makeKeytar([], {
      findCredentials: () => Promise.reject(new Error("no secret-service")),
    });

    const result = await migrateKeytarSecrets({
      secretService: { setApiKey },
      loadKeytar: () => keytar,
      isEncryptionAvailable: () => true,
    });

    expect(result.reason).toBe("keytar_read_failed");
    expect(setApiKey).not.toHaveBeenCalled();
  });
});
