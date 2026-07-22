import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../../shared/constants";

const INSTALLATION_ID_FILENAME = "installation-id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InstallationIdentityService {
  private installationId: string | null = null;

  constructor(private readonly userDataPath: string) {}

  getId(): string {
    if (this.installationId) return this.installationId;

    const dataDir = path.join(this.userDataPath, DATA_DIR);
    const filePath = path.join(dataDir, INSTALLATION_ID_FILENAME);
    try {
      const existing = fs.readFileSync(filePath, "utf-8").trim();
      if (UUID_PATTERN.test(existing)) {
        this.installationId = existing;
        return existing;
      }
    } catch {
      // 首次安装或文件损坏时重新生成随机安装标识。
    }

    fs.mkdirSync(dataDir, { recursive: true });
    const created = randomUUID();
    fs.writeFileSync(filePath, created, { encoding: "utf-8", mode: 0o600 });
    this.installationId = created;
    return created;
  }
}
