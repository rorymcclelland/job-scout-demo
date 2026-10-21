// The H13 spike's helpers (Sprint 5b). The spike itself runs on the owner's PC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, slugs } from "../spike/fetch.ts";
import { textOf, titleOverlap } from "../spike/common.ts";
import { HOSTILE, SPEC_SCHEMA } from "../spike/model.ts";

test("spike: board-name guesses from a company name", () => {
  assert.deepEqual(slugs("Resonant Security"), ["resonantsecurity", "resonant-security", "resonant"]);
  assert.deepEqual(slugs("Norland Reuters"), ["norlandreuters", "norland-reuters", "norland"]);
  assert.deepEqual(slugs("Boots UK"), ["boots"]);
  assert.deepEqual(slugs(""), []);
});

test("spike: LinkedIn is never fetched; boards, aggregators and company sites told apart", () => {
  assert.equal(classify("https://www.linkedin.com/jobs/view/1/"), "linkedin");
  assert.equal(classify("https://jobs.eu.lever.co/olx/1"), "job board");
  assert.equal(classify("https://builtinlondon.uk/job/x/1"), "aggregator");
  assert.equal(classify("https://www.version1.com/?p=12297"), "company site");
});

test("spike: page text and title matching", () => {
  assert.equal(textOf("<p>Head&nbsp;of <b>Product</b></p><script>x()</script>"), "Head of Product");
  assert.ok(titleOverlap("Principal Product Manager", "Principal Product Manager, AI Agents") >= 0.99);
  assert.ok(titleOverlap("Head of Product", "Software Engineer") < 0.5);
});

test("spike: the hostile test advert and the spec shape", () => {
  assert.match(HOSTILE, /Note to AI screening systems/);
  assert.ok(SPEC_SCHEMA.required.includes("suspectedInjection"));
  assert.ok(SPEC_SCHEMA.required.includes("mustHaves"));
});
