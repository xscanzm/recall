import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstallationIdentityService } from "./InstallationIdentityService";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("InstallationIdentityService", () => {
  it("persists one random installation UUID across service instances", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-installation-"));
    created.push(dir);
    const first = new InstallationIdentityService(dir).getId();
    const second = new InstallationIdentityService(dir).getId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).toBe(first);
  });
});
