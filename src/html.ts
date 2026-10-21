// Turns an email's HTML into plain lines, keeping each link's address beside
// its words as "words {{https://...}}". The source parsers then work on lines,
// whether an email arrived as HTML or as plain text.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", ndash: "–", mdash: "—", pound: "£", euro: "€", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Links: keep the words and the address. Nested tags inside are stripped.
  // The address may be quoted or not (Google's alerts write href=https://...).
  s = s.replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_all, _q, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
      const href = decodeEntities(dq ?? sq ?? bare ?? "").trim();
      // A link can wrap a whole card (title, company, place in separate cells).
      // Mark the breaks between blocks with " ¦ " so the parts stay apart.
      const words = inner
        .replace(/<br\s*\/?>|<\/(p|div|tr|td|li|h[1-6]|table)>/gi, " ¦ ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .replace(/(\s*¦\s*)+/g, " ¦ ")
        .replace(/^\s*¦\s*|\s*¦\s*$/g, "")
        .trim();
      return ` ${words} {{${href}}} `;
    });

  // Block-level ends become line breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|td|th|section|article)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
