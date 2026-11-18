import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamText as aiStreamText } from "ai";
import { db } from "@CodeLeeD/database/client";
import { Mode, MessageStatus } from "@CodeLeeD/database/enums";
import { type ChatStreamEvent } from "@CodeLeeD/shared";
import { isSupportedChatModel, resolveChatModel } from "../lib/models";

const MAX_HISTORY_MESSAGES = 40;

const SYSTEM_PROMPTS: Record<Mode, string> = {
  BUILD:
    "You are CodeLeeD, a coding assistant in the user's terminal. Help build and change code. Be concise.",
  PLAN:
    "You are CodeLeeD, a coding assistant in the user's terminal. Plan the work step by step and do not write full implementations.",
};

function buildSystemPrompt(mode: Mode) {
  const today = new Date().toISOString().slice(0, 10);
  return `${SYSTEM_PROMPTS[mode]}\nToday's date is ${today}.`;
}

type Turn = { role: "user" | "assistant"; content: string };

// Merge consecutive same-role turns, keep the last N, and start on a user turn.
function normalizeHistory(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.content += `\n\n${turn.content}`;
    } else {
      merged.push({ ...turn });
    }
  }

  const recent = merged.slice(-MAX_HISTORY_MESSAGES);
  while (recent[0]?.role === "assistant") recent.shift();
  return recent;
}

// A failed database write must not hide the real error from the client.
async function saveSafely(
  data: Parameters<typeof db.message.create>[0]["data"],
) {
  try {
    await db.message.create({ data });
  } catch (err) {
    console.error("Failed to save message", err);
  }
}

const submitSchema = z.object({
  content: z.string().min(1),
  mode: z.enum(Mode),
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
});

const submitValidator = zValidator("json", submitSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

const activeResumeSessionIds = new Set<string>();

// Strip error messages and empty assistant messages from the conversation
function buildConversationHistory(
  messages: {
    role: "USER" | "ASSISTANT" | "ERROR";
    content: string;
    status: MessageStatus;
  }[],
) {
  return normalizeHistory(
    messages.flatMap((m): Turn[] => {
      if (m.role === "ERROR") return [];
      if (m.role === "ASSISTANT" && m.content.length === 0) return [];
      return [
        {
          role: m.role === "USER" ? "user" : "assistant",
          content: m.content,
        },
      ];
    }),
  );
}

function getResumableUserMessage(
  messages: {
    role: "USER" | "ASSISTANT" | "ERROR";
    model: string;
    mode: Mode;
  }[],
) {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "USER") {
    return null;
  }

  return lastMessage;
}

type StreamParams = {
  sessionId: string;
  model: string;
  history: Turn[];
  mode: Mode;
  abortController: AbortController;
};

async function streamAIResponse(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  params: StreamParams,
) {
  const { sessionId, model, history, mode, abortController } = params;
  const startTime = Date.now();
  const resolvedModel = resolveChatModel(model);
  let fullText = "";

  const persistInterruptedMessage = async () => {
    if (fullText.length === 0) return;

    const elapsedMs = Date.now() - startTime;

    await saveSafely({
      sessionId,
      role: "ASSISTANT",
      status: MessageStatus.INTERRUPTED,
      model,
      content: fullText,
      mode,
      duration: Math.round(elapsedMs / 1000),
    });
  };

  try {
    const result = aiStreamText({
      model: resolvedModel.model,
      system: buildSystemPrompt(mode),
      messages: history,
      abortSignal: abortController.signal,
    });

    for await (const part of result.fullStream) {
      if (stream.aborted) break;

      if (part.type === "text-delta") {
        fullText += part.text;
        const event: ChatStreamEvent = { type: "text-delta", text: part.text };
        await stream.writeSSE({ event: "text-delta", data: JSON.stringify(event) });
      }

      if (part.type === "error") {
        throw part.error;
      }
    }

    if (stream.aborted || abortController.signal.aborted) {
      await persistInterruptedMessage();
      return;
    }

    const elapsedMs = Date.now() - startTime;

    const assistantMessage = await db.message.create({
      data: {
        sessionId,
        role: "ASSISTANT",
        status: MessageStatus.COMPLETE,
        model,
        content: fullText,
        mode,
        duration: Math.round(elapsedMs / 1000),
      },
    });

    const doneEvent: ChatStreamEvent = {
      type: "done",
      messageId: assistantMessage.id,
      durationMs: elapsedMs,
    };

    await stream.writeSSE({ event: "done", data: JSON.stringify(doneEvent) });
  } catch (err) {
    if (abortController.signal.aborted) {
      await persistInterruptedMessage();
      return;
    }

    const message = err instanceof Error ? err.message : String(err);

    await saveSafely({
      sessionId,
      role: "ERROR",
      status: MessageStatus.COMPLETE,
      model,
      content: message,
      mode,
    });

    const errorEvent: ChatStreamEvent = { type: "error", message };
    await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
  }
}

const app = new Hono()
  .post("/:sessionId/resume", async (c) => {
    const sessionId = c.req.param("sessionId");

    const session = await db.session.findUnique({
      where: { id: sessionId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const resumableMessage = getResumableUserMessage(session.messages);
    if (!resumableMessage) {
      return c.json({ error: "Session has no pending user message to resume" }, 409);
    }

    if (!isSupportedChatModel(resumableMessage.model)) {
      return c.json(
        { error: `Session uses unsupported model: ${resumableMessage.model}` },
        409,
      );
    }

    if (activeResumeSessionIds.has(sessionId)) {
      return c.json({ error: "Session already has an active resume" }, 409);
    }

    activeResumeSessionIds.add(sessionId);

    const history = buildConversationHistory(session.messages);
    const abortController = new AbortController();

    return streamSSE(
      c,
      async (stream) => {
        stream.onAbort(() => {
          abortController.abort();
        });

        try {
          await streamAIResponse(stream, {
            sessionId,
            model: resumableMessage.model,
            history,
            mode: resumableMessage.mode,
            abortController,
          });
        } finally {
          activeResumeSessionIds.delete(sessionId);
        }
      },
      async (err, stream) => {
        activeResumeSessionIds.delete(sessionId);
        const message = err instanceof Error ? err.message : String(err);
        const errorEvent: ChatStreamEvent = { type: "error", message };
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(errorEvent),
        });
      },
    );
  })
  .post("/:sessionId", submitValidator, async (c) => {
    const sessionId = c.req.param("sessionId");

    const session = await db.session.findUnique({
      where: { id: sessionId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const data = c.req.valid("json");

    await db.message.create({
      data: {
        sessionId,
        role: "USER",
        status: MessageStatus.COMPLETE,
        model: data.model,
        content: data.content,
        mode: data.mode,
      },
    });

    const history = buildConversationHistory([
      ...session.messages,
      {
        role: "USER" as const,
        content: data.content,
        status: MessageStatus.COMPLETE,
      },
    ]);

    const abortController = new AbortController();

    return streamSSE(
      c,
      async (stream) => {
        stream.onAbort(() => {
          abortController.abort();
        });

        await streamAIResponse(stream, {
          sessionId,
          model: data.model,
          history,
          mode: data.mode,
          abortController,
        });
      },
      async (err, stream) => {
        const message = err instanceof Error ? err.message : String(err);
        const errorEvent: ChatStreamEvent = { type: "error", message };
        await stream.writeSSE({ event: "error", data: JSON.stringify(errorEvent) });
      },
    );
  });

export default app;