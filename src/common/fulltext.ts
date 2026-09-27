export function mysqlBooleanTerms(query: string, ngram: boolean): string {
  const pieces = query.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) || [];
  const tokens: string[] = [];
  for (const piece of pieces) {
    if (ngram && /^[\p{Script=Han}]+$/u.test(piece)) {
      const chars = Array.from(piece);
      for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
    } else tokens.push(piece);
  }
  return [...new Set(tokens)].filter((token) => Array.from(token).length >= 2)
    .map((token) => `+${token.replace(/[+\-~*<>"()@]/g, ' ')}*`).join(' ');
}
