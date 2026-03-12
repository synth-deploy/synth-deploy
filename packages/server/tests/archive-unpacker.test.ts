import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import {
  unpackArchive,
  archiveFormat,
  formatExtractedFiles,
} from "../src/archive-unpacker.js";
import type { ArtifactInput } from "../src/artifact-analyzer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeZipBuffer(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.addFile(path, Buffer.from(content, "utf-8"));
  }
  return zip.toBuffer();
}

function makeArtifact(name: string): ArtifactInput {
  return { name, source: "test" };
}

// ---------------------------------------------------------------------------
// archiveFormat
// ---------------------------------------------------------------------------

describe("archiveFormat", () => {
  it("maps zip to zip", () => {
    expect(archiveFormat("zip", "bundle.zip")).toBe("zip");
  });

  it("maps nupkg to zip", () => {
    expect(archiveFormat("nupkg", "MyService.1.0.0.nupkg")).toBe("zip");
  });

  it("maps java-archive to zip", () => {
    expect(archiveFormat("java-archive", "app.jar")).toBe("zip");
  });

  it("maps python-package to zip", () => {
    expect(archiveFormat("python-package", "app-1.0.0-py3-none-any.whl")).toBe("zip");
  });

  it("maps .tar.gz tarball to tar-gz", () => {
    expect(archiveFormat("tarball", "release.tar.gz")).toBe("tar-gz");
  });

  it("maps .tgz tarball to tar-gz", () => {
    expect(archiveFormat("tarball", "release.tgz")).toBe("tar-gz");
  });

  it("maps bare .tar to tar", () => {
    expect(archiveFormat("tarball", "image.tar")).toBe("tar");
  });

  it("returns null for non-archive types", () => {
    expect(archiveFormat("dockerfile", "Dockerfile")).toBeNull();
    expect(archiveFormat("node-package", "package.json")).toBeNull();
    expect(archiveFormat("unknown", "mystery.dat")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ZIP unpacking
// ---------------------------------------------------------------------------

describe("unpackArchive — zip", () => {
  it("extracts markdown and yaml files", async () => {
    const buf = makeZipBuffer({
      "README.md": "# My Service\nDeploys to Kubernetes.",
      "helm/values.yaml": "replicaCount: 3\nimage: myapp:latest",
      "app.bin": "\x00\x01\x02\x03binary data",
    });

    const result = await unpackArchive(buf, "zip");
    const paths = result.files.map((f) => f.path);

    expect(paths).toContain("README.md");
    expect(paths).toContain("helm/values.yaml");
    expect(paths).not.toContain("app.bin");
  });

  it("extracts Dockerfile and shell scripts", async () => {
    const buf = makeZipBuffer({
      "Dockerfile": "FROM node:20-alpine\nEXPOSE 3000",
      "deploy.sh": "#!/bin/bash\ndocker build .",
    });

    const result = await unpackArchive(buf, "zip");
    const paths = result.files.map((f) => f.path);

    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("deploy.sh");
  });

  it("skips node_modules and .git paths", async () => {
    const buf = makeZipBuffer({
      "node_modules/express/README.md": "Express docs",
      ".git/config": "git config",
      "SYNTH.md": "deployment context",
    });

    const result = await unpackArchive(buf, "zip");
    const paths = result.files.map((f) => f.path);

    expect(paths).not.toContain("node_modules/express/README.md");
    expect(paths).not.toContain(".git/config");
    expect(paths).toContain("SYNTH.md");
  });

  it("counts skipped binary and filtered files", async () => {
    const buf = makeZipBuffer({
      "app.exe": "\x00\x00\x4D\x5A binary",
      "logo.png": "\x89PNG binary",
      "config.yaml": "key: value",
    });

    const result = await unpackArchive(buf, "zip");
    expect(result.files.length).toBe(1);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("returns empty result for corrupt buffer", async () => {
    const result = await unpackArchive(Buffer.from("not a zip"), "zip");
    expect(result.files).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it("preserves file content accurately", async () => {
    const content = "# Deploy Notes\n\nRun after database migration.\n";
    const buf = makeZipBuffer({ "NOTES.md": content });

    const result = await unpackArchive(buf, "zip");
    expect(result.files[0].content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// formatExtractedFiles
// ---------------------------------------------------------------------------

describe("formatExtractedFiles", () => {
  it("formats multiple files with separators", () => {
    const result = formatExtractedFiles({
      files: [
        { path: "README.md", content: "# Hello" },
        { path: "values.yaml", content: "replicas: 2" },
      ],
      skipped: 0,
    });

    expect(result).toContain("=== README.md ===");
    expect(result).toContain("# Hello");
    expect(result).toContain("=== values.yaml ===");
    expect(result).toContain("replicas: 2");
  });

  it("includes skipped file count when non-zero", () => {
    const result = formatExtractedFiles({ files: [], skipped: 3 });
    expect(result).toContain("(no readable text files found in archive)");
  });

  it("appends skip count when files also present", () => {
    const result = formatExtractedFiles({
      files: [{ path: "README.md", content: "hi" }],
      skipped: 5,
    });

    expect(result).toContain("5 binary or oversized files skipped");
  });

  it("returns no-files message when empty", () => {
    const result = formatExtractedFiles({ files: [], skipped: 0 });
    expect(result).toContain("no readable text files found");
  });
});
