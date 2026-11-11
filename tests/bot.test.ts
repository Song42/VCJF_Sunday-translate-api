import assert from 'node:assert/strict';
import test from 'node:test';
import { Events, MessageFlags, type Interaction } from 'discord.js';
import { VoiceProbeBot } from '../src/bot.js';
import type { Config } from '../src/config.js';

const config: Config = {
  botToken: 'unused-test-token', clientId: '111111111111111111',
  guildId: '222222222222222222', voiceChannelId: '333333333333333333',
  adminUserId: '444444444444444444', consentConfirmed: false, silenceMs: 850,
};

async function command(bot: VoiceProbeBot, name: string, guildId: string | null, userId: string) {
  const replies: { kind: string; value: unknown }[] = [];
  const interaction = {
    isChatInputCommand: () => true, commandName: name, guildId, user: { id: userId },
    reply: async (value: unknown) => { replies.push({ kind: 'reply', value }); },
    deferReply: async (value: unknown) => { replies.push({ kind: 'defer', value }); },
    editReply: async (value: unknown) => { replies.push({ kind: 'edit', value }); },
  } as unknown as Interaction;
  bot.client.emit(Events.InteractionCreate, interaction);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return replies;
}

test('actual command handler denies outsiders, wrong guilds and DMs before work', async () => {
  const bot = new VoiceProbeBot(config);
  try {
    for (const name of ['start', 'stop']) {
      for (const [guildId, userId] of [[config.guildId, 'outsider'], ['wrong-guild', config.adminUserId], [null, config.adminUserId]] as const) {
        const replies = await command(bot, name, guildId, userId);
        assert.equal(replies.length, 1);
        assert.equal(replies[0]?.kind, 'reply');
        const reply = replies[0]?.value as { flags: MessageFlags; content: string };
        assert.equal(reply.flags, MessageFlags.Ephemeral);
        assert.match(reply.content, /관리자/);
      }
    }
  } finally { await bot.shutdown(); }
});

test('authorized start cannot capture before consent; idle stop is safe and repeatable', async () => {
  const bot = new VoiceProbeBot(config);
  try {
    const replies = await command(bot, 'start', config.guildId, config.adminUserId);
    assert.equal(replies[0]?.kind, 'defer');
    assert.match(String(replies[1]?.value), /동의/);
    for (let i = 0; i < 2; i += 1) {
      const stopped = await command(bot, 'stop', config.guildId, config.adminUserId);
      assert.match(String(stopped[1]?.value), /없습니다/);
    }
  } finally { await bot.shutdown(); }
});
