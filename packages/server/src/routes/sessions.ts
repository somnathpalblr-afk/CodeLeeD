import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@CodeLeeD/database/client";
import { Role, Mode, MessageStatus } from "@CodeLeeD/database/enums";
import { findSupportedChatModel } from "@CodeLeeD/shared";

const createSessionSchema = z.object({
  title: z.string(),
  cwd: z.string().optional(),
  initialMessage: z
    .object({
      role: z.enum(Role),
      content: z.string(),
      mode: z.enum(Mode),
      model: z
        .string()
        .refine((id) => !!findSupportedChatModel(id), "Unsupported model"),
    })
    .optional(),
});

const createSessionValidator = zValidator(
  "json",
  createSessionSchema,
  (result, c) => {
    if (!result.success) {
      // Changed: includes `issues` so you can see which field failed.
      // Remove `issues` if you don't want to expose it.
      return c.json(
        { error: "Invalid request body", issues: result.error.issues },
        400
      );
    }
  }
);

const app = new Hono()
  .get("/", async (c) => {
    const list = await db.session.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, createdAt: true },
    });

    return c.json(list);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");

    const session = await db.session.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json(session);
  })
  .post("/", createSessionValidator, async (c) => {
    const { initialMessage, ...data } = c.req.valid("json");

    const session = await db.session.create({
      data: {
        ...data,
        userId: "mock-user",
        ...(initialMessage && {
          messages: {
            create: {
              ...initialMessage,
              status: MessageStatus.COMPLETE,
            },
          },
        }),
      },
      include: { messages: true },
    });

    return c.json(session, 201);
  });

export default app;