// Pure helpers of the lead-research server (research.ts), kept apart so they
// can be tested without the network.

export interface Lead {
  name: string;
  homepage: string;
  pricing: string;
}

// Public company websites, a new batch per date: the "list of leads" a sales
// team hands its research agent each day. Pages are fetched live, so this is
// real, heavy input (two long pages per company), not fixture data.
const BATCHES: Record<string, Array<[string, string]>> = {
  "2026-11-02": [
    ["Linear", "https://linear.app"],
    ["Supabase", "https://supabase.com"],
    ["Resend", "https://resend.com"],
    ["PostHog", "https://posthog.com"],
    ["Plausible", "https://plausible.io"],
    ["Cal.com", "https://cal.com"],
    ["Neon", "https://neon.com"],
    ["Clerk", "https://clerk.com"],
  ],
  "2026-11-03": [
    ["Railway", "https://railway.com"],
    ["Render", "https://render.com"],
    ["Fly.io", "https://fly.io"],
    ["Sentry", "https://sentry.io"],
    ["Grafana", "https://grafana.com"],
    ["Tailscale", "https://tailscale.com"],
    ["Netlify", "https://www.netlify.com"],
    ["Vercel", "https://vercel.com"],
  ],
  "2026-11-04": [
    ["Paddle", "https://www.paddle.com"],
    ["Mailgun", "https://www.mailgun.com"],
    ["Postmark", "https://postmarkapp.com"],
    ["Loops", "https://loops.so"],
    ["Twilio", "https://www.twilio.com"],
    ["Brevo", "https://www.brevo.com"],
    ["Customer.io", "https://customer.io"],
    ["Plunk", "https://www.useplunk.com"],
  ],
  "2026-11-05": [
    ["Zapier", "https://zapier.com"],
    ["n8n", "https://n8n.io"],
    ["Make", "https://www.make.com"],
    ["Airtable", "https://www.airtable.com"],
    ["Retool", "https://retool.com"],
    ["Appsmith", "https://www.appsmith.com"],
    ["Budibase", "https://budibase.com"],
    ["NocoDB", "https://nocodb.com"],
  ],
};

export const BATCH_DATES = Object.keys(BATCHES);

export function leadsFor(date: string): Lead[] | undefined {
  return BATCHES[date]?.map(([name, homepage]) => ({
    name,
    homepage,
    pricing: `${homepage}/pricing`,
  }));
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Readable text of an HTML page: no scripts, styles or tags; spaces collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code =
          e[1] === "x" || e[1] === "X"
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Cuts text to at most `max` characters, saying so at the end. */
export function capText(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[cut at ${max} characters]`;
}
