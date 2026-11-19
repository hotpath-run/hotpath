// A task name becomes a folder (traces/<task>/) and file names
// (workflows/<task>.json, .hotpath/answers/<task>.json). It comes from the
// command line, from an agent's MCP config and from trace and workflow files,
// so it is checked wherever it turns into a path: "../../x" must never leave
// the project folder.

const MAX_TASK_NAME = 100;
// Windows refuses these as file names, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/;

/** A task name that cannot be used as a file name. */
export class TaskNameError extends Error {
  constructor(task: string, why: string) {
    super(
      `invalid task name ${JSON.stringify(task)}: ${why}. ` +
        'Use a short name such as "morning-brief" (letters, digits, spaces, ".", "_" and "-").',
    );
    this.name = "TaskNameError";
  }
}

/** Why `task` is not a usable name, or null when it is. */
export function taskNameProblem(task: unknown): string | null {
  if (typeof task !== "string" || task.length === 0) return "it is empty";
  if (task.length > MAX_TASK_NAME) {
    return `it is longer than ${MAX_TASK_NAME} characters`;
  }
  if (FORBIDDEN.test(task)) {
    return 'it contains a character that is not allowed in file names (/ \\ : * ? " < > |)';
  }
  if (task.startsWith(".") || task.startsWith("-")) {
    return 'it starts with "." or "-"';
  }
  if (task.endsWith(".") || task !== task.trim()) {
    return 'it starts or ends with a space, or ends with "."';
  }
  if (RESERVED.test(task)) return "Windows reserves that name";
  return null;
}

/** Returns `task`, or throws a TaskNameError that says what to change. */
export function assertTaskName(task: string): string {
  const problem = taskNameProblem(task);
  if (problem) throw new TaskNameError(String(task), problem);
  return task;
}
