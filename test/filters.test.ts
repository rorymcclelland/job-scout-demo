import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseEmail } from "../src/mime.ts";
import { rolesFrom } from "../src/parsers/index.ts";
import { judge, type Constraints } from "../src/filters.ts";
import { onTracker, readTracker, seenBefore } from "../src/dedupe.ts";
import type { Role } from "../src/role.ts";

const constraints: Constraints = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "config", "constraints.json"), "utf8"),
);
const roles = rolesFrom(
  parseEmail(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "linkedin-alert-text.eml")).toString("latin1")),
).roles;
const byCompany = (c: string) => judge(roles.find((r) => r.company === c)!, constraints);

test("filters: keeps what fits", () => {
  for (const c of ["Acme AI", "Remoto", "Ledgerly"]) assert.equal(byCompany(c).kept, true, c);
  assert.equal(byCompany("Baz Singapore").market, "second");
});

test("filters: drops with a reason", () => {
  const cases: Array<[string, RegExp]> = [
    ["Foo Ltd", /Below the Senior PM floor/],
    ["Qux Consulting", /below £800 a day/],
    ["Zed", /Not a product management role/],
    ["Wayfarer", /Outside London, the UK and Singapore/],
  ];
  for (const [company, why] of cases) {
    const v = byCompany(company);
    assert.equal(v.kept, false, company);
    assert.match(v.reasons.join(" "), why, company);
  }
});

test("filters v2: pay within 10% of the floor passes with a flag; further under is dropped", () => {
  const wayfinder = byCompany("Wayfinder"); // £100k-£115k
  assert.equal(wayfinder.kept, true);
  assert.match(wayfinder.flags.join(" "), /just under £120,000/);
  const r = roles.find((x) => x.company === "Wayfinder")!;
  const low = judge({ ...r, pay: { min: 90000, max: 105000, currency: "GBP", period: "year", text: "£90k-£105k" } }, constraints);
  assert.equal(low.kept, false);
  assert.match(low.reasons.join(" "), /more than 10% under/);
});

test("filters v2: consultancy or contract work abroad passes with a flag", () => {
  const r = roles.find((x) => x.company === "Wayfarer")!;
  const consult = judge({ ...r, title: "AI Product Consultant", location: "Tokyo, Japan" }, constraints);
  assert.equal(consult.kept, true);
  assert.match(consult.flags.join(" "), /Based abroad .* consultant role/);
  assert.equal(byCompany("Wayfarer").kept, false); // a permanent Senior PM in Berlin still goes
});

test("warning signs: agency poster, NDA, 200+ applicants, stale alert", () => {
  const r = roles.find((x) => x.company === "Acme AI")!;
  const v = judge({ ...r, company: "Ridge Search", excerpt: "Our client is a stealth start-up. NDA required. 312 applicants", email: { ...r.email, date: "2026-09-01T09:00:00Z" } }, constraints, "2026-10-14");
  assert.equal(v.kept, true);
  const w = v.warnings.join(" ");
  assert.match(w, /agency \(Ridge Search\)/);
  assert.match(w, /NDA/);
  assert.match(w, /312 applicants/);
  assert.match(w, /Alerted 43 days ago/);
  assert.deepEqual(judge(r, constraints, "2026-10-14").warnings, []);
});

test("filters: fractional and teaching roles pass, with no pay floor", () => {
  const seedling = byCompany("Seedling"); // £500/day but fractional: no floor yet
  assert.equal(seedling.kept, true);
  const tutor = byCompany("Bright Minds");
  assert.equal(tutor.kept, true);
  assert.match(tutor.flags.join(" "), /tutor role/i);
});

test("filters: Senior PM is in scope but flagged", () => {
  assert.match(byCompany("Ledgerly").flags.join(" "), /scored down/);
});

