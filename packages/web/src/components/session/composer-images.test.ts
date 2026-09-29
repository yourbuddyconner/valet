// @vitest-environment jsdom
/**
 * Intake rules for composer images. Every refusal must name the limit and
 * the action that fixes it — a bare "not allowed" leaves the user with no
 * next move.
 */
import { describe, expect, it } from "vitest";
import {
  acceptImages,
  filesFromClipboard,
  filesFromList,
  formatSize,
  readFailure,
  readImage,
  toPromptAttachments,
  transferHasFiles,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  type ComposerImage,
} from "./composer-images";

/** Under the 5 MB per-image limit, so only the total budget can refuse it. */
const FOUR_MB = 4 * 1024 * 1024;

function meta(name: string, type: string, size: number) {
  return { name, type, size };
}

function held(id: string, bytes: number): ComposerImage {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    bytes,
    dataUrl: "data:image/png;base64,AAAA",
  };
}

describe("acceptImages", () => {
  it("accepts the four types the models read", () => {
    const incoming = [
      meta("a.png", "image/png", 10),
      meta("b.jpg", "image/jpeg", 10),
      meta("c.gif", "image/gif", 10),
      meta("d.webp", "image/webp", 10),
    ];
    const { accepted, rejected } = acceptImages([], incoming);
    expect(accepted).toHaveLength(4);
    expect(rejected).toEqual([]);
  });

  it("refuses an unsupported type and names the types that work", () => {
    const { accepted, rejected } = acceptImages([], [meta("holiday.heic", "image/heic", 10)]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      "holiday.heic is not a supported image. Attach a PNG, JPEG, GIF, or WebP image.",
    ]);
  });

  it("refuses a non-image file by name instead of ignoring it", () => {
    const { rejected } = acceptImages([], [meta("notes.pdf", "application/pdf", 10)]);
    expect(rejected[0]).toContain("notes.pdf");
  });

  it("refuses an oversized image, naming its size, the limit, and the fix", () => {
    const { accepted, rejected } = acceptImages(
      [],
      [meta("screenshot.png", "image/png", MAX_IMAGE_BYTES + 1)],
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]).toContain("screenshot.png");
    expect(rejected[0]).toContain("The limit is 5 MB for one image.");
    expect(rejected[0]).toContain("Resize the image, then attach it again.");
  });

  it("accepts an image exactly on the per-image limit", () => {
    const { accepted } = acceptImages([], [meta("edge.png", "image/png", MAX_IMAGE_BYTES)]);
    expect(accepted).toHaveLength(1);
  });

  it("counts images already held against the count limit", () => {
    const current = Array.from({ length: MAX_IMAGES }, (_, i) => held(`held-${i}`, 10));
    const { accepted, rejected } = acceptImages(current, [meta("one-more.png", "image/png", 10)]);
    expect(accepted).toEqual([]);
    expect(rejected[0]).toContain(`The limit is ${MAX_IMAGES} images for one message.`);
    expect(rejected[0]).toContain("Remove an image, then attach it again.");
  });

  it("keeps the files before a count crossing and refuses the rest by name", () => {
    const current = [held("held-0", 10)];
    const incoming = Array.from({ length: MAX_IMAGES }, (_, i) =>
      meta(`new-${i}.png`, "image/png", 10),
    );
    const { accepted, rejected } = acceptImages(current, incoming);
    expect(accepted.map((f) => f.name)).toEqual(Array.from({ length: MAX_IMAGES - 1 }, (_, i) => `new-${i}.png`));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain(`new-${MAX_IMAGES - 1}.png`);
  });

  it("refuses a file that crosses the total budget and names the total limit", () => {
    // Three held images of 4 MB leave 3 MB of the 15 MB budget.
    const current = [held("held-0", FOUR_MB), held("held-1", FOUR_MB), held("held-2", FOUR_MB)];
    const { accepted, rejected } = acceptImages(current, [meta("big.png", "image/png", FOUR_MB)]);
    expect(accepted).toEqual([]);
    expect(rejected[0]).toContain("The limit is 15 MB for all images");
    expect(rejected[0]).toContain("Remove an image, then attach it again.");
  });

  it("accumulates the budget across one batch", () => {
    // Four 4 MB images cross the 15 MB budget; three do not.
    expect(FOUR_MB * 4).toBeGreaterThan(MAX_TOTAL_BYTES);
    const { accepted, rejected } = acceptImages(
      [],
      [
        meta("a.png", "image/png", FOUR_MB),
        meta("b.png", "image/png", FOUR_MB),
        meta("c.png", "image/png", FOUR_MB),
        meta("d.png", "image/png", FOUR_MB),
      ],
    );
    expect(accepted.map((f) => f.name)).toEqual(["a.png", "b.png", "c.png"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("d.png");
  });
});

describe("formatSize", () => {
  it("keeps limits whole and file sizes precise", () => {
    expect(formatSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatSize(Math.round(1.5 * 1024 * 1024))).toBe("1.5 MB");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(512)).toBe("512 bytes");
  });
});

describe("toPromptAttachments", () => {
  it("builds the send payload from the held images", () => {
    const images: ComposerImage[] = [
      {
        id: "img-1",
        name: "chart.png",
        mimeType: "image/png",
        bytes: 120,
        dataUrl: "data:image/png;base64,QUJD",
      },
    ];
    expect(toPromptAttachments(images)).toEqual([
      {
        kind: "image",
        url: "data:image/png;base64,QUJD",
        mimeType: "image/png",
        name: "chart.png",
      },
    ]);
  });
});

describe("filesFromClipboard", () => {
  it("takes file items and skips string items, so a text paste stays text", () => {
    const file = new File(["x"], "pasted.png", { type: "image/png" });
    const items = [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => file },
    ];
    expect(filesFromClipboard(items)).toEqual([file]);
  });

  it("returns nothing when the clipboard has no items", () => {
    expect(filesFromClipboard(undefined)).toEqual([]);
  });
});

describe("filesFromList", () => {
  it("passes every file through, so a wrong file still earns a message", () => {
    const png = new File(["x"], "a.png", { type: "image/png" });
    const pdf = new File(["x"], "b.pdf", { type: "application/pdf" });
    expect(filesFromList([png, pdf])).toEqual([png, pdf]);
    expect(filesFromList(null)).toEqual([]);
  });
});

describe("transferHasFiles", () => {
  it("claims a drag of files and ignores a drag of text", () => {
    expect(transferHasFiles(["Files"])).toBe(true);
    expect(transferHasFiles(["text/plain"])).toBe(false);
    expect(transferHasFiles(undefined)).toBe(false);
  });
});

describe("readImage", () => {
  it("reads a file into a data URL with its name, type, and size", async () => {
    const file = new File(["hello"], "note.png", { type: "image/png" });
    const image = await readImage(file);
    expect(image.name).toBe("note.png");
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes).toBe(file.size);
    expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(image.id.length).toBeGreaterThan(0);
  });

  it("gives every image its own id", async () => {
    const first = await readImage(new File(["a"], "a.png", { type: "image/png" }));
    const second = await readImage(new File(["b"], "b.png", { type: "image/png" }));
    expect(first.id).not.toBe(second.id);
  });
});

describe("readFailure", () => {
  it("names the file and the action that fixes it", () => {
    expect(readFailure("broken.png")).toBe("broken.png could not be read. Attach the file again.");
  });
});
