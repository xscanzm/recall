import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateManifest } from "../generate-manifest";

describe("generateManifest", () => {
  let tempDir: string;
  let notesPath: string;
  let outputPath: string;
  let packagePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-manifest-"));
    notesPath = path.join(tempDir, "release-notes.md");
    outputPath = path.join(tempDir, "manifest.json");
    packagePath = path.join(tempDir, "package.json");
    fs.writeFileSync(notesPath, "# Recall 0.4.4\n\n- Test release\n");
    fs.writeFileSync(packagePath, JSON.stringify({ version: "0.4.4" }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a validated manifest with normalized values", () => {
    const manifest = generateManifest({
      version: "0.4.4",
      sha256: "A".repeat(64),
      notesPath,
      outputPath,
      packagePath,
      releaseTag: "v0.4.4",
      publishedAt: "2026-07-22T10:00:00Z",
    });

    expect(manifest).toEqual({
      version: "0.4.4",
      downloadUrl: "/download/Recall-0.4.4-setup.exe",
      sha256: "a".repeat(64),
      releaseNotes: "# Recall 0.4.4\n\n- Test release\n",
      publishedAt: "2026-07-22T10:00:00.000Z",
    });
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual(manifest);
  });

  it.each(["v0.4.4", "01.2.3", "1.2", "1.2.3-"])(
    "rejects invalid semantic version %s",
    (version) => {
      expect(() => generateManifest({
        version,
        sha256: "a".repeat(64),
        notesPath,
        outputPath,
        packagePath,
      })).toThrow(/semantic version/i);
    },
  );

  it("rejects malformed SHA256 and publishedAt values", () => {
    expect(() => generateManifest({
      version: "0.4.4",
      sha256: "abc123",
      notesPath,
      outputPath,
      packagePath,
    })).toThrow(/64 hexadecimal/i);

    expect(() => generateManifest({
      version: "0.4.4",
      sha256: "a".repeat(64),
      notesPath,
      outputPath,
      packagePath,
      publishedAt: "2026-02-30T10:00:00Z",
    })).toThrow(/publishedAt/i);
  });

  it("rejects package and release tag mismatches", () => {
    fs.writeFileSync(packagePath, JSON.stringify({ version: "0.4.5" }));
    expect(() => generateManifest({
      version: "0.4.4",
      sha256: "a".repeat(64),
      notesPath,
      outputPath,
      packagePath,
    })).toThrow(/does not match package\.json/i);

    fs.writeFileSync(packagePath, JSON.stringify({ version: "0.4.4" }));
    expect(() => generateManifest({
      version: "0.4.4",
      sha256: "a".repeat(64),
      notesPath,
      outputPath,
      packagePath,
      releaseTag: "v0.4.5",
    })).toThrow(/release tag/i);
  });

  it("requires non-empty release notes", () => {
    fs.writeFileSync(notesPath, "  \n");
    expect(() => generateManifest({
      version: "0.4.4",
      sha256: "a".repeat(64),
      notesPath,
      outputPath,
      packagePath,
    })).toThrow(/release notes file is empty/i);
  });
});
