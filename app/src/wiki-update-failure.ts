import { AppError } from './contracts.js';

const failureReasons = {
  generation_request_failed: '生成APIの呼び出しが完了しませんでした。',
  generation_incomplete: '生成応答が完了状態ではありませんでした。',
  output_too_large: '生成出力がサイズ上限を超えました。',
  json_invalid: '生成出力をJSONとして解析できませんでした。',
  output_shape: '生成結果全体の構造・必須項目・件数が契約に一致しませんでした。',
  comparison_check: 'Wiki比較の構造・件数・ページ番号が契約に一致しませんでした。',
  comparison_conflict: '最新Wikiとの比較が矛盾または判断不能でした。',
  evidence_check: '原資料比較の構造・件数・資料番号が契約に一致しませんでした。',
  evidence_conflict: '正式原資料との比較が矛盾または判断不能でした。',
  operation_shape: '更新操作の構造・対象番号・件数が契約に一致しませんでした。',
  edit_shape: '編集断片の構造・番号・文字列・サイズが契約に一致しませんでした。',
  fragment_mismatch: '編集前の断片が最新行に一意に一致しませんでした。',
  append_boundary: '追記の編集前断片または先頭の改行境界が契約に一致しませんでした。',
  section_boundary: '更新本文と次の見出しを区切る末尾改行がありませんでした。',
  heading_changed: '採用範囲外の見出し構造が変わるため停止しました。',
  body_invalid: '適用後の本文が空になりました。',
  page_invalid: '適用後のページが本文・属性・サイズの保存契約に一致しませんでした。',
} as const;
export type WikiUpdateFailureReason = keyof typeof failureReasons;
export function isWikiUpdateFailureReason(value:unknown):value is WikiUpdateFailureReason {
  return typeof value==='string' && Object.hasOwn(failureReasons,value);
}
export class WikiUpdateError extends AppError {
  constructor(public readonly reason:WikiUpdateFailureReason) {
    super(reason==='generation_request_failed' ? 'wiki_processing_failed':reason==='comparison_conflict' || reason==='evidence_conflict' ? 'wiki_comparison_changed':reason==='page_invalid' ? 'invalid_wiki':'invalid_wiki_output');
  }
}
export function wikiUpdateFailureText(value:unknown):string {
  return isWikiUpdateFailureReason(value) ? `停止理由 [${value}]: ${failureReasons[value]} Wiki本文は更新していません。`:'';
}
