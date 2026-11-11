import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('start')
    .setDescription('실시간 번역 또는 수음 검증 시작 (설정된 관리자 전용)'),
  new SlashCommandBuilder().setName('stop')
    .setDescription('음성 수신 종료 및 임시 상태 제거 (설정된 관리자 전용)'),
];
