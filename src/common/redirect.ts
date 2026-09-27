export function safeLocalNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    let decoded = value;
    for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded);
    if (/^\/[\\/]/.test(decoded)) return '/';
    const target = new URL(value, 'https://oldbbs.invalid');
    if (target.origin !== 'https://oldbbs.invalid') return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch { return '/'; }
}
