import { assertRuntime, ConfigError, loadEnvironment, readConfig } from './config.js';
import { VoiceProbeBot } from './bot.js';
import { closeRunLog, diagnostic, LogStorageError, startRunLog } from './log.js';
import { UsageStorageError } from './usage.js';

let bot: VoiceProbeBot | undefined;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 5_000);
  deadline.unref();
  try { await bot?.shutdown(); }
  finally { closeRunLog(); clearTimeout(deadline); }
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  startRunLog({ onFailure: () => { process.exitCode = 1; void shutdown(); } });
  assertRuntime();
  loadEnvironment();
  bot = new VoiceProbeBot(readConfig());
  await bot.login();
} catch (error) {
  if (error instanceof ConfigError) {
    diagnostic('startup_configuration_error', { message: error.message });
    console.error(error.message);
  } else if (error instanceof UsageStorageError) {
    diagnostic('startup_usage_error', { code: error.code });
    console.error('사용량 파일 또는 프로세스 잠금 오류입니다. 기존 봇 프로세스가 실행 중인지 확인하세요. data/usage.json을 삭제하면 비용 한도가 초기화되므로 삭제하지 마세요.');
  } else if (error instanceof LogStorageError) console.error(error.message);
  else {
    diagnostic('startup_failed');
    console.error('봇 시작에 실패했습니다. logs 폴더의 실행 로그를 확인하세요.');
  }
  await shutdown();
  process.exitCode = 1;
}
