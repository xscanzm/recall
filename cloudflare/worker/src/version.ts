// 自实现的 semver 比较工具（不引入第三方 semver 包）
// 仅支持 "major.minor.patch" 形式，容错处理常见前缀与缺失段

/**
 * 解析版本号为三元组 [major, minor, patch]
 * - 忽略 "v" / "V" 前缀
 * - 缺失的段视为 0
 * - 非数字段视为 0
 *
 * @param v 版本字符串，如 "0.1.2" 或 "v1.2.3"
 * @returns [major, minor, patch]
 */
export function parseVersion(v: string): [number, number, number] {
  // 去除前后空白与可选的 v/V 前缀
  const trimmed = (v ?? "").trim().replace(/^[vV]/, "");
  // 拆分为最多 3 段
  const parts = trimmed.split(".");
  const safe = (i: number): number => {
    const raw = parts[i];
    if (raw === undefined) return 0;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  return [safe(0), safe(1), safe(2)];
}

/**
 * 比较两个语义化版本号
 * @param a 版本 A
 * @param b 版本 B
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseVersion(a);
  const [bMaj, bMin, bPat] = parseVersion(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}
