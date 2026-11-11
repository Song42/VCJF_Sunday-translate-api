import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { assertRuntime, ConfigError, loadEnvironment, readConfig } from './config.js';
import { diagnostic } from './log.js';
import { registrationFailureMessage } from './discord-errors.js';

try {
  assertRuntime();
  loadEnvironment();
  const config = readConfig();
  const rest = new REST({ version: '10' }).setToken(config.botToken);
  // Upsert only our two commands; do not bulk overwrite other guild commands.
  for (const command of commands) {
    await rest.post(Routes.applicationGuildCommands(config.clientId, config.guildId), {
      body: command.toJSON(),
    });
  }
  diagnostic('commands_registered', { count: commands.length });
} catch (error) {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error(registrationFailureMessage(error));
  process.exitCode = 1;
}
