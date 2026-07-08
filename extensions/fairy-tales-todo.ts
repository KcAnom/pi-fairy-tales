/**
 * fairy-tales-todo: TodoWrite-style task tracking.
 * - `todo` tool with whole-list `write` semantics (plus `list`).
 * - State lives in each tool result's `details.todos` and is rebuilt from the
 *   session branch on session_start — branch- and fork-correct by construction.
 * - Live checklist widget above the editor.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { isNested } from "../src/config.ts";

interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "done";
}

const MARKS: Record<TodoItem["status"], string> = {
  pending: "☐",
  in_progress: "◐",
  done: "☑",
};

function renderLines(todos: TodoItem[]): string[] {
  return todos.map((t) => ` ${MARKS[t.status]} ${t.text}`);
}

export default function (pi: ExtensionAPI) {
  let todos: TodoItem[] = [];

  const updateWidget = (ctx: { hasUI: boolean; ui: { setWidget(key: string, lines?: string[], opts?: { placement?: string }): void } }) => {
    if (!ctx.hasUI || isNested()) return;
    const visible = todos.length > 0 && todos.some((t) => t.status !== "done");
    ctx.ui.setWidget("fairy-tales-todo", visible ? renderLines(todos) : undefined, { placement: "aboveEditor" });
  };

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Track the plan for a multi-step task. action 'write' replaces the whole list (send every item with its current status); action 'list' returns the current list.",
    promptSnippet: "Track multi-step task progress with a visible checklist",
    promptGuidelines: [
      "Use todo with action 'write' at the start of any multi-step task and update it as steps complete.",
      "Keep exactly one todo item in_progress at a time; mark items done immediately after finishing them.",
    ],
    parameters: Type.Object({
      action: StringEnum(["write", "list"] as const),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String(),
            status: StringEnum(["pending", "in_progress", "done"] as const),
          }),
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const wasUnfinished = todos.length > 0 && todos.some((t) => t.status !== "done");
      if (params.action === "write") {
        if (!params.items) throw new Error("todo write requires items");
        todos = params.items;
      }
      updateWidget(ctx);
      // Quest complete celebration (ftales only): the whole list just turned done.
      if (
        process.env.FTALES === "1" &&
        ctx.hasUI &&
        wasUnfinished &&
        todos.length > 0 &&
        todos.every((t) => t.status === "done")
      ) {
        ctx.ui.notify("✦ Quest complete — every trial overcome ✦", "info");
      }
      const body = todos.length ? renderLines(todos).join("\n") : "(todo list empty)";
      return {
        content: [{ type: "text", text: body }],
        details: { todos },
      };
    },
    renderResult(result, _options, theme) {
      const details = result.details as { todos?: TodoItem[] } | undefined;
      const items = details?.todos ?? [];
      const lines = items.map((t) =>
        t.status === "done"
          ? theme.fg("muted", ` ${MARKS[t.status]} ${t.text}`)
          : t.status === "in_progress"
            ? theme.fg("accent", ` ${MARKS[t.status]} ${t.text}`)
            : ` ${MARKS[t.status]} ${t.text}`,
      );
      return new Text(lines.join("\n") || "(todo list empty)", 0, 0);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Rebuild from the current branch: last todo tool result wins.
    todos = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = (entry as { message?: { role?: string; toolName?: string; details?: { todos?: TodoItem[] } } }).message;
      if (msg?.role === "toolResult" && msg.toolName === "todo" && msg.details?.todos) {
        todos = msg.details.todos;
      }
    }
    updateWidget(ctx);
  });
}
