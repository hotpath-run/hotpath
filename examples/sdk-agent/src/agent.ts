import type { Tools } from "@hotpathrun/sdk";
import {
  AGENT_MODEL,
  chat,
  type ChatMessage,
  type LlmToolSpec,
} from "@hotpathrun/shared";

// A plain tool-calling loop over functions, the way an agent written with the
// OpenAI SDK looks. The model call goes through @hotpathrun/shared's `chat` (the
// OpenAI SDK against any compatible endpoint): this repository keeps all model
// access in that one file.

export const TASK = "orders-report";
const MAX_TURNS = 8;

const systemPrompt = (date: string) =>
  `You are the operations assistant of a small coffee wholesaler. Today is ${date}. ` +
  "Write the daily report: read today's orders and the stock alerts, then call " +
  'send_report with to="ops" and a short text that names every order (its id, ' +
  "customer and total) and every stock alert (the product name and how many are left).";

export interface AgentResult {
  llmCalls: number;
  toolCalls: string[];
}

export async function runAgent(
  tools: Tools,
  date: string,
): Promise<AgentResult> {
  const specs: LlmToolSpec[] = Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? name,
    parameters: tool.parameters ?? { type: "object" },
  }));
  const actions = Object.entries(tools)
    .filter(([, tool]) => tool.readOnly !== true)
    .map(([name]) => name);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(date) },
    { role: "user", content: `Send the daily report for ${date}.` },
  ];
  const called: string[] = [];
  let llmCalls = 0;
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await chat({ model: AGENT_MODEL, messages, tools: specs });
    llmCalls += result.llmCalls;
    if (result.toolCalls.length === 0) {
      // a small model may answer in text instead of sending: say so once
      if (nudged || called.some((name) => actions.includes(name))) break;
      nudged = true;
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: `The report has not been sent. Call ${actions.join(" or ")} now.`,
      });
      continue;
    }
    // reads first: an action planned in the same turn was written before the
    // model saw any data, so it waits for the next turn
    const reads = result.toolCalls.filter((c) => !actions.includes(c.name));
    const run =
      reads.length > 0 && reads.length < result.toolCalls.length
        ? reads
        : result.toolCalls;
    messages.push({
      role: "assistant",
      content: result.text,
      toolCalls: run,
    });
    for (const call of run) {
      called.push(call.name);
      let content: string;
      try {
        const tool = tools[call.name];
        content = tool
          ? JSON.stringify(await tool.execute(call.arguments))
          : `no tool named ${call.name}`;
      } catch (err) {
        content = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content,
      });
    }
  }
  return { llmCalls, toolCalls: called };
}
