import type { KnownBlock } from '@slack/web-api';
import { AppError, string, type Consultation } from './contracts.js';
import { escapeSlackText } from './slack.js';

// 長い相談は読みやすい引用に収め、全文への導線を必ず残す。
const quoteLength = 2800;
const fallbackLength = 4000;
const fallbackExcerpt = '…（通知・読み上げ用は抜粋です）';

function displayFallback(prefix: string, body: string, suffix: string): string {
  const escapedPrefix = escapeSlackText(prefix), escapedSuffix = escapeSlackText(suffix);
  const full = escapedPrefix + escapeSlackText(body) + escapedSuffix;
  if (full.length <= fallbackLength) return full;
  const budget = fallbackLength - escapedPrefix.length - escapedSuffix.length - fallbackExcerpt.length;
  if (budget < 0) throw new AppError('invalid_input');
  let excerpt = '';
  // エスケープ実体とサロゲートペアを途中で切らず、本文以外の案内とリンクを残す。
  for (const character of body) {
    const escaped = escapeSlackText(character);
    if (excerpt.length + escaped.length > budget) break;
    excerpt += escaped;
  }
  return escapedPrefix + excerpt + fallbackExcerpt + escapedSuffix;
}

export function consultationDisplay(channel: string, permalink: string, mention: { text: string; botUserId: string }): { text: string; blocks: KnownBlock[] } {
  const prefix = `<@${mention.botUserId}>`;
  const raw = mention.text.trimStart();
  const content = raw.startsWith(prefix) ? raw.slice(prefix.length).trimStart() : raw;
  const body = (raw.startsWith(prefix) && !content.trim() ? '（Botへの呼びかけのみ）' : content)
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  let quote = body;
  const excerpt = body.length > quoteLength;
  if (excerpt) {
    quote = body.slice(0, quoteLength);
    const boundary = Math.max(quote.lastIndexOf('\n'), quote.lastIndexOf('。') + 1, quote.lastIndexOf(' '));
    if (boundary > quoteLength * 0.7) quote = quote.slice(0, boundary);
    quote = quote.replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…';
  }
  if (!quote) throw new AppError('invalid_input');
  const label = excerpt ? '相談本文（抜粋）' : '相談本文';
  return {
    text: displayFallback(`相談元: ${channel}\n${label}\n`, quote, `\n相談元の投稿・全文を開く: ${permalink}`),
    blocks: [
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '相談元: ' }, { type: 'channel', channel_id: channel }] }] },
      { type: 'context', elements: [{ type: 'plain_text', text: label }] },
      { type: 'rich_text', elements: [{ type: 'rich_text_quote', elements: [{ type: 'text', text: quote }] }] },
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: permalink, text: '相談元の投稿・全文を開く' }] }] }
    ]
  };
}

export function sentAnswerDisplay(item: Consultation): { text: string; blocks: KnownBlock[] } {
  if (item.status !== 'sent') throw new AppError('invalid_status');
  const answer = string(item.answer);
  const notice = '送信済み — 元の相談スレッドへ返信しました。';
  return {
    text: displayFallback(`${notice}\n\n`, answer, ''),
    blocks: [{ type: 'context', elements: [{ type: 'plain_text', text: notice }] }, { type: 'section', text: { type: 'plain_text', text: answer } }]
  };
}
