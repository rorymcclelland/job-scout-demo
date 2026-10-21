// Plain text from an advert page or a job-board API (H5, Sprint 5c).

export function textOf(html: string): string {
  return html
    .replace(/<(script|style|noscript|head|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|ul|ol|section|article)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&pound;/g, "£").replace(/&euro;/g, "€")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t ]+/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

/** Lower-case words of 3+ letters, minus the commonest filler, for matching. */
const STOP = new Set(["the", "and", "for", "with", "you", "your", "our", "are", "have", "has", "who", "will", "can", "this", "that", "from", "into", "able", "ability", "strong", "experience", "experienced", "years", "year", "proven", "track", "record", "including", "such", "other", "least", "plus", "must", "ideally", "preferably", "demonstrable", "excellent", "good", "great", "working", "work", "skills", "skill", "knowledge"]);

export function keyWords(s: string): string[] {
  return (s.toLowerCase().normalize("NFKD").match(/[a-z0-9+#.]{3,}/g) ?? []).map((w) => w.replace(/\.$/, "")).filter((w) => w.length >= 3 && !STOP.has(w));
}
