import { startDashboardServer } from './dashboard-server.js';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
  console.log('사용법: npm run dashboard [-- --port 3210]\n로컬 logs/를 읽는 실시간 테스트 화면입니다. 봇은 별도 터미널에서 실행하세요.');
} else {
  const port = args.length === 0 ? 3210 : args.length === 2 && args[0] === '--port' ? Number(args[1]) : NaN;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    console.error('사용법: npm run dashboard [-- --port 3210] (포트 1024~65535)'); process.exitCode = 1;
  } else {
    try {
      const dashboard = await startDashboardServer({ port });
      console.log(`실시간 테스트 화면: ${dashboard.url}\n봇의 최신 실행 로그를 자동으로 따라갑니다. 종료: Ctrl+C`);
      let stopping = false;
      const stop = () => { if (stopping) return; stopping = true; void dashboard.close(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    } catch (error) {
      console.error(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
        ? `포트 ${port}가 사용 중입니다. npm run dashboard -- --port ${port + 1}로 실행하세요.`
        : '테스트 화면을 시작하지 못했습니다. 실행 폴더와 로컬 서버 권한을 확인하세요.');
      process.exitCode = 1;
    }
  }
}
