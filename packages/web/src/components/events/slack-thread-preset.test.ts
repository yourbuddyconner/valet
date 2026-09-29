import { describe, expect, it } from "vitest";
import { parseSlackThreadLink } from "./slack-thread-preset";
describe("Slack thread preset", () => {
  it("extracts a parent permalink without broadening to its channel", () => {
    expect(parseSlackThreadLink("https://example.slack.com/archives/C123/p1790650000123456")).toEqual({ channel: "C123", threadTs: "1790650000.123456" });
  });
  it("uses the parent timestamp when the copied link points at a reply", () => {
    expect(parseSlackThreadLink("https://example.slack.com/archives/C123/p1790659999123456?thread_ts=1790650000.123456&cid=C123")).toEqual({ channel: "C123", threadTs: "1790650000.123456" });
  });
  it.each(["", "https://slack.com.evil.test/archives/C123/p1790650000123456", "http://example.slack.com/archives/C123/p1790650000123456", "https://example.slack.com/archives/C123", "https://example.slack.com/archives/C123/p1790650000123456?thread_ts=bad"])("rejects invalid link %s", (url) => expect(parseSlackThreadLink(url)).toBeNull());
});
