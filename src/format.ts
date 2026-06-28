/**
 * convert gemini's standard markdown to slack mrkdwn.
 * slack uses *bold* (not **bold**), _italic_ (not *italic*),
 * ~strike~ (not ~~strike~~), and has no native h1/h2/h3 — we map
 * headings to bold lines.
 */
export function toSlackMrkdwn(md: string): string {
  let s = md;

  // code blocks first (preserve their contents)
  const codeBlocks: string[] = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  // inline code (preserve)
  const inlineCode: string[] = [];
  s = s.replace(/`[^`\n]+`/g, (m) => {
    inlineCode.push(m);
    return `\u0000IC${inlineCode.length - 1}\u0000`;
  });

  // headings → bold line
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // bold: **text** or __text__ → *text*
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  s = s.replace(/__([^_\n]+)__/g, '*$1*');

  // italic: *text* or _text_ → _text_  (only if not already part of bold)
  // gemini rarely uses single * for italic mid-text, so we keep this gentle
  s = s.replace(/(?<![\*\w])\*([^\*\n]+)\*(?!\*)/g, '_$1_');

  // strikethrough: ~~text~~ → ~text~
  s = s.replace(/~~([^~\n]+)~~/g, '~$1~');

  // links: [text](url) → <url|text>
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // bullets: "* " or "- " at line start → "• "
  s = s.replace(/^[\*\-]\s+/gm, '• ');

  // numbered lists: keep as-is, slack renders them fine

  // restore inline code
  s = s.replace(/\u0000IC(\d+)\u0000/g, (_, i) => inlineCode[+i]);
  // restore code blocks
  s = s.replace(/\u0000CB(\d+)\u0000/g, (_, i) => codeBlocks[+i]);

  return s.trim();
}

/**
 * split a long answer into slack-safe chunks (slack message limit is 40k chars
 * but rendering breaks well before that — chunk at ~3000 chars on paragraph boundaries).
 */
export function chunkForSlack(text: string, maxLen = 3000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length > maxLen && buf) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}