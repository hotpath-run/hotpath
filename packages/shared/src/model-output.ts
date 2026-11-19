// Small open-weight models often answer a tool request in the wrong field:
// the call is written as JSON in the message text (bare, in a ```json fence, or
// in Qwen/Hermes <tool_call> tags) instead of in `tool_calls`, and reasoning
// models can leak <think> blocks into the text. These pure helpers recover the
// intended answer so the agent loop and workflow steps keep working.

export interface TextToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** {name, arguments|parameters} → a call, only for tools that were offered. */
function asCall(
  value: unknown,
  allowed: Set<string>,
): Omit<TextToolCall, "id"> | null {
  if (!isObject(value) || typeof value.name !== "string") return null;
  if (!allowed.has(value.name)) return null;
  let args: unknown = value.arguments ?? value.parameters ?? {};
  if (typeof args === "string") args = tryJson(args) ?? {};
  return { name: value.name, arguments: isObject(args) ? args : {} };
}

function callsFrom(
  value: unknown,
  allowed: Set<string>,
): Omit<TextToolCall, "id">[] {
  const items = Array.isArray(value) ? value : [value];
  const calls = items.map((v) => asCall(v, allowed));
  // all-or-nothing: a half-matching array is more likely data than calls
  return calls.every((c) => c !== null)
    ? (calls as Omit<TextToolCall, "id">[])
    : [];
}

/**
 * Tool calls a model wrote as text. Returns the calls (ids `text_call_<n>`)
 * and the text that is left once they are removed.
 */
export function toolCallsFromText(
  text: string,
  toolNames: readonly string[],
): { calls: TextToolCall[]; rest: string } {
  const allowed = new Set(toolNames);
  if (allowed.size === 0 || !text.trim()) return { calls: [], rest: text };
  const found: Omit<TextToolCall, "id">[] = [];
  let rest = text;

  // 1. <tool_call>…</tool_call> tags, any number
  const tagged = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  for (const m of text.matchAll(tagged)) {
    const calls = callsFrom(tryJson(m[1]), allowed);
    if (calls.length > 0) {
      found.push(...calls);
      rest = rest.replace(m[0], "");
    }
  }

  // 2. ```json fenced blocks
  if (found.length === 0) {
    for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
      const calls = callsFrom(tryJson(m[1].trim()), allowed);
      if (calls.length > 0) {
        found.push(...calls);
        rest = rest.replace(m[0], "");
      }
    }
  }

  // 3. the whole reply is the JSON, or several JSON objects in a row
  if (found.length === 0) {
    const whole = tryJson(text.trim());
    const values =
      whole !== undefined
        ? [whole]
        : (splitJsonObjects(text)?.map(tryJson) ?? []);
    const calls = values.flatMap((v) => callsFrom(v, allowed));
    if (calls.length > 0 && calls.length >= values.length) {
      found.push(...calls);
      rest = "";
    }
  }

  return {
    calls: found.map((c, i) => ({ id: `text_call_${i}`, ...c })),
    rest: rest.trim(),
  };
}

/**
 * Top-level `{…}` objects when the text is nothing but objects and whitespace
 * (one per line, or pretty-printed); null otherwise. Tracks strings so braces
 * inside text values don't count.
 */
function splitJsonObjects(text: string): string[] | null {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 0) return null; // a string outside any object: prose
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) objects.push(text.slice(start, i + 1));
    } else if (depth === 0 && !/\s/.test(ch)) {
      return null; // anything else between objects means prose
    }
  }
  return depth === 0 && objects.length > 0 ? objects : null;
}

/** Drops <think>…</think> blocks (and an unclosed one at the end). */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}

/**
 * A replay answer wrapped whole in quotes or a fence ("""…""", ```…```): the
 * model copied the delimiters the retry prompt put around its previous answer
 * (measured: qwen3:1.7b sent the bank report inside """ 20 times of 20). The
 * wrapper is not part of the message; anything inside is kept as written.
 */
export function unwrapAnswer(text: string): string {
  const t = text.trim();
  const m =
    /^"""[^\n]*\n([\s\S]*?)\n?"""$/.exec(t) ??
    /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1]!.trim() : text;
}
