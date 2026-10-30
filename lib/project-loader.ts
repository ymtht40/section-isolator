// Loads a project (ZIP upload or live URL) into a flat list of text files
// that `auditProject` can analyse.

import type { ProjectFile } from './project-audit';

const TEXT_EXT =
  /\.(html?|css|pcss|postcss|scss|less|jsx?|tsx?|mjs|cjs|vue|svelte|astro|php|mdx|liquid|njk|hbs|ejs|erb|twig|cshtml|json)$/i;

const SKIP_DIR =
  /(^|\/)(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|__MACOSX|coverage|\.vercel|\.output)(\/|$)/i;

const SKIP_FILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[\w.-]*\.json|components\.json|\.DS_Store)$|\.(min\.js|map|d\.ts)$/i;

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file
const MAX_TOTAL_CHARS = 40 * 1024 * 1024; // 40 M chars overall
const MAX_FILES = 6000;

export interface LoadResult {
  files: ProjectFile[];
  skipped: number;
  warnings: string[];
  externalStylesheets?: string[];
  fetchedStylesheets?: string[];
}

export async function loadZip(file: File): Promise<LoadResult> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(file);

  const entries = Object.values(zip.files).filter((e) => !e.dir);
  const warnings: string[] = [];
  const files: ProjectFile[] = [];
  let skipped = 0;
  let total = 0;

  // strip a single wrapping folder (my-project/…)
  const firstSeg = new Set(entries.map((e) => e.name.split('/')[0]));
  const strip = firstSeg.size === 1 && entries.every((e) => e.name.includes('/'));

  for (const entry of entries) {
    const path = strip ? entry.name.split('/').slice(1).join('/') : entry.name;
    if (SKIP_DIR.test(path) || SKIP_FILE.test(path) || !TEXT_EXT.test(path)) {
      skipped++;
      continue;
    }
    if (files.length >= MAX_FILES) {
      warnings.push(`Stopped after ${MAX_FILES} files — the project is larger than the limit.`);
      break;
    }
    const content = await entry.async('string');
    if (content.length > MAX_FILE_BYTES) {
      skipped++;
      warnings.push(`Skipped ${path} (larger than 2 MB).`);
      continue;
    }
    total += content.length;
    if (total > MAX_TOTAL_CHARS) {
      warnings.push('Stopped reading — total project text exceeded 40 MB.');
      break;
    }
    files.push({ path, content });
  }

  if (!files.length) warnings.push('No readable source files found in this ZIP.');
  return { files, skipped, warnings };
}

export async function loadUrl(url: string): Promise<LoadResult> {
  const res = await fetch('/api/fetch-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return {
    files: data.files as ProjectFile[],
    skipped: 0,
    warnings: (data.warnings as string[]) ?? [],
    externalStylesheets: data.externalStylesheets as string[],
    fetchedStylesheets: data.fetchedStylesheets as string[],
  };
}
