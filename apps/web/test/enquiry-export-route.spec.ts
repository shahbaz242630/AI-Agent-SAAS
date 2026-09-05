import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The CSV download's proxy (2026-09-05).
 *
 * ⚠️ THE ROUTE CANNOT BE RUN HERE — it needs a session and an api — so the one
 * property that bit is asserted at the source. The api sends the file with a
 * UTF-8 byte-order mark first, because without it Excel on Windows opens the
 * file in the machine's legacy code page. The proxy's first version read the
 * body with `text()`, which decodes it and, by the WHATWG rule, drops that
 * mark on the floor; the founder's first two downloads had no mark. Bytes go
 * through as bytes.
 */
describe("the enquiry CSV proxy", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../src/app/app/lead-follow-up/enquiries/export/route.ts", import.meta.url),
    ),
    "utf8",
  );

  it("passes the api's bytes through untouched, never as decoded text", () => {
    expect(source).toContain("upstream.arrayBuffer()");
    expect(source).not.toContain("upstream.text()");
  });

  it("keeps the api's file name and type on the download", () => {
    expect(source).toContain('upstream.headers.get("content-disposition")');
    expect(source).toContain('upstream.headers.get("content-type")');
  });
});
