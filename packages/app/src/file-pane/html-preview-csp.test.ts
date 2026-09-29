import { describe, expect, it } from "vitest";
import { withPreviewCsp } from "@/file-pane/html-preview-csp";

function previewPolicy(document: string): Map<string, string[]> {
  const content = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(document);
  if (!content) throw new Error("The preview document carries no policy.");
  return new Map(
    content[1].split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe("withPreviewCsp", () => {
  it("places the policy before the complete source document", () => {
    const source =
      " <!-- untrusted --!><!doctype html \"'><script>location='https://example.com'</script>";
    const output = withPreviewCsp(source);

    expect(output).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/);
    expect(output.endsWith(source)).toBe(true);
    expect(output.indexOf("Content-Security-Policy")).toBeLessThan(output.indexOf("<script>"));
  });

  it("keeps the original document intact", () => {
    const source = "<!doctype html><html><head></head><body><h1>Visual plan</h1></body></html>";

    expect(withPreviewCsp(source)).toContain(source);
  });

  it("drops a leading BOM before appending the source", () => {
    const output = withPreviewCsp("﻿<!doctype html><h1>Plan</h1>");

    expect(output.includes("﻿")).toBe(false);
    expect(output).toContain("<!doctype html><h1>Plan</h1>");
  });

  it("lets a page load and call HTTPS hosts", () => {
    const policy = previewPolicy(withPreviewCsp("<h1>Plan</h1>"));

    expect(policy.get("script-src")).toEqual(
      expect.arrayContaining(["'unsafe-inline'", "'unsafe-eval'", "https:"]),
    );
    expect(policy.get("style-src")).toEqual(expect.arrayContaining(["'unsafe-inline'", "https:"]));
    for (const directive of ["img-src", "font-src", "media-src", "frame-src", "form-action"]) {
      expect(policy.get(directive)).toContain("https:");
    }
    expect(policy.get("connect-src")).toEqual(expect.arrayContaining(["https:", "wss:"]));
  });

  it("keeps plaintext hosts, base rewrites, and plugins out", () => {
    const policy = previewPolicy(withPreviewCsp("<h1>Plan</h1>"));

    expect(policy.get("default-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    for (const [directive, sources] of policy) {
      for (const source of sources) {
        expect(`${directive} ${source}`).not.toMatch(/ (http|ws):$|\*|localhost|127\.0\.0\.1/);
      }
    }
  });

  it("handles pathological source without parsing it", () => {
    const source = `${"<!--".repeat(10_000)}${'"'.repeat(10_000)}<html></html>`;

    expect(withPreviewCsp(source).endsWith(source)).toBe(true);
  });
});
