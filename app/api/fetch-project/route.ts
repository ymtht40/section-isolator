import { NextResponse } from 'next/server';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 3 * 1024 * 1024; // per response
const MAX_STYLESHEETS = 25;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed.');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('Local addresses are not allowed.');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw new Error('That address points to a private network and was blocked.');
  return u;
}

async function safeFetch(raw: string): Promise<{ text: string; url: string; type: string }> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(u, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'WebSectionIsolator-Audit/1.0',
          Accept: 'text/html,text/css,*/*;q=0.8',
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, u).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) return { text: '', url: u.toString(), type: res.headers.get('content-type') ?? '' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          ctrl.abort();
          throw new Error('Response is larger than 3 MB.');
        }
        chunks.push(value);
      }
      const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
      return { text, url: u.toString(), type: res.headers.get('content-type') ?? '' };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects.');
}

function stylesheetHrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) out.push(href);
  }
  return out;
}

export async function POST(req: Request) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const input = (body.url ?? '').trim();
  if (!input) return NextResponse.json({ error: 'Enter a URL.' }, { status: 400 });
  const target = /^https?:\/\//i.test(input) ? input : `https://${input}`;

  const warnings: string[] = [];
  try {
    const page = await safeFetch(target);
    if (!/html|xml/i.test(page.type) && !/<html|<!doctype/i.test(page.text.slice(0, 500)))
      throw new Error('That URL did not return an HTML page.');

    const files: { path: string; content: string }[] = [{ path: 'index.html', content: page.text }];
    const fetched: string[] = [];
    const external: string[] = [];

    const hrefs = [...new Set(stylesheetHrefs(page.text))];
    if (hrefs.length > MAX_STYLESHEETS)
      warnings.push(`Page links ${hrefs.length} stylesheets — only the first ${MAX_STYLESHEETS} were fetched.`);

    const pageHost = new URL(page.url).host;
    await Promise.all(
      hrefs.slice(0, MAX_STYLESHEETS).map(async (href, i) => {
        let abs: string;
        try {
          abs = new URL(href, page.url).toString();
        } catch {
          return;
        }
        try {
          const css = await safeFetch(abs);
          const u = new URL(css.url);
          const name = (u.pathname.split('/').pop() || `style-${i}.css`).replace(/[^\w.-]/g, '_');
          const sameOrigin = u.host === pageHost;
          files.push({ path: `${sameOrigin ? '' : u.host + '/'}${name}`, content: css.text });
          fetched.push(abs);
        } catch (e) {
          external.push(abs);
          warnings.push(`Could not fetch ${abs} (${e instanceof Error ? e.message : 'error'}).`);
        }
      })
    );

    // Client-rendered shells have almost no markup to analyse.
    const classAttrs = (page.text.match(/\bclass\s*=/gi) ?? []).length;
    const scripts = (page.text.match(/<script\b[^>]*\bsrc=/gi) ?? []).length;
    if (classAttrs < 5 && scripts > 0)
      warnings.push(
        'This page looks client-rendered (JavaScript builds the DOM), so most classes are not visible in the HTML. For an accurate result, upload the project source as a ZIP.'
      );
    warnings.push('URL mode analyses only this single page and its linked stylesheets.');

    return NextResponse.json({
      files,
      warnings,
      externalStylesheets: external,
      fetchedStylesheets: fetched,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch URL.' },
      { status: 422 }
    );
  }
}
