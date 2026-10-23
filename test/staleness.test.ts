// E16 (Sprint 10): how fresh each pack is.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAll, checkPack, hashFile, hashFolder } from "../src/staleness.ts";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "stale-")); }
function put(file: string, text: string | Buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

test("staleness: the same hashes as tools/staleness.py", () => {
  const d = tmp();
  put(path.join(d, "notes", "a.md"), "# A\nline\n");
  put(path.join(d, "notes", "sub", "b.md"), Buffer.from("b\r\n"));
  put(path.join(d, "notes", "skip.txt"), "x");
  put(path.join(d, "notes", ".hidden.md"), "hidden");
  put(path.join(d, "notes", ".obsidian", "x.md"), "hidden");
  assert.equal(hashFolder(path.join(d, "notes")), "8b961b412bb167e7");
  assert.equal(hashFile(path.join(d, "notes", "sub", "b.md")), "679e273f78fc8f8b");
});

function world() {
  const root = tmp();
  const files: Record<string, string> = {
    "Generic CV\\cv.docx": "cv v1", "Generic CV\\letter.docx": "letter v1",
    "_context\\job-scout\\highlights.md": "h", "_context\\job-scout\\form-answers.md": "f",
  };
  for (const [rel, text] of Object.entries(files)) put(path.join(root, ...rel.split("\\")), text);
  put(path.join(root, "_context", "career", "a.md"), "notes v1");
  const ref = (rel: string) => ({ path: rel, kind: "file", hash: hashFile(path.join(root, ...rel.split("\\"))) });
  const builtFrom = (built: string) => ({
    version: 1, built, settingsVersion: 7,
    files: {
      cvBase: ref("Generic CV\\cv.docx"), letterBase: ref("Generic CV\\letter.docx"),
      careerNotes: { path: "_context\\career", kind: "folder", hash: hashFolder(path.join(root, "_context", "career")) },
      highlights: ref("_context\\job-scout\\highlights.md"), formAnswers: ref("_context\\job-scout\\form-answers.md"),
    },
  });
  const pack = (name: string, pj: unknown) => { const f = path.join(root, ...name.split("\\")); put(path.join(f, "pack.json"), typeof pj === "string" ? pj : JSON.stringify(pj)); return f; };
  return { root, builtFrom, pack };
}
const opts = { today: "2026-10-24", staleAfterDays: 7, settingsVersion: 7 };

test("E16.4: nothing changed is Fresh", () => {
  const w = world();
  const r = checkPack(w.pack("Acme - Head of Product", { builtFrom: w.builtFrom("2026-10-23") }), w.root, opts);
  assert.deepEqual(r, { pack: "Professional development\\Acme - Head of Product", folder: "Acme - Head of Product", level: "fresh", reasons: [], built: "2026-10-23" });
});

test("E16.1: a changed CV master is Stale", () => {
  const w = world();
  const f = w.pack("Acme - Head of Product", { builtFrom: w.builtFrom("2026-10-23") });
  put(path.join(w.root, "Generic CV", "cv.docx"), "cv v2");
  const r = checkPack(f, w.root, opts) as { level: string; reasons: string[] };
  assert.equal(r.level, "stale");
  assert.deepEqual(r.reasons, ["CV master changed since build"]);
});

test("E16.2 and E16.3: career notes, settings or age make it Probably stale", () => {
  const w = world();
  const f = w.pack("Acme - Head of Product", { builtFrom: w.builtFrom("2026-10-15") });
  put(path.join(w.root, "_context", "career", "b.md"), "a new note");
  const r = checkPack(f, w.root, { ...opts, settingsVersion: 8 }) as { level: string; reasons: string[] };
  assert.equal(r.level, "probably");
  assert.deepEqual(r.reasons, ["career notes changed", "settings changed", "built 9 days ago"]);
});

test("E16.6: a pack from before E16 is Probably stale, with the reason", () => {
  const w = world();
  const r = checkPack(w.pack("Old - Role", { id: "x" }), w.root, opts) as { level: string; reasons: string[] };
  assert.equal(r.level, "probably");
  assert.deepEqual(r.reasons, ["built before staleness was recorded"]);
});

test("E16.7 hostile: broken JSON is skipped with a problem; a path out of the folder is never followed", () => {
  const w = world();
  w.pack("Broken - Role", "{ not json");
  const bf = w.builtFrom("2026-10-23");
  (bf.files.cvBase as { path: string }).path = "..\\..\\Windows\\win.ini";
  w.pack("Sneaky - Role", { builtFrom: bf });
  fs.mkdirSync(path.join(w.root, "_context", "not-a-pack"), { recursive: true });
  const rep = checkAll(w.root, opts);
  assert.equal(rep.problems.length, 1);
  assert.match(rep.problems[0], /Broken - Role.*could not be read/);
  const sneaky = rep.packs.find((p) => p.pack.endsWith("Sneaky - Role"))!;
  assert.equal(sneaky.level, "probably");
  assert.match(sneaky.reasons[0], /not inside Professional development; not followed/);
  assert.equal(rep.packs.length, 1, "folders without pack.json, and _context, are not packs");
});

test("E16.7 hostile: a link inside the folder that leads out of it is never followed", () => {
  const w = world();
  const outside = tmp();
  put(path.join(outside, "secret.md"), "outside");
  fs.symlinkSync(outside, path.join(w.root, "link"));
  const bf = w.builtFrom("2026-10-23");
  (bf.files.cvBase as { path: string; hash: string }).path = "link\\secret.md";
  const r = checkPack(w.pack("Linked - Role", { builtFrom: bf }), w.root, opts) as { reasons: string[] };
  assert.match(r.reasons[0], /not inside Professional development; not followed/);
});

test("E16.6: a pack that records no sources is Probably stale, never Fresh", () => {
  const w = world();
  const r = checkPack(w.pack("Empty - Role", { builtFrom: { version: 1, built: "2026-10-23", files: {} } }), w.root, opts) as { level: string; reasons: string[] };
  assert.equal(r.level, "probably");
  assert.deepEqual(r.reasons, ["no sources recorded for this pack"]);
});

test("BUG-8: packs one folder down are found, with their folder name; _context is not scanned", () => {
  const w = world();
  w.pack("Applications 2026\\Spotify - Principal PM", { builtFrom: w.builtFrom("2026-10-23") });
  w.pack("Top - Level", { builtFrom: w.builtFrom("2026-10-23") });
  put(path.join(w.root, "_context", "job-scout", "x", "pack.json"), "{}");
  const rep = checkAll(w.root, opts);
  const names = rep.packs.map((p) => p.pack).sort();
  assert.deepEqual(names, ["Professional development\\Applications 2026\\Spotify - Principal PM", "Professional development\\Top - Level"]);
  assert.equal(rep.packs.find((p) => p.pack.includes("Spotify"))!.folder, "Spotify - Principal PM");
  assert.equal(rep.packs.find((p) => p.pack.includes("Spotify"))!.level, "fresh");
});
