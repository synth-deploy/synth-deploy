import AdmZip from "adm-zip";
import tarStream from "tar-stream";
import zlib from "node:zlib";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedFile {
  path: string;
  content: string;
}

export interface UnpackResult {
  files: ExtractedFile[];
  skipped: number;
}

// ---------------------------------------------------------------------------
// Text file detection
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  // Docs / context
  ".md", ".txt", ".rst", ".adoc",
  // Config / manifests
  ".yaml", ".yml", ".json", ".toml", ".ini", ".conf", ".config",
  ".properties", ".env", ".envrc",
  // Infrastructure / IaC
  ".tf", ".tfvars", ".hcl", ".bicep",
  // Build / packaging
  ".xml", ".gradle", ".gradle.kts", ".nuspec", ".pom",
  ".csproj", ".fsproj", ".vbproj", ".sln",
  ".gemspec", ".podspec", ".lock",
  // Scripts
  ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".psm1", ".psd1", ".cmd", ".bat",
  // Source (for deploy scripts, Lambdas, etc.)
  ".py", ".rb", ".js", ".ts", ".go", ".rs", ".java", ".cs",
  // Web / templates
  ".html", ".htm", ".jinja", ".j2", ".tpl",
]);

const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "procfile", "brewfile", "gemfile",
  "rakefile", "vagrantfile", "jenkinsfile", "capfile", "guardfile",
  "podfile", "appfile", "fastfile",
  "readme", "license", "changelog", "authors", "contributors", "notice",
]);

const SKIP_PATH_SEGMENTS = new Set([
  "node_modules", ".git", "__pycache__", ".idea", ".vscode",
  "vendor", "dist", "build", "target", "bin", "obj",
]);

const SKIP_EXTENSIONS = new Set([
  ".pyc", ".class", ".o", ".a", ".so", ".dll", ".exe",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".jar", ".war", ".ear", ".whl", ".nupkg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
]);

const MAX_FILE_BYTES = 50 * 1024;   // 50KB per file
const MAX_TOTAL_BYTES = 300 * 1024; // 300KB total
const MAX_FILES = 50;

function shouldExtract(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const segments = lower.split("/");
  const filename = segments[segments.length - 1];

  // Skip directories and hidden files at root
  if (!filename || filename.startsWith(".")) return false;

  // Skip paths with unwanted segments
  for (const seg of segments.slice(0, -1)) {
    if (SKIP_PATH_SEGMENTS.has(seg)) return false;
  }

  const dotIdx = filename.lastIndexOf(".");
  const ext = dotIdx !== -1 ? filename.slice(dotIdx) : "";

  if (SKIP_EXTENSIONS.has(ext)) return false;
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (TEXT_FILENAMES.has(filename)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// ZIP unpacker (zip, nupkg, jar, war, ear, whl, vsix, apk)
// ---------------------------------------------------------------------------

function unpackZip(buffer: Buffer): UnpackResult {
  const files: ExtractedFile[] = [];
  let skipped = 0;
  let totalBytes = 0;

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return { files: [], skipped: 0 };
  }

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (files.length >= MAX_FILES) { skipped++; continue; }
    if (!shouldExtract(entry.entryName)) { skipped++; continue; }
    if (entry.header.size > MAX_FILE_BYTES) { skipped++; continue; }
    if (totalBytes + entry.header.size > MAX_TOTAL_BYTES) { skipped++; continue; }

    try {
      const content = entry.getData().toString("utf-8");
      // Reject if it looks binary (high proportion of null bytes / non-printable)
      if (looksLikeBinary(content)) { skipped++; continue; }
      files.push({ path: entry.entryName, content });
      totalBytes += entry.header.size;
    } catch {
      skipped++;
    }
  }

  return { files, skipped };
}

// ---------------------------------------------------------------------------
// TAR unpacker (tar, tar.gz / tgz)
// ---------------------------------------------------------------------------

function unpackTar(buffer: Buffer, gunzip: boolean): Promise<UnpackResult> {
  return new Promise((resolve) => {
    const files: ExtractedFile[] = [];
    let skipped = 0;
    let totalBytes = 0;

    const extract = tarStream.extract();

    extract.on("entry", (header, stream, next) => {
      if (
        header.type !== "file" ||
        files.length >= MAX_FILES ||
        !shouldExtract(header.name) ||
        (header.size ?? 0) > MAX_FILE_BYTES ||
        totalBytes + (header.size ?? 0) > MAX_TOTAL_BYTES
      ) {
        if (header.type === "file") skipped++;
        stream.resume();
        next();
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;

      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= MAX_FILE_BYTES) chunks.push(chunk);
      });

      stream.on("end", () => {
        try {
          const content = Buffer.concat(chunks).toString("utf-8");
          if (!looksLikeBinary(content)) {
            files.push({ path: header.name, content });
            totalBytes += bytes;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
        next();
      });

      stream.on("error", () => { skipped++; next(); });
    });

    extract.on("finish", () => resolve({ files, skipped }));
    extract.on("error", () => resolve({ files, skipped }));

    const readable = Readable.from(buffer);
    if (gunzip) {
      readable.pipe(zlib.createGunzip()).pipe(extract);
    } else {
      readable.pipe(extract);
    }
  });
}

// ---------------------------------------------------------------------------
// Binary detection heuristic
// ---------------------------------------------------------------------------

function looksLikeBinary(text: string): boolean {
  // Sample the first 1KB — if >10% non-printable chars, treat as binary
  const sample = text.slice(0, 1024);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32) || code === 127) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ArchiveFormat = "zip" | "tar" | "tar-gz";

/**
 * Map artifact type string to archive format, if applicable.
 * Returns null for non-archive types.
 */
export function archiveFormat(artifactType: string, artifactName: string): ArchiveFormat | null {
  switch (artifactType) {
    case "zip":
    case "nupkg":
    case "java-archive":
    case "python-package":
      return "zip";
    case "tarball": {
      const name = artifactName.toLowerCase();
      if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return "tar-gz";
      return "tar";
    }
    default:
      return null;
  }
}

/**
 * Unpack an archive buffer and extract readable text files.
 * Returns an empty result for unrecognized or corrupt archives.
 */
export async function unpackArchive(
  buffer: Buffer,
  format: ArchiveFormat,
): Promise<UnpackResult> {
  switch (format) {
    case "zip":
      return unpackZip(buffer);
    case "tar":
      return unpackTar(buffer, false);
    case "tar-gz":
      return unpackTar(buffer, true);
  }
}

/**
 * Format extracted files as a text block suitable for inclusion in an LLM prompt.
 */
export function formatExtractedFiles(result: UnpackResult): string {
  if (result.files.length === 0) {
    return "(no readable text files found in archive)";
  }

  const sections = result.files.map(
    (f) => `=== ${f.path} ===\n${f.content.trimEnd()}`,
  );

  const footer = result.skipped > 0
    ? `\n(${result.skipped} binary or oversized file${result.skipped === 1 ? "" : "s"} skipped)`
    : "";

  return sections.join("\n\n") + footer;
}
