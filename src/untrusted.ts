// Alert emails and adverts are written by strangers (backlog H2). Before any of
// their text reaches the scoring step, which is an AI, this file:
//
//   - caps its length, so a page of hidden text cannot crowd out the real advert;
//   - removes lines that talk to an AI or try to change its instructions, steer
//     its scoring, or ask for personal data to be sent somewhere.
//
// Removed lines are reported in run.md and turned into a warning sign on the
// role, because an advert that tries to instruct the reader is itself a signal.
// This is one layer: SCOUT.md also marks all such text as data, never
// instructions, and the run's outputs are validated before anything is written.

const PATTERNS: Array<[string, RegExp]> = [
  ["tries to override instructions", /\b(ignore|disregard|forget|override|bypass)\b.{0,60}\b(instruction|instructions|prompt|rules?|previous|above|guidelines|system)\b/i],
  ["addresses an AI system", /\b(system|developer)\s*(prompt|message)\b|^\s*(system|assistant|developer)\s*:/i],
  ["addresses an AI system", /\byou are (now )?(an?|the)\s+(ai|assistant|model|language model|chatbot|llm|hiring assistant|recruiting assistant)\b/i],
  ["addresses an AI system", /\b(dear|hey|hi|attention|note to( the)?)\s+(ai|assistant|claude|chatgpt|gpt|gemini|model|llm|bot)\b|\b(claude|chatgpt|gemini|copilot)\s*:\s|\b(ai|llm|model|assistant|bot|agent)s?\s+(reading|reviewing|screening|processing|scoring|parsing)\s+this\b|\bas an? (ai|llm|language model)\b/i],
  ["tries to steer the score", /\b(score|rate|rank|grade)\s+(this|the|me|my|our)?\s*(role|job|candidate|application|advert|posting)?\b.{0,40}\b(100|10\s*\/\s*10|ten out of ten|maximum|highest|top marks|full marks|perfect)\b/i],
  ["asks for data to be sent", /\b(send|email|forward|share|upload|paste|copy)\b.{0,50}\b(password|passcode|credentials|api key|token|personal (data|details)|home address|bank|candidate profile|career (notes|vault))\b.{0,60}(@|https?:\/\/|\bto\b)/i],
  ["contains prompt markup", /<\|[^|]*\|>|\[\/?INST\]|<<\/?SYS>>|BEGIN (PROMPT|INSTRUCTIONS)|```/i],
];

export interface Cleaned {
  text: string;
  removed: Array<{ line: string; why: string }>;
  truncated: boolean;
}

export function cleanUntrusted(text: string, maxChars: number): Cleaned {
  const removed: Cleaned["removed"] = [];
  const kept: string[] = [];
  for (const line of (text || "").split("\n")) {
    const hit = PATTERNS.find(([, re]) => re.test(line));
    if (hit) removed.push({ line: line.trim().slice(0, 160), why: hit[0] });
    else kept.push(line);
  }
  let out = kept.join("\n");
  const truncated = out.length > maxChars;
  if (truncated) out = out.slice(0, maxChars).replace(/\s+\S*$/, "") + " …";
  return { text: out, removed, truncated };
}

export const LIMITS = { title: 200, company: 120, location: 160, note: 300, excerpt: 1500 };
