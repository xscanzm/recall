// 从 R2 读取更新清单（manifest.json）的工具

/**
 * 更新清单数据结构
 * 与客户端约定：以下字段都必须存在
 */
export interface UpdateManifest {
  /** 版本号，如 "0.1.2" */
  version: string;
  /** 下载路径（相对站点根），如 "/download/Recall-0.1.2-setup.exe" */
  downloadUrl: string;
  /** 安装包 SHA256（小写十六进制） */
  sha256: string;
  /** 更新日志（markdown 格式） */
  releaseNotes: string;
  /** 发布时间（ISO 8601，UTC，如 "2024-12-31T10:00:00Z"） */
  publishedAt: string;
}

/**
 * 从 R2 存储桶读取 manifest.json 并解析为 UpdateManifest
 *
 * @param bucket R2 存储桶（绑定名 RELEASES）
 * @returns 解析后的 manifest；若对象不存在或解析失败则返回 null
 */
export async function readManifest(
  bucket: R2Bucket
): Promise<UpdateManifest | null> {
  // R2 对象的 key 固定为 manifest.json
  const obj = await bucket.get("manifest.json");
  if (obj === null) {
    return null;
  }
  // 读取文本并解析 JSON
  const text = await obj.text();
  try {
    const data = JSON.parse(text) as Partial<UpdateManifest>;
    // 校验必需字段均存在且为字符串
    if (
      typeof data.version === "string" &&
      typeof data.downloadUrl === "string" &&
      typeof data.sha256 === "string" &&
      typeof data.releaseNotes === "string" &&
      typeof data.publishedAt === "string"
    ) {
      return data as UpdateManifest;
    }
    return null;
  } catch {
    return null;
  }
}
