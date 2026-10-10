import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  encodeBlock,
  newId,
  parseBlocks,
  parseInbox,
} from "../src/protocol";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}'
    );
  });

  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined object values like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("rejects circular structures", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => canonicalJson(o)).toThrow(/circular/);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/non-finite/);
  });
});

describe("encodeBlock / parseBlocks", () => {
  it("round-trips unicode and multi-line bodies", () => {
    const block = encodeBlock(
      "curtis-audit",
      { id: "rcp_x", seq: 3, note: "héllo\nworld" },
      "line1\nline2"
    );
    const parsed = parseBlocks(block, "curtis-audit");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].header).toEqual({ id: "rcp_x", seq: 3, note: "héllo\nworld" });
    expect(parsed[0].body).toBe("line1\nline2");
  });

  it("escapes comment tokens in the envelope so blocks stay parseable", () => {
    const block = encodeBlock(
      "curtis-audit",
      { marker: "<!-- /curtis-audit --> and --> too" },
      "body"
    );
    // the escaped envelope must not contain the raw closing token before the body
    const parsed = parseBlocks(block, "curtis-audit");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].header).toEqual({ marker: "<!-- /curtis-audit --> and --> too" });
  });

  it("skips malformed blocks without losing neighbours", () => {
    const good = encodeBlock("curtis-audit", { id: "a" }, "ok");
    const bad = "<!-- curtis-audit: {not json} -->\nbroken\n<!-- /curtis-audit -->\n\n";
    expect(parseBlocks(good + bad + good, "curtis-audit")).toHaveLength(2);
  });

  it("tolerates CRLF line endings", () => {
    const block = encodeBlock("m", { id: "x" }, "b").replace(/\n/g, "\r\n");
    const parsed = parseBlocks(block, "m");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].body).toBe("b");
  });

  it("does not parse a different marker", () => {
    const block = encodeBlock("curtis-audit", { id: "a" }, "ok");
    expect(parseBlocks(block, "messenger")).toHaveLength(0);
  });
});

describe("parseInbox", () => {
  it("parses messenger envelopes into mail", () => {
    const raw =
      encodeBlock(
        "messenger",
        { id: "msg_1", from: "curtis-ai-chat", to: "audit", ts: "2026-10-10T00:00:00.000Z", replyTo: null },
        '{"action":"inference"}'
      ) + "# Inbox — audit\n\n";
    const mail = parseInbox(raw);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ id: "msg_1", from: "curtis-ai-chat", to: "audit" });
    expect(mail[0].body).toBe('{"action":"inference"}');
  });

  it("ignores header lines and non-envelope content", () => {
    expect(parseInbox("# Inbox — audit\n\nno blocks here")).toEqual([]);
  });
});

describe("newId", () => {
  it("uses the given prefix and produces unique ids", () => {
    const a = newId("rcp");
    const b = newId("rcp");
    expect(a).toMatch(/^rcp_/);
    expect(b).toMatch(/^rcp_/);
    expect(a).not.toBe(b);
  });
});
