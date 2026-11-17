import { describe, expect, it } from "vitest";
import { dayName, digestHtml, inert } from "../src/digest.js";

describe("inert", () => {
  it("keeps the words but leaves no mention, link or markup", () => {
    const text = inert("ping @{7} and @everyone: https://evil.test, www.evil.test, me@evil.test <b>bold</b> & co");
    expect(text).not.toMatch(/@\{/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/www\./i);
    expect(text).not.toMatch(/@[\w-]/);
    expect(text).not.toContain("<b>");
    expect(text).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; co");
    expect(text.replace(/​/g, "")).toBe("ping @{7} and @everyone: https://evil.test, www.evil.test, me@evil.test &lt;b&gt;bold&lt;/b&gt; &amp; co");
  });

  it("folds a multi-line reply onto one line", () => {
    expect(inert("  done X\n\nnext Y  ")).toBe("done X next Y");
  });
});

describe("digestHtml", () => {
  const options = { localDate: "2026-11-16", threadUrl: "https://sabha.test/messages/1" };

  it("heads the digest with the day and a link to the thread", () => {
    expect(dayName("2026-11-16")).toBe("Monday 16 November");
    expect(digestHtml([], options)).toContain('<a href="https://sabha.test/messages/1">Read the thread</a>');
  });

  it("says so when no one replied", () => {
    expect(digestHtml([], options)).toContain("No one posted an update today.");
  });

  it("gives one line per person, quoting each reply in order", () => {
    const html = digestHtml([{ name: "Asha", replies: ["one", "two"] }, { name: "Ben", replies: ["three"] }], options);
    expect(html).toContain("<strong>Asha</strong>: “one” “two”<br><strong>Ben</strong>: “three”");
  });
});
