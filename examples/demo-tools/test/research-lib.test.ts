import { describe, expect, it } from "vitest";

import {
  BATCH_DATES,
  capText,
  htmlToText,
  leadsFor,
} from "../src/research-lib.js";

describe("lead-research helpers", () => {
  it("has a batch of 8 leads per date, each with a pricing page", () => {
    expect(BATCH_DATES.length).toBeGreaterThanOrEqual(4);
    for (const date of BATCH_DATES) {
      const leads = leadsFor(date)!;
      expect(leads).toHaveLength(8);
      for (const lead of leads) {
        expect(lead.homepage).toMatch(/^https:\/\//);
        expect(lead.pricing).toBe(`${lead.homepage}/pricing`);
      }
    }
    expect(leadsFor("1999-01-01")).toBeUndefined();
  });

  it("turns HTML into readable text without scripts or styles", () => {
    const html =
      "<html><head><style>body{color:red}</style><script>var x=1</script></head>" +
      "<body><h1>Plans &amp; pricing</h1><p>Free&nbsp;tier</p><!-- hidden -->" +
      "<div>Pro: &#36;20 / month</div></body></html>";
    expect(htmlToText(html)).toBe(
      "Plans & pricing\nFree tier\nPro: $20 / month",
    );
  });

  it("cuts long text and says where", () => {
    expect(capText("abcdef", 10)).toBe("abcdef");
    expect(capText("abcdef", 3)).toBe("abc\n[cut at 3 characters]");
  });
});
