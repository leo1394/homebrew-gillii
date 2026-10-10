export function highlight(text, color, stream = process.stdout) {
  return stream.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' ? `\x1b[1;${color}m${text}\x1b[0m` : text;
}
