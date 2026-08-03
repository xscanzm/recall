import { describe, expect, it } from "vitest";
import {
  MODEL_PROXY_DAILY_LIMIT_PER_IP_DEFAULT,
  normalizeIpForRateLimit,
  resolveModelProxyDailyLimit,
  takeModelProxyRateLimit,
} from "./rateLimit";

/**
 * 串行化的 D1 mock：first() 内的自增是同步的（无 await），
 * 由 JS 单线程保证并发调用依次执行——等价于 D1 单语句的原子性。
 * 同时记录每次 RETURNING 的值，用于断言无重复、无丢失。
 */
class SerializedD1 {
  readonly counters = new Map<string, number>();
  readonly returned: number[] = [];

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          if (sql.includes("model_proxy_rate_limits")) {
            const [day, ip] = args as [string, string];
            const key = `${day}\u0000${ip}`;
            const n = (this.counters.get(key) ?? 0) + 1;
            this.counters.set(key, n);
            this.returned.push(n);
            return { n } as T;
          }
          return null;
        },
      }),
    };
  }
}

describe("normalizeIpForRateLimit", () => {
  it("keeps IPv4 addresses unchanged", () => {
    expect(normalizeIpForRateLimit("203.0.113.9")).toBe("203.0.113.9");
  });

  it("collapses every IPv6 address to its /64 prefix", () => {
    expect(normalizeIpForRateLimit("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3:0::/64");
    expect(normalizeIpForRateLimit("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3:0::/64");
    expect(normalizeIpForRateLimit("::1")).toBe("0:0:1:0::/64");
    expect(normalizeIpForRateLimit("2001:db8:85a4:0:0:0:0:1")).toBe("2001:db8:85a4:0::/64");
  });

  it("strips the zone index and lowercases", () => {
    expect(normalizeIpForRateLimit("fe80::1%eth0")).toBe("fe80:0:1:0::/64");
    expect(normalizeIpForRateLimit("2001:DB8:85A3::1")).toBe("2001:db8:85a3:0::/64");
  });

  it("falls back to unknown for empty input", () => {
    expect(normalizeIpForRateLimit("")).toBe("unknown");
    expect(normalizeIpForRateLimit("   ")).toBe("unknown");
  });
});

describe("resolveModelProxyDailyLimit", () => {
  it("defaults to 200 when unset or invalid", () => {
    expect(resolveModelProxyDailyLimit(undefined)).toBe(MODEL_PROXY_DAILY_LIMIT_PER_IP_DEFAULT);
    expect(resolveModelProxyDailyLimit("")).toBe(MODEL_PROXY_DAILY_LIMIT_PER_IP_DEFAULT);
    expect(resolveModelProxyDailyLimit("abc")).toBe(MODEL_PROXY_DAILY_LIMIT_PER_IP_DEFAULT);
    expect(resolveModelProxyDailyLimit("0")).toBe(MODEL_PROXY_DAILY_LIMIT_PER_IP_DEFAULT);
    expect(resolveModelProxyDailyLimit("-5")).toBe(MODEL_PROXY_DAILY_LIMIT_PER_IP_DEFAULT);
  });

  it("parses a valid override", () => {
    expect(resolveModelProxyDailyLimit("50")).toBe(50);
    expect(resolveModelProxyDailyLimit("  1  ")).toBe(1);
  });
});

describe("takeModelProxyRateLimit (D1 atomic counter)", () => {
  it("allows exactly `limit` calls and rejects the rest under a concurrent burst", async () => {
    const d1 = new SerializedD1();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => takeModelProxyRateLimit(d1 as never, "203.0.113.7", 5))
    );
    expect(results.filter((allowed) => allowed)).toHaveLength(5);
    expect(results.filter((allowed) => !allowed)).toHaveLength(5);
  });

  it("never loses increments: RETURNING sequence is 1..10 with no gap or duplicate", async () => {
    const d1 = new SerializedD1();
    await Promise.all(
      Array.from({ length: 10 }, () => takeModelProxyRateLimit(d1 as never, "203.0.113.7", 5))
    );
    expect(d1.returned).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...d1.counters.values()]).toEqual([10]);
  });

  it("shares one counter across addresses within the same IPv6 /64", async () => {
    const d1 = new SerializedD1();
    const siblingA = normalizeIpForRateLimit("2001:db8:85a3:0::1");
    const siblingB = normalizeIpForRateLimit("2001:db8:85a3:0:ffff::2");
    expect(siblingA).toBe(siblingB);
    await takeModelProxyRateLimit(d1 as never, siblingA, 200);
    await takeModelProxyRateLimit(d1 as never, siblingB, 200);
    expect([...d1.counters.values()]).toEqual([2]);
  });

  it("keeps separate counters for different IPs", async () => {
    const d1 = new SerializedD1();
    await takeModelProxyRateLimit(d1 as never, "203.0.113.7", 1);
    const otherIpAllowed = await takeModelProxyRateLimit(d1 as never, "198.51.100.3", 1);
    expect(otherIpAllowed).toBe(true);
    expect(d1.counters.size).toBe(2);
  });
});
