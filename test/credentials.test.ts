import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCredentials, extractSid, loadCredentials, saveCredentials } from "../src/auth/credentials.js";

describe("extractSid", () => {
  const sid = "s%3AabcDEF123.sig%2Bnature";

  it("accepts a bare value", () => {
    expect(extractSid(`  ${sid}\n`)).toBe(sid);
    expect(extractSid("s:decoded.value")).toBe("s:decoded.value");
  });

  it("accepts a Cookie header", () => {
    expect(extractSid(`Cookie: ajs_id=1; substack.sid=${sid}; substack.lli=1`)).toBe(sid);
  });

  it("accepts a Cookie-Editor JSON export", () => {
    const json = JSON.stringify([
      { name: "substack.lli", value: "1" },
      { name: "substack.sid", value: sid, domain: ".substack.com" },
    ]);
    expect(extractSid(json)).toBe(sid);
  });

  it("accepts a cookies.txt export", () => {
    const txt = `# Netscape HTTP Cookie File\n.substack.com\tTRUE\t/\tTRUE\t1893456000\tsubstack.sid\t${sid}\n`;
    expect(extractSid(txt)).toBe(sid);
  });

  it("rejects things that aren't a session", () => {
    expect(extractSid("")).toBeNull();
    expect(extractSid("hello world")).toBeNull();
    expect(extractSid('[{"name":"other","value":"x"}]')).toBeNull();
  });
});

describe("credential store", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "substack-reader-"));
    process.env.SUBSTACK_READER_HOME = dir;
    delete process.env.SUBSTACK_SID;
    delete process.env.SUBSTACK_COOKIE;
    delete process.env.SUBSTACK_COOKIES_PATH;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns null when nothing is configured", async () => {
    expect(await loadCredentials()).toBeNull();
  });

  it("saves with owner-only permissions and loads back", async () => {
    const file = await saveCredentials({ sid: "s%3Aone", user: { id: 7, handle: "me" } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const creds = await loadCredentials();
    expect(creds).toMatchObject({ sid: "s%3Aone", source: "auth-file", user: { id: 7 } });
    expect(await clearCredentials()).toBe(true);
    expect(await loadCredentials()).toBeNull();
  });

  it("env var beats the saved file", async () => {
    await saveCredentials({ sid: "s%3Afile" });
    process.env.SUBSTACK_SID = "s%3Aenv";
    expect(await loadCredentials()).toMatchObject({ sid: "s%3Aenv", source: "env" });
  });

  it("falls back to the Python version's cookies.json", async () => {
    await writeFile(join(dir, "cookies.json"), JSON.stringify([{ name: "substack.sid", value: "s%3Alegacy" }]));
    expect(await loadCredentials()).toMatchObject({ sid: "s%3Alegacy", source: "legacy-cookies" });
    // And never writes to it.
    expect(JSON.parse(await readFile(join(dir, "cookies.json"), "utf8"))).toHaveLength(1);
  });
});
