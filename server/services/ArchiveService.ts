import { spawn, spawnSync } from "node:child_process";
import pathTo7zip from "7zip-bin";
import fs from "fs-extra";
import path from "node:path";
import { logger } from "../logger.js";

const bundled7zaPath = pathTo7zip.path7za;

/**
 * The 7zip-bin npm package only ships a glibc-linked `7za` binary, which
 * can't run at all on musl/Alpine images (our production Docker image)
 * without a compat shim, and even where it does run, no 7-Zip build reads
 * RAR archives (RAR extraction has always required the separate, RARLab-
 * licensed `unrar`/`unrar-free` tool). We prefer whatever 7-Zip and unrar
 * binaries are actually present on the host/image (installed in the
 * Dockerfile) and only fall back to the bundled binary for local dev on
 * glibc systems where it works out of the box.
 */
function findOnPath(bin: string): string | undefined {
  const result = spawnSync("which", [bin], { encoding: "utf-8" });
  if (result.status === 0) {
    const found = result.stdout.trim();
    if (found) return found;
  }
  return undefined;
}

function resolveSevenZipBinary(): string {
  return findOnPath("7zz") ?? findOnPath("7z") ?? bundled7zaPath;
}

function resolveUnrarBinary(): string | undefined {
  return findOnPath("unrar") ?? findOnPath("unrar-free");
}

function runProcess(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(bin)} exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

export class ArchiveService {
  private readonly sevenZipBin = resolveSevenZipBinary();
  private readonly unrarBin = resolveUnrarBinary();

  /**
   * Extracts an archive to a specified output directory.
   * @param filePath Full path to the archive file.
   * @param outputDir Directory where contents should be extracted.
   */
  async extract(filePath: string, outputDir: string): Promise<void> {
    logger.debug({ filePath, outputDir }, "Extracting archive");

    await fs.ensureDir(outputDir);

    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".rar") {
      if (!this.unrarBin) {
        throw new Error(
          "No unrar binary available to extract RAR archives (install 'unrar' or 'unrar-free')"
        );
      }
      // Trailing separator tells unrar the destination is a directory.
      await runProcess(this.unrarBin, ["x", "-o+", "-y", filePath, outputDir + path.sep]);
    } else {
      await runProcess(this.sevenZipBin, ["x", filePath, "-o" + outputDir, "-y", "-bb1", "-r"]);
    }

    logger.debug({ filePath, outputDir }, "Extraction complete");
  }

  isArchive(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return [".zip", ".7z", ".rar", ".gz", ".tar", ".iso", ".bz2"].includes(ext);
  }
}
