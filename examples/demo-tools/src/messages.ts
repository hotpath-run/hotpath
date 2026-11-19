import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo-root out/, whether run from src/ (tsx) or dist/ (node); DEMO_OUT_DIR
// moves it (the installed `hotpath demo` writes into the project folder).
const outDir =
  process.env.DEMO_OUT_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../out");
const messagesFile = path.join(outDir, "messages.json");

export interface SentMessage {
  id: string;
  to: string;
  text: string;
  at: string;
}

export async function appendMessage(msg: {
  to: string;
  text: string;
}): Promise<SentMessage> {
  await mkdir(outDir, { recursive: true });
  let messages: SentMessage[] = [];
  try {
    messages = JSON.parse(await readFile(messagesFile, "utf8"));
  } catch {
    // first message
  }
  const message: SentMessage = {
    id: `m${messages.length + 1}`,
    to: msg.to,
    text: msg.text,
    at: new Date().toISOString(),
  };
  messages.push(message);
  await writeFile(messagesFile, JSON.stringify(messages, null, 2));
  return message;
}
