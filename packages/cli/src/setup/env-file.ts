// Pure helpers for the .env file `hotpath init` writes: only the given keys
// change; comments, order and every other line stay as the user left them.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** KEY=value pairs in a .env text (comments and blank lines skipped). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

function quote(value: string): string {
  return /[\s#"'=]/.test(value) ? JSON.stringify(value) : value;
}

/** `text` with each key set to its value: replaced in place, else appended. */
export function setEnv(text: string, values: Record<string, string>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const left = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = LINE.exec(line);
    if (!m || !left.has(m[1]!)) return line;
    const value = left.get(m[1]!)!;
    left.delete(m[1]!);
    return `${m[1]}=${quote(value)}`;
  });
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (left.size > 0) {
    if (out.length > 0) out.push("");
    for (const [k, v] of left) out.push(`${k}=${quote(v)}`);
  }
  return out.join(eol) + eol;
}
