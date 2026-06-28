import * as dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { App, LogLevel } from "@slack/bolt";
import * as dotenv from "dotenv";
import { think, BrainError, ThinkResult } from "./brain";
import { toSlackMrkdwn, chunkForSlack } from "./format";
import { McpRegistry } from "./mcp/registry";
import { SERVER_CONFIGS } from "./mcp/servers";

dotenv.config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// global registry. populated at startup.
const registry = new McpRegistry();

/**
 * shared answer pipeline used by both /ask and DMs.
 */
async function answer({
  query,
  channelId,
  userId,
  threadTs,
  client,
  logger,
}: {
  query: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  client: any;
  logger: any;
}) {
  // post the thinking indicator (or skip if we couldn't)
  let statusMsg: { ts?: string } | undefined;
  try {
    statusMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "_thinking..._",
    });
  } catch (err) {
    logger.warn("status post failed:", err);
  }

  // update helper that swallows errors
  const updateStatus = async (text: string) => {
    if (!statusMsg?.ts) return;
    try {
      await client.chat.update({ channel: channelId, ts: statusMsg.ts, text });
    } catch {}
  };

  // call the brain
  let result: ThinkResult;
  try {
    result = await think({
      query,
      registry,
      onToolCall: (name) => {
        const pretty = name.replace("__", " → ");
        updateStatus(`_calling ${pretty}..._`);
      },
    });
  } catch (err) {
    const msg = err instanceof BrainError ? err.message : "unknown brain error";
    logger.error("brain failed:", err);
    await updateStatus(`⚠️ ${msg}`);
    return;
  }

  // format
  const formatted = toSlackMrkdwn(result.answer);
  const chunks = chunkForSlack(formatted);

  // add a routing footer if tools were used
  let footer = "";
  if (result.toolsUsed.length > 0) {
    const toolNames = [...new Set(result.toolsUsed.map((t) => t.name))]
      .map((n) => `\`${n}\``)
      .join(", ");
    footer = `\n\n_routed via: ${toolNames}_`;
  }
  chunks[chunks.length - 1] += footer;

  // post: replace status with first chunk, then post the rest
  try {
    if (statusMsg?.ts) {
      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: chunks[0],
      });
      for (const chunk of chunks.slice(1)) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: chunk,
        });
      }
    } else {
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: chunk,
        });
      }
    }
  } catch (err) {
    logger.error("failed to post answer:", err);
  }
}

// slash command
app.command("/ask", async ({ command, ack, client, logger }) => {
  await ack();
  const query = command.text.trim();
  if (!query) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "ask me anything. usage: `/ask what are the open prs in <owner>/<repo>?`",
    });
    return;
  }

  const parent = await client.chat.postMessage({
    channel: command.channel_id,
    text: `<@${command.user_id}> asked: *${query}*`,
  });

  await answer({
    query,
    channelId: command.channel_id,
    userId: command.user_id,
    threadTs: parent.ts,
    client,
    logger,
  });
});

// DMs as questions
app.message(async ({ message, client, logger }) => {
  if (message.channel_type !== "im") return;
  if (!("text" in message) || !message.text) return;
  if ("bot_id" in message && message.bot_id) return;
  if (message.text.startsWith("/")) return;

  await answer({
    query: message.text.trim(),
    channelId: message.channel,
    userId: (message as any).user,
    client,
    logger,
  });
});

// @mentions
app.event("app_mention", async ({ event, client, logger }) => {
  const text = event.text.replace(/<@[^>]+>/g, "").trim();
  if (!text) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "mention me with a question and i'll route it across my tools.",
    });
    return;
  }
  await answer({
    query: text,
    channelId: event.channel,
    userId: event.user!,
    threadTs: event.ts,
    client,
    logger,
  });
});

// reactions: feedback signal (logged for now, becomes router signal in week 2)
app.event("reaction_added", async ({ event, logger }) => {
  logger.info(`reaction: :${event.reaction}: on ${event.item.ts}`);
});

// startup: register all MCP servers, then start slack
(async () => {
  console.log("[amber] starting...");
  for (const config of SERVER_CONFIGS) {
    try {
      await registry.register(config);
    } catch (err) {
      console.error(
        `[amber] could not register ${config.id}, continuing without it`,
      );
    }
  }
  console.log(
    `[amber] ${registry.getAllTools().length} tools available across ${SERVER_CONFIGS.length} servers`,
  );

  await app.start();
  console.log("⚡ amber is running");
})();

// graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[amber] shutting down...");
  await registry.shutdown();
  process.exit(0);
});
