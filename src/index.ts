import * as dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import { App, LogLevel } from "@slack/bolt";
import * as dotenv from "dotenv";

import { think, BrainError } from "./brain";
import { toSlackMrkdwn, chunkForSlack } from "./format";

dotenv.config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,

  logLevel: LogLevel.DEBUG,
});

// slash command: /ask

app.command("/ask", async ({ command, ack, client, logger }) => {
  await ack();
  const query = command.text.trim();
  const userId = command.user_id;
  const channelId = command.channel_id;

  if (!query) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: "ask me anything. usage: `/ask what changed in the repo last week?`",
    });
    return;
  }

  // 1. post the question publicly so the thread has context
  let parent;
  try {
    parent = await client.chat.postMessage({
      channel: channelId,
      text: `<@${userId}> asked: *${query}*`,
    });
  } catch (err) {
    logger.error("failed to post question to slack:", err);
    return;
  }

  // 2. show thinking indicator in the thread
  let thinking;
  try {
    thinking = await client.chat.postMessage({
      channel: channelId,
      thread_ts: parent.ts,
      text: "_thinking..._",
    });
  } catch (err) {
    logger.warn("thinking indicator failed (non-fatal):", err);
  }

  // 3. call the brain
  let answer: string;
  try {
    answer = await think(query);
    logger.info(`gemini returned ${answer.length} chars`);
  } catch (err) {
    const msg = err instanceof BrainError ? err.message : "unknown brain error";
    logger.error("brain failed:", err);

    if (thinking?.ts) {
      await client.chat
        .update({
          channel: channelId,
          ts: thinking.ts,
          text: `⚠️ ${msg}`,
        })
        .catch(() => {});
    } else {
      await client.chat
        .postMessage({
          channel: channelId,
          thread_ts: parent.ts,
          text: `⚠️ ${msg}`,
        })
        .catch(() => {});
    }
    return;
  }

  // 4. format and post the answer
  const formatted = toSlackMrkdwn(answer);
  const chunks = chunkForSlack(formatted);

  try {
    if (thinking?.ts) {
      // replace the "thinking..." with the first chunk
      await client.chat.update({
        channel: channelId,
        ts: thinking.ts,
        text: chunks[0],
      });
      // post any additional chunks
      for (const chunk of chunks.slice(1)) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: parent.ts,
          text: chunk,
        });
      }
    } else {
      // no thinking indicator — just post chunks
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: parent.ts,
          text: chunk,
        });
      }
    }
  } catch (err) {
    logger.error("failed to post answer:", err);
    await client.chat
      .postMessage({
        channel: channelId,
        thread_ts: parent.ts,
        text: "⚠️ answer generated but slack post failed. check logs.",
      })
      .catch(() => {});
  }
});
// @amber mentions
app.event("app_mention", async ({ event, say }) => {
  await say({
    text: `hi <@${event.user}>, amber is alive. brain coming soon.`,
    thread_ts: event.ts,
  });
});

app.message(async ({ message, client, logger }) => {
  if (message.channel_type !== 'im') return;
  if (!('text' in message) || !message.text) return;
  if ('bot_id' in message && message.bot_id) return;
  if (message.text.startsWith('/')) return;

  const query = message.text.trim();
  const channelId = message.channel;

  // post thinking
  let thinking;
  try {
    thinking = await client.chat.postMessage({
      channel: channelId,
      text: '_thinking..._',
    });
  } catch (err) {
    logger.warn('thinking post failed:', err);
  }

  // think
  let answer: string;
  try {
    answer = await think(query);
  } catch (err) {
    const msg = err instanceof BrainError ? err.message : 'unknown brain error';
    logger.error('brain failed:', err);
    if (thinking?.ts) {
      await client.chat.update({ channel: channelId, ts: thinking.ts, text: `⚠️ ${msg}` }).catch(() => {});
    }
    return;
  }

  // format + post
  const formatted = toSlackMrkdwn(answer);
  const chunks = chunkForSlack(formatted);

  try {
    if (thinking?.ts) {
      await client.chat.update({ channel: channelId, ts: thinking.ts, text: chunks[0] });
      for (const chunk of chunks.slice(1)) {
        await client.chat.postMessage({ channel: channelId, text: chunk });
      }
    } else {
      for (const chunk of chunks) {
        await client.chat.postMessage({ channel: channelId, text: chunk });
      }
    }
  } catch (err) {
    logger.error('failed to post answer:', err);
  }
});

// reaction feedback (will feed the router later)
app.event("reaction_added", async ({ event }) => {
  console.log(`reaction: ${event.reaction} on message ${event.item.ts}`);
});

(async () => {
  await app.start();
  console.log("⚡ amber is running");
})();
