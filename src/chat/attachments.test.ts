import { describe, expect, it } from "vitest";
import {
  addAll,
  attachmentFooter,
  basename,
  extensionOf,
  formatBytes,
  hasImages,
  imagePayload,
  kindOf,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  removeAt,
  summarize,
  type Attachment,
} from "./attachments";

/**
 * The routing decision is the whole feature: an image has to go as bytes or the
 * model cannot see it, and a source file has to go as a path or it burns
 * context for nothing. Everything here guards that split, or guards the ways a
 * drop target quietly loses a file.
 */
const img = (path: string, size = 1000): Attachment => ({
  path,
  name: basename(path),
  kind: "image",
  size,
});
const file = (path: string, size = 1000): Attachment => ({
  path,
  name: basename(path),
  kind: "file",
  size,
});

describe("classifying what was attached", () => {
  it("routes images to the model and everything else to a path", () => {
    for (const p of ["/a/shot.png", "/a/photo.JPG", "/a/x.jpeg", "/a/y.gif", "/a/z.webp"]) {
      expect(kindOf(p)).toBe("image");
    }
    for (const p of ["/a/run.log", "/a/main.ts", "/a/paper.pdf", "/a/data.csv"]) {
      expect(kindOf(p)).toBe("file");
    }
  });

  it("treats an image format the agent cannot take as a file", () => {
    // A .tiff IS an image, and sending it would fail deeper down where the
    // error is worse. The path route still shows it to the agent.
    expect(kindOf("/a/scan.tiff")).toBe("file");
    expect(kindOf("/a/raw.heic")).toBe("file");
  });

  it("reads a dotfile as having no extension", () => {
    expect(extensionOf("/a/.env")).toBe("");
    expect(kindOf("/a/.env")).toBe("file");
  });

  it("handles names with dots and no extension", () => {
    expect(extensionOf("/a/my.notes.png")).toBe("png");
    expect(extensionOf("/a/Makefile")).toBe("");
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("/a/b/")).toBe("b");
  });
});

describe("adding to the list", () => {
  it("adds paths with their name and kind", () => {
    const { attachments } = addAll([], [{ path: "/a/shot.png", size: 42 }]);
    expect(attachments).toEqual([
      { path: "/a/shot.png", name: "shot.png", kind: "image", size: 42 },
    ]);
  });

  it("ignores a file that is already attached", () => {
    // Dropping twice is easy to do and two identical pills read as a bug.
    const first = addAll([], [{ path: "/a/x.png", size: 1 }]).attachments;
    const { attachments } = addAll(first, [{ path: "/a/x.png", size: 1 }]);
    expect(attachments).toHaveLength(1);
  });

  it("ignores duplicates within one drop", () => {
    const { attachments } = addAll(
      [],
      [
        { path: "/a/x.png", size: 1 },
        { path: "/a/x.png", size: 1 },
      ],
    );
    expect(attachments).toHaveLength(1);
  });

  it("rejects an oversized file out loud, with its size", () => {
    // Silently dropping it makes the drop target look broken.
    const { attachments, rejected } = addAll(
      [],
      [{ path: "/a/huge.png", size: MAX_ATTACHMENT_BYTES + 1 }],
    );
    expect(attachments).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].path).toBe("/a/huge.png");
    expect(rejected[0].reason).toContain("limit");
  });

  it("stops at the cap and says which ones did not make it", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) => ({
      path: `/a/f${i}.txt`,
      size: 1,
    }));
    const { attachments, rejected } = addAll([], many);
    expect(attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(rejected).toHaveLength(3);
  });

  it("keeps the ones that are fine when one is not", () => {
    const { attachments, rejected } = addAll(
      [],
      [
        { path: "/a/ok.png", size: 10 },
        { path: "/a/huge.bin", size: MAX_ATTACHMENT_BYTES + 1 },
        { path: "/a/also-ok.log", size: 10 },
      ],
    );
    expect(attachments.map((a) => a.name)).toEqual(["ok.png", "also-ok.log"]);
    expect(rejected).toHaveLength(1);
  });

  it("removes by path, leaving the rest in order", () => {
    const list = [file("/a/1.txt"), file("/a/2.txt"), file("/a/3.txt")];
    expect(removeAt(list, "/a/2.txt").map((a) => a.name)).toEqual(["1.txt", "3.txt"]);
  });
});

describe("the footer sent to the agent", () => {
  it("names files with absolute paths", () => {
    const out = attachmentFooter([file("/w/run.log")]);
    expect(out).toBe("The user attached this file. Read it before answering:\n- /w/run.log");
  });

  it("pluralises for several", () => {
    const out = attachmentFooter([file("/w/a.log"), file("/w/b.csv")]);
    expect(out).toContain("these files");
    expect(out).toContain("- /w/a.log");
    expect(out).toContain("- /w/b.csv");
  });

  it("leaves images out entirely", () => {
    // They arrive as pixels. Telling the agent to go and read the file would
    // send it to open something it has already been shown.
    expect(attachmentFooter([img("/w/shot.png")])).toBe("");
  });

  it("names only the files when both kinds are attached", () => {
    const out = attachmentFooter([img("/w/shot.png"), file("/w/run.log")]);
    expect(out).toContain("/w/run.log");
    expect(out).not.toContain("shot.png");
  });

  it("is empty with nothing attached, so nothing is appended", () => {
    expect(attachmentFooter([])).toBe("");
  });
});

describe("the image payload", () => {
  it("carries base64 and mime in the agent's shape", () => {
    const a: Attachment = { ...img("/w/s.png"), data: "AAAA", mimeType: "image/png" };
    expect(imagePayload([a])).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  });

  it("leaves out an image whose bytes never loaded", () => {
    // A half-formed image block is rejected by the provider, which would take
    // the whole turn down rather than just the picture.
    expect(imagePayload([img("/w/s.png")])).toEqual([]);
  });

  it("never includes a non-image", () => {
    const a: Attachment = { ...file("/w/run.log"), data: "AAAA", mimeType: "text/plain" };
    expect(imagePayload([a])).toEqual([]);
  });

  it("knows when a send needs a model that can see", () => {
    expect(hasImages([file("/w/a.log")])).toBe(false);
    expect(hasImages([file("/w/a.log"), img("/w/s.png")])).toBe(true);
    expect(hasImages([])).toBe(false);
  });
});

describe("summarising for a queued row", () => {
  it("names a single attachment", () => {
    expect(summarize([img("/w/shot.png")])).toBe("shot.png");
  });

  it("counts a mixture by kind", () => {
    expect(summarize([img("/a/1.png"), img("/a/2.png"), file("/a/x.log")])).toBe(
      "2 images, 1 file",
    );
  });

  it("is empty with nothing attached", () => {
    expect(summarize([])).toBe("");
  });
});

describe("sizes as shown on a pill", () => {
  it("scales the unit to the number", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