test("filters: other functions dropped; plain PM titles with senior pay kept", () => {
  const r = roles[0];
  const eng = judge({ ...r, title: "Director, Full-Stack Engineer" }, constraints);
  assert.equal(eng.kept, false);
  assert.match(eng.reasons.join(" "), /Not a product role \("engineer"/);
  const sierra = judge({ ...r, title: "Product Manager, Agent Development", pay: { min: 150000, max: 300000, currency: "GBP", period: "year", text: "£150k-300k" } }, constraints);
  assert.equal(sierra.kept, true);
  assert.match(sierra.flags.join(" "), /pay .* suggests a senior role/);
});

test("filters: second-market roles have no pay floor", () => {
  const r: Role = { ...roles[0], location: "Jurong West, Singapore", pay: { min: 1, max: 2, currency: "SGD", period: "year", text: "S$1-2" } };
  assert.equal(judge(r, constraints).kept, true);
});

test("dedupe: tracker matching tolerates recruiter and rename suffixes", () => {
  const tracker = readTracker(`| Company | Role | Status | Applied | Next |
|---|---|---|---|---|
| Ledgerly | Senior Product Manager, Data Platform | Applied | 2026-09-03 | x |
| Ridge Search (client not named) | Head of Product | Preparing | — | x |
| Harbourline (formerly Quayside) | Staff Product Manager, Billing Platform | Applied | 2026-09-03 | x |`);
  assert.equal(tracker.length, 3);
  const ledgerly = roles.find((r) => r.company === "Ledgerly")!;
  assert.equal(onTracker(ledgerly, tracker)?.company, "Ledgerly");
  assert.equal(onTracker({ ...ledgerly, company: "Ridge Search", title: "Head of Product" }, tracker)?.status, "Preparing");
  assert.equal(onTracker({ ...ledgerly, company: "Harbourline", title: "Staff Product Manager, Billing Platform" }, tracker)?.status, "Applied");
  assert.equal(onTracker({ ...ledgerly, company: "Ledgerly", title: "Head of Engineering" }, tracker), null);
});

test("dedupe: seen today does not count; seen yesterday does; reposts are caught", () => {
  const r = roles[0];
  assert.equal(seenBefore(r, { [r.id]: { firstSeen: "2026-10-14", title: r.title, company: r.company } }, "2026-10-14"), null);
  assert.equal(seenBefore(r, { [r.id]: { firstSeen: "2026-10-13", title: r.title, company: r.company } }, "2026-10-14")?.repost, false);
  const repost = seenBefore(r, { "linkedin:999": { firstSeen: "2026-10-01", title: r.title, company: r.company } }, "2026-10-14");
  assert.equal(repost?.repost, true);
});

test("B11: hardware and semiconductor roles are dropped in every market", () => {
  const r = roles.find((x) => x.company === "Acme AI")!;
  const tuas = judge({ ...r, title: "Product Manager, Semiconductor Packaging", location: "Tuas, Singapore" }, constraints);
  assert.equal(tuas.kept, false);
  assert.match(tuas.reasons.join(" "), /Hardware or semiconductor role \("semiconductor"/);
  const tampines = judge({ ...r, title: "Head of Product, AI Platform", location: "Tampines, Singapore" }, constraints);
  assert.equal(tampines.kept, true);
  const london = judge({ ...r, title: "Senior Hardware Product Manager", location: "London, England, United Kingdom" }, constraints);
  assert.equal(london.kept, false);
  assert.match(london.reasons.join(" "), /"hardware"/);
  // Whole words only: "Chipotle" and "fabric" are not hardware.
  assert.equal(judge({ ...r, title: "Head of Product, Fabric Platform", location: "London" }, constraints).kept, true);
});

test("B11: the hardware words can be changed in Settings", async () => {
  const { applySettings } = await import("../src/settings.ts");
  const sources = { senders: [], firstRunLookbackDays: 7 };
  const out = applySettings(constraints, sources, { level: { hardwareWords: ["Robotics"] } });
  assert.deepEqual(out.constraints.level.hardwareWords, ["robotics"]);
  const r = roles.find((x) => x.company === "Acme AI")!;
  assert.equal(judge({ ...r, title: "Head of Product, Robotics" }, out.constraints).kept, false);
  assert.equal(judge({ ...r, title: "Head of Product, Semiconductor" }, out.constraints).kept, true);
});


// The owner, 17 Oct 2026: more open on place in the UK, target employers in the EU, and any product-related title in the second market.
const base = roles.find((r) => r.company === "Acme AI")!;
const mk = (over: Partial<Role>): Role => ({ ...base, pay: null, excerpt: "", notes: [], ...over });

test("filters 17 Oct: any UK place passes; outside London is flagged, not dropped", () => {
  const bar = byCompany("Bar Systems");
  assert.equal(bar.kept, true, "a UK role outside London is no longer dropped");
  assert.match(bar.flags.join(" "), /outside London/);
  const ebb = judge(mk({ title: "Head of Product - Subscriptions", company: "Ebb", location: "England, United Kingdom (Hybrid)", workplace: "hybrid" }), constraints);
  assert.equal(ebb.kept, true, "a vague England or UK place passes");
  assert.equal(ebb.market, "uk");
  const onsite = judge(mk({ title: "Head of Product", company: "Northco", location: "Manchester, England, United Kingdom (On-site)", workplace: "onsite" }), constraints);
  assert.equal(onsite.kept, true);
  assert.match(onsite.flags.join(" "), /outside London/);
});

test("filters 17 Oct: Google and Microsoft roles in the EU pass; other employers there still do not", () => {
  const ms = judge(mk({ title: "Principal Product Manager - Agent 365", company: "Microsoft", location: "Dublin (Hybrid)", workplace: "hybrid" }), constraints);
  assert.equal(ms.kept, true);
  assert.match(ms.flags.join(" "), /target employer in the EU/i);
  const goog = judge(mk({ title: "Group Product Manager", company: "Google", location: "Munich, Germany", workplace: null }), constraints);
  assert.equal(goog.kept, true);
  const other = judge(mk({ title: "Lead Product Manager (m/f/d)", company: "Alasco", location: "Munich (Hybrid)", workplace: "hybrid" }), constraints);
  assert.equal(other.kept, false);
  const zurich = judge(mk({ title: "Group Product Manager", company: "Google", location: "Zurich, Switzerland", workplace: null }), constraints);
  assert.equal(zurich.kept, false, "Switzerland is not in the EU");
});

test("filters 17 Oct: in the second market any product-related title passes, whatever its seniority", () => {
  const passes = [
    ["Product Manager - Data & Analytics", "Nodeworthy", "Singapore (Remote)"],
    ["AI Product Manager", "Angible", "Tampines, Singapore"],
    ["Digital Twin Product Manager", "BizLink Group", "Tampines"],
    ["Product Planning & Marketing Manager", "MediaTek", "Tuas"],
    ["Associate, Product Manager, Investment Products and Advisory", "DBS Bank", "Tampines"],
  ];
  for (const [title, company, location] of passes) {
    const v = judge(mk({ title, company, location, workplace: null }), constraints);
    assert.equal(v.kept, true, title);
    assert.equal(v.market, "second");
    assert.match(v.flags.join(" "), /Singapore/, title);
  }
  const drops = [
    ["Sales Engineer", "Molex", "Tamsui District (On-site)"],
    ["Manager, Vertical Planning and Operations (Attractions)", "Klook", "Jurong West, Singapore (On-site)"],
    ["Product Engineer", "Acme", "Tampines"],
    ["Product Management Intern", "Acme", "Tampines"],
    ["Senior Product Manager, Semiconductor Test", "Acme", "Tuas"],
  ];
  for (const [title, company, location] of drops) {
    assert.equal(judge(mk({ title, company, location, workplace: null }), constraints).kept, false, title);
  }
  // Outside the second market the Senior PM floor still holds.
  assert.equal(judge(mk({ title: "AI Product Manager", company: "Angible", location: "London", workplace: "hybrid" }), constraints).kept, false);
});

test("filters 17 Oct: Mandarin required is flagged for the advert check", () => {
  const v = judge(mk({ title: "Senior Product Manager", company: "Gogolook", location: "Tampines", workplace: null, excerpt: "Fluent Mandarin required; English a plus." }), constraints);
  assert.equal(v.kept, true, "the alert alone is not enough to drop it");
  assert.match(v.warnings.join(" ") + v.flags.join(" "), /Mandarin/);
});
