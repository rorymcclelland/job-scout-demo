import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decodeWords, parseEmail } from "../src/mime.ts";
import { parsePay } from "../src/pay.ts";
import { rolesFrom } from "../src/parsers/index.ts";

const fixture = (name: string) =>
  parseEmail(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name)).toString("latin1"));

test("mime: decodes encoded-word subjects and quoted-printable bodies", () => {
  assert.equal(decodeWords("=?UTF-8?Q?Senior_PM_=E2=80=93_London?="), "Senior PM – London");
  const e = fixture("linkedin-alert-text.eml");
  assert.match(e.subject, /“product leadership”: Acme AI/);
  assert.match(e.text, /£140K\/yr - £160K\/yr/); // £ survived quoted-printable UTF-8
  assert.equal(e.date, "2026-10-14T07:12:00.000Z");
});

test("pay: reads the shapes alerts use", () => {
  assert.deepEqual(
    { ...parsePay("£100K/yr - £115K/yr")!, text: "" },
    { min: 100000, max: 115000, currency: "GBP", period: "year", text: "" },
  );
  assert.equal(parsePay("£120,000 - £140,000")!.period, "year");
  assert.equal(parsePay("£650 - £750 per day")!.max, 750);
  assert.equal(parsePay("£650 - £750 per day")!.period, "day");
  assert.equal(parsePay("NT$2,400,000 - NT$3,000,000")!.currency, "TWD");
  assert.equal(parsePay("12 applicants"), null);
  assert.equal(parsePay("Hybrid, 2 days a week"), null);
});

test("linkedin: plain-text layout gives one role per job, fields in the right places", () => {
  const { kind, roles } = rolesFrom(fixture("linkedin-alert-text.eml"));
  assert.equal(kind, "linkedin");
  assert.equal(roles.length, 12);

  const first = roles[0];
  assert.equal(first.id, "linkedin:4100000001");
  assert.equal(first.title, "Head of Product");
  assert.equal(first.company, "Acme AI");
  assert.equal(first.location, "London, England, United Kingdom (Hybrid)");
  assert.equal(first.workplace, "hybrid");
  assert.equal(first.pay?.max, 160000);
  assert.equal(first.url, "https://www.linkedin.com/jobs/view/4100000001/"); // tracking removed
  assert.equal(first.parse, "full");

  // A title that itself mentions a place must not be mistaken for the place.
  const remoto = roles.find((r) => r.company === "Remoto")!;
  assert.equal(remoto.title, "Head of Product – Remote UK");
  assert.equal(remoto.location, "United Kingdom (Remote)");

  // Titles containing words like "Fractional" or "part-time" stay titles.
  assert.equal(roles.find((r) => r.company === "Seedling")!.title, "Fractional Chief Product Officer");
  assert.equal(roles.find((r) => r.company === "Bright Minds")!.title, "AI Tutor (part-time)");
});

test("linkedin: HTML-only layout", () => {
  const { roles } = rolesFrom(fixture("linkedin-alert-html.eml"));
  assert.deepEqual(
    roles.map((r) => [r.title, r.company, r.location]),
    [
      ["Group Product Manager, Platform", "Northwind", "London, England, United Kingdom (Hybrid)"],
      ["VP Product", "Merlion Cloud", "Tuas, Singapore"],
    ],
  );
  assert.equal(roles[0].pay?.max, 170000);
});

test("linkedin: real card layout (bare logo link, title link, 'Company · Place')", () => {
  const { roles } = rolesFrom(fixture("linkedin-alert-cards.eml"));
  assert.deepEqual(
    roles.map((r) => [r.title, r.company, r.location]),
    [
      ["Principal Product Manager - Risk Platform", "Sterling", "London"],
      ["Sr. Director of Product Management", "Supermicro", "Ottery Ward"], // place kept though not recognised
      ["Senior Digital Product Manager", "Loop Earplugs", "London Area, United Kingdom (Remote)"], // whole card in one link
    ],
  );
  // "Jobs similar to ..." links and the Premium promotion are not roles or notes.
  assert.ok(roles.every((r) => !r.notes.some((n) => /premium/i.test(n))));
});

test("hackajob: Archer's weekly matches give one role per match", () => {
  const { kind, roles } = rolesFrom(fixture("hackajob-weekly.eml"));
  assert.equal(kind, "hackajob");
  assert.deepEqual(
    roles.map((r) => [r.title, r.company, r.location, r.pay?.max]),
    [
      ["Staff Product Manager, Billing Platform", "Harbourline", "London, United Kingdom (Hybrid)", 130000],
      ["Lead Product Manager", "Nimbus", "London, United Kingdom (Hybrid)", 125000],
      ["Product Manager, Agent Development", "Sierra", "London, United Kingdom (On-site)", 300000],
    ],
  );
  assert.equal(roles[0].id, "hackajob:harbourline-staff-product-manager-billing-platform"); // stable across emails
  assert.match(roles[1].excerpt, /reason for the match: You meet all the must-have/);
  assert.match(roles[0].url, /^https:\/\/cio\.mail-hackajob\.com\//); // fixture links are not real redirects
});

test("pay in a LinkedIn title is read; hackajob tracking links are unwrapped", async () => {
  const { unwrapLink } = await import("../src/parsers/hackajob.ts");
  const payload = Buffer.from(JSON.stringify({ href: "https://hackajob.com/sso/candidate/x?redirect_to=https%3A%2F%2Fuser.hackajob.com%2Fapply%2Fabc-123%3Futm_medium%3Demail" })).toString("base64url");
  assert.equal(unwrapLink(`https://cio.mail-hackajob.com/e/c/${payload}/sig`), "https://user.hackajob.com/apply/abc-123");
  assert.equal(unwrapLink("https://example.com/x"), "https://example.com/x");
});

test("hackajob: single match and reminder shapes; welcome notes give nothing", () => {
  const single = rolesFrom(fixture("hackajob-single.eml")).roles;
  assert.deepEqual([single[0].title, single[0].company], ["Director, Full-Stack Engineer", "Northbank"]);
  const reminder = rolesFrom(fixture("hackajob-reminder.eml")).roles;
  assert.deepEqual([reminder[0].title, reminder[0].company], ["Data and AI Transformation Lead Partner", "Atlas Consulting"]);
  assert.equal(reminder[0].pay, null);
  assert.equal(rolesFrom(fixture("hackajob-welcome.eml")).roles.length, 0);
});
