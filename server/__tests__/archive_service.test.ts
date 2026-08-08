import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, spawnSyncMock, ensureDirMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  ensureDirMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
  default: {
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  },
}));

vi.mock("fs-extra", () => ({
  default: {
    ensureDir: ensureDirMock,
  },
}));

vi.mock("7zip-bin", () => ({
  default: {
    path7za: "/mock/bundled/7za",
  },
}));

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

// Every spawn() call gets a timeout/killSignal safety net regardless of tool.
const spawnOptions = expect.objectContaining({
  timeout: expect.any(Number),
  killSignal: "SIGKILL",
});

/** No system 7zz/7z/unrar on PATH — matches a bare glibc-only dev box. */
function mockNothingOnPath() {
  spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
}

/** `which <bin>` succeeds only for the given binary names. */
function mockOnPath(found: Record<string, string>) {
  spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
    const bin = args[0];
    if (found[bin]) return { status: 0, stdout: found[bin] + "\n" };
    return { status: 1, stdout: "" };
  });
}

describe("ArchiveService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isArchive", () => {
    it("detects supported archive extensions", async () => {
      mockNothingOnPath();
      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();

      expect(service.isArchive("file.ZIP")).toBe(true);
      expect(service.isArchive("file.7z")).toBe(true);
      expect(service.isArchive("file.iso")).toBe(true);
      expect(service.isArchive("file.rar")).toBe(true);
      expect(service.isArchive("file.txt")).toBe(false);
    });

    it("returns false for unsupported extensions", async () => {
      mockNothingOnPath();
      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();

      expect(service.isArchive("installer.exe")).toBe(false);
      expect(service.isArchive("image.png")).toBe(false);
      expect(service.isArchive("data.bin")).toBe(false);
    });
  });

  describe("extract — non-RAR archives", () => {
    it("falls back to the bundled 7za binary when no system 7zip is on PATH", async () => {
      mockNothingOnPath();
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();
      const resultPromise = service.extract("/downloads/game.zip", "/tmp/out");

      await new Promise((resolve) => setTimeout(resolve, 0));
      child.emit("close", 0);

      await expect(resultPromise).resolves.toBeUndefined();
      expect(ensureDirMock).toHaveBeenCalledWith("/tmp/out");
      expect(spawnMock).toHaveBeenCalledWith(
        "/mock/bundled/7za",
        expect.arrayContaining(["x", "/downloads/game.zip", "-o/tmp/out"]),
        spawnOptions
      );
    });

    it("prefers a system 7zz binary when present on PATH", async () => {
      mockOnPath({ "7zz": "/usr/bin/7zz" });
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();
      const resultPromise = service.extract("/downloads/game.7z", "/tmp/out");

      await new Promise((resolve) => setTimeout(resolve, 0));
      child.emit("close", 0);

      await resultPromise;
      expect(spawnMock).toHaveBeenCalledWith("/usr/bin/7zz", expect.any(Array), spawnOptions);
    });

    it("rejects with stderr output when the extractor exits non-zero", async () => {
      mockNothingOnPath();
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();
      const resultPromise = service.extract("/downloads/corrupt.zip", "/tmp/out");

      await new Promise((resolve) => setTimeout(resolve, 0));
      child.stderr.emit("data", Buffer.from("cannot open file as archive"));
      child.emit("close", 2);

      await expect(resultPromise).rejects.toThrow(/exited with code 2/);
      await expect(resultPromise).rejects.toThrow(/cannot open file as archive/);
    });

    it("rejects with a timeout hint when the process is killed by signal", async () => {
      mockNothingOnPath();
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();
      const resultPromise = service.extract("/downloads/stalled.zip", "/tmp/out");

      await new Promise((resolve) => setTimeout(resolve, 0));
      // Node reports code=null once a spawn() timeout kills the child.
      child.emit("close", null, "SIGKILL");

      await expect(resultPromise).rejects.toThrow(/killed by signal SIGKILL/);
    });

    it("drains stdout instead of leaving it unread", async () => {
      mockNothingOnPath();
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();
      const resultPromise = service.extract("/downloads/game.zip", "/tmp/out");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
      child.stdout.emit("data", Buffer.from("42% complete\n"));
      child.emit("close", 0);

      await expect(resultPromise).resolves.toBeUndefined();
    });

    it("rejects when the binary itself fails to spawn", async () => {
      mockNothingOnPath();
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();
      const resultPromise = service.extract("/downloads/game.zip", "/tmp/out");

      await new Promise((resolve) => setTimeout(resolve, 0));
      child.emit("error", new Error("ENOENT"));

      await expect(resultPromise).rejects.toThrow("ENOENT");
    });
  });

  describe("extract — RAR archives", () => {
    it("routes .rar files to unrar when present on PATH", async () => {
      mockOnPath({ unrar: "/usr/local/bin/unrar" });
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();
      const resultPromise = service.extract("/downloads/game.rar", "/tmp/out");

      await new Promise((resolve) => setTimeout(resolve, 0));
      child.emit("close", 0);

      await resultPromise;
      expect(spawnMock).toHaveBeenCalledWith(
        "/usr/local/bin/unrar",
        expect.arrayContaining(["x", "-o+", "-y", "-inul", "/downloads/game.rar"]),
        spawnOptions
      );
      // 7zip binaries are never invoked for RAR — they can't read the format.
      expect(spawnMock).not.toHaveBeenCalledWith("/mock/bundled/7za", expect.any(Array));
    });

    it("falls back to unrar-free when unrar is unavailable", async () => {
      mockOnPath({ "unrar-free": "/usr/bin/unrar-free" });
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();
      const resultPromise = service.extract("/downloads/game.rar", "/tmp/out");

      await new Promise((resolve) => setTimeout(resolve, 0));
      child.emit("close", 0);

      await resultPromise;
      expect(spawnMock).toHaveBeenCalledWith(
        "/usr/bin/unrar-free",
        expect.any(Array),
        spawnOptions
      );
    });

    it("throws immediately when no RAR-capable tool is installed", async () => {
      mockNothingOnPath();

      const { ArchiveService } = await import("../services/ArchiveService.js");
      const service = new ArchiveService();

      await expect(service.extract("/downloads/game.rar", "/tmp/out")).rejects.toThrow(
        /no unrar binary/i
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});
