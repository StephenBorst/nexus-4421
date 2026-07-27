// RSS timestamp tests. Run: node --test app/lib/rssDate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseRssDate, timeAgo } from "./rssDate.mjs";

const UTC = Date.UTC(2026, 6, 27, 10, 11, 23); // 2026-07-27T10:11:23Z

test("REGRESSION: a zone-less rss2json pubDate is read as UTC, not local time", () => {
  // This is the whole bug. Parsed as local, a UTC-6 machine read this as 16:11Z and
  // every article looked ~6h in the future → the "-333m" the News tab displayed.
  assert.equal(parseRssDate("2026-07-27 10:11:23"), UTC);
  assert.equal(parseRssDate("2026-07-27T10:11:23"), UTC);
  assert.equal(parseRssDate("2026-07-27 10:11"), Date.UTC(2026, 6, 27, 10, 11));
});

test("REGRESSION: the age is never negative, whatever the feed claims", () => {
  const now = UTC;
  // an hour into the future (skewed feed clock) must read "now", never "-60m"
  assert.equal(timeAgo("2026-07-27 11:11:23", now), "now");
  assert.equal(timeAgo("2099-01-01 00:00:00", now), "now");
  for (const s of ["2026-07-27 11:11:23", "2099-01-01 00:00:00", "2027-01-01 00:00:00"]) {
    assert.ok(!timeAgo(s, now).startsWith("-"), `${s} produced a negative age`);
  }
});

test("timestamps that DO carry a zone are honoured, not double-shifted", () => {
  assert.equal(parseRssDate("2026-07-27T10:11:23Z"), UTC);
  assert.equal(parseRssDate("Mon, 27 Jul 2026 10:11:23 GMT"), UTC);
  // an explicit offset must be respected: 12:11:23+02:00 === 10:11:23Z
  assert.equal(parseRssDate("2026-07-27T12:11:23+02:00"), UTC);
});

test("timeAgo: the unit ladder", () => {
  const now = UTC;
  const at = (ms) => new Date(now - ms).toISOString().slice(0, 19).replace("T", " ");
  assert.equal(timeAgo(at(30 * 1000), now), "now");        // <1min
  assert.equal(timeAgo(at(17 * 60000), now), "17m");
  assert.equal(timeAgo(at(59 * 60000), now), "59m");
  assert.equal(timeAgo(at(20 * 3600000), now), "20h");
  assert.equal(timeAgo(at(3 * 86400000), now), "3d");
});

test("unparseable input yields an empty label, never NaN in the UI", () => {
  for (const bad of ["", "garbage", null, undefined, 12345]) {
    assert.equal(timeAgo(bad), "");
    assert.ok(!Number.isFinite(parseRssDate(bad)));
  }
});

test("sorting by parseRssDate orders newest first across mixed formats", () => {
  const items = [
    { p: "2026-07-26 15:07:00" },            // oldest
    { p: "Mon, 27 Jul 2026 10:39:22 GMT" },  // newest
    { p: "2026-07-27 09:57:20" },
  ];
  const sorted = [...items].sort((a, b) => parseRssDate(b.p) - parseRssDate(a.p));
  assert.deepEqual(sorted.map((i) => i.p), [
    "Mon, 27 Jul 2026 10:39:22 GMT",
    "2026-07-27 09:57:20",
    "2026-07-26 15:07:00",
  ]);
});
