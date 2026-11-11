/** Only numeric status/code metadata is exposed; never provider messages or bodies. */
export function registrationFailureMessage(error: unknown): string {
  const details = typeof error === 'object' && error !== null
    ? error as { status?: unknown; code?: unknown } : {};
  const status = typeof details.status === 'number' && Number.isInteger(details.status)
    && details.status >= 100 && details.status <= 599 ? details.status : undefined;
  const code = typeof details.code === 'number' && Number.isSafeInteger(details.code)
    && details.code >= 0 ? details.code : undefined;
  const metadata = [status === undefined ? '' : `HTTP ${status}`,
    code === undefined ? '' : `Discord ${code}`].filter(Boolean).join(', ');
  let hint = 'Discord 연결 상태와 봇 설정을 확인하세요.';
  if (status === 401) {
    hint = '.env의 DISCORD_BOT_TOKEN을 확인하세요. Client Secret이 아닌 Bot Token이 필요합니다.';
  } else if (code === 10004) {
    hint = '대상 서버를 찾을 수 없습니다. 봇을 해당 서버에 서버 설치(Guild Install)하고 DISCORD_GUILD_ID를 확인하세요.';
  } else if (code === 50001 || code === 50013 || status === 403) {
    hint = '대상 서버 접근 권한이 없습니다. bot 및 applications.commands 범위로 봇을 서버에 설치했는지 확인하세요. 사용자 설치만으로는 부족합니다.';
  } else if (code === 10002 || code === 20012) {
    hint = 'DISCORD_CLIENT_ID가 이 봇의 Application ID와 일치하는지 확인하세요.';
  }
  return `명령 등록 실패${metadata ? ` (${metadata})` : ''}: ${hint}`;
}
