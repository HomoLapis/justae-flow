/**
 * Looks for secrets and private strings in the files git would commit.
 *
 *   node scripts/scan-secrets.ts          (exit 1 on any finding)
 *
 * Patterns: API keys and tokens of the usual providers, private keys, private
 * deployment URLs, e-mail addresses and the local user's own name in paths.
 * Run before every commit; the pre-commit hook runs it too.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';

const user = userInfo().username;
const PATTERNS: Array<[string, RegExp]> = [
  ['Comfy API key', /\bcomfyui-[A-Za-z0-9]{20,}/],
  ['OpenAI / Anthropic style key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Bearer token', /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ['Private deployment URL', /[a-z0-9-]+\.modal\.run|[a-z0-9-]+--[a-z0-9-]+\.modal/i],
  ['Assignment of a secret', /\b(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
  ['E-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|it|org|net|io|ai)\b/],
  ['Local user name in a path', new RegExp(`[\\\\/](Users|home)[\\\\/]${user}\\b`, 'i')],
];
const ALLOW = [/noreply@anthropic\.com/, /@example\.(com|invalid)/];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((f) => f && !/\.(png|jpe?g|webp|mp4|ico|woff2?)$/i.test(f) && !f.startsWith('node_modules/'));

let findings = 0;
for (const f of files) {
  if (/(^|\/)\.env$/.test(f)) { console.log(`✖ ${f}: an .env file must never be committed`); findings++; continue; }
  let text: string;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      const m = re.exec(line);
      if (m && !ALLOW.some((a) => a.test(m[0]))) {
        console.log(`✖ ${f}:${i + 1}  ${name}: ${m[0].slice(0, 12)}…`);
        findings++;
      }
    }
  });
}
console.log(findings ? `\n${findings} finding(s) in ${files.length} files.` : `✔ No secrets or private strings in ${files.length} files.`);
process.exit(findings ? 1 : 0);
