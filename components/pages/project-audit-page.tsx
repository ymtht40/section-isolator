'use client';

import { useCallback, useRef, useState } from 'react';
import { Archive, Check, Copy, Download, FileArchive, Globe, Loader2, RotateCcw, Upload } from 'lucide-react';
import { AuditResults } from '@/components/audit';
import { auditProject, reportToMarkdown, type AuditReport } from '@/lib/project-audit';
import { loadUrl, loadZip } from '@/lib/project-loader';
import { copyToClipboard, downloadFile } from '@/lib/css-extractor';

type Mode = 'zip' | 'url';

const CARD = { background: 'rgb(22, 22, 22)', border: '1px solid rgba(255,255,255,0.07)' } as const;
const MUTED = 'rgba(255,255,255,0.5)';
const FAINT = 'rgba(255,255,255,0.25)';

const outlineBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 16px',
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 500,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#fff',
};
const primaryBtn: React.CSSProperties = {
  ...outlineBtn,
  background: '#ff3700',
  border: '1px solid #ff3700',
};

export function ProjectAuditPage() {
  const [mode, setMode] = useState<Mode>('zip');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<AuditReport | null>(null);
  const [source, setSource] = useState('');
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const canRun = mode === 'zip' ? !!zipFile : url.trim().length > 3;

  const pickZip = useCallback((f?: File) => {
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) {
      setError('Please choose a .zip file.');
      return;
    }
    setError('');
    setZipFile(f);
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const loaded = mode === 'zip' ? await loadZip(zipFile!) : await loadUrl(url.trim());
      // let the spinner paint before the (synchronous) analysis starts
      await new Promise((r) => setTimeout(r, 30));
      const result = auditProject(loaded.files, {
        warnings: loaded.warnings,
        externalStylesheets: loaded.externalStylesheets,
        ignoreExternal: loaded.fetchedStylesheets,
      });
      setSource(mode === 'zip' ? zipFile!.name : url.trim());
      setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, [mode, zipFile, url]);

  const reset = () => {
    setReport(null);
    setZipFile(null);
    setUrl('');
    setError('');
  };

  const handleCopy = async () => {
    if (!report) return;
    if (await copyToClipboard(reportToMarkdown(report))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <p className="font-serif italic text-sm mb-1" style={{ color: FAINT }}>
            Web Section Isolator
          </p>
          <h1 className="text-[28px] font-semibold tracking-[-0.04em]">Project Audit</h1>
        </div>
        {report && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handleCopy} style={outlineBtn}>
              {copied ? <Check className="h-4 w-4" style={{ color: '#2ECC71' }} /> : <Copy className="h-4 w-4" />}
              <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy report'}</span>
            </button>
            <button
              onClick={() => downloadFile(JSON.stringify(report, null, 2), 'project-audit.json', 'application/json')}
              style={outlineBtn}
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">JSON</span>
            </button>
            <button onClick={reset} style={outlineBtn}>
              <RotateCcw className="h-4 w-4" />
              <span className="hidden sm:inline">New audit</span>
            </button>
          </div>
        )}
      </div>

      {!report && (
        <div className="rounded-[24px] p-5 animate-card-in" style={CARD}>
          <p className="text-sm mb-5" style={{ color: MUTED }}>
            Load a project and see which classes and design tokens are <b style={{ color: '#fff' }}>missing</b>,{' '}
            <b style={{ color: '#fff' }}>unused</b>, or <b style={{ color: '#fff' }}>hard-coded</b>.
          </p>

          <div className="flex gap-2 mb-4">
            {([
              ['zip', 'ZIP upload', Archive],
              ['url', 'Website URL', Globe],
            ] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => {
                  setMode(id);
                  setError('');
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium"
                style={{
                  background: mode === id ? 'rgba(255,255,255,0.08)' : 'transparent',
                  border: `1px solid ${mode === id ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.07)'}`,
                  color: mode === id ? '#fff' : MUTED,
                }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          {mode === 'zip' ? (
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pickZip(e.dataTransfer.files[0]);
              }}
              className="rounded-[16px] py-10 px-4 flex flex-col items-center text-center cursor-pointer transition-colors"
              style={{
                background: dragOver ? 'rgba(255,55,0,0.06)' : 'rgb(18,18,18)',
                border: `1px dashed ${dragOver ? '#ff3700' : 'rgba(255,255,255,0.12)'}`,
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => pickZip(e.target.files?.[0])}
              />
              {zipFile ? (
                <>
                  <FileArchive className="h-7 w-7 mb-3" style={{ color: '#ff3700' }} />
                  <span className="text-sm font-medium">{zipFile.name}</span>
                  <span className="text-[11px] font-mono mt-1" style={{ color: FAINT }}>
                    {(zipFile.size / 1024 / 1024).toFixed(2)} MB · click to replace
                  </span>
                </>
              ) : (
                <>
                  <Upload className="h-7 w-7 mb-3" style={{ color: MUTED }} />
                  <span className="text-sm font-medium">Drop a project .zip here</span>
                  <span className="text-[11px] mt-1" style={{ color: FAINT }}>
                    HTML, CSS/SCSS, JSX/TSX, Vue, Svelte, Astro… node_modules is ignored
                  </span>
                </>
              )}
            </div>
          ) : (
            <div>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canRun && !loading && run()}
                placeholder="https://example.com"
                className="w-full rounded-[12px] px-4 py-3 font-mono text-sm outline-none"
                style={{ background: 'rgb(18,18,18)', border: '1px solid rgba(255,255,255,0.05)' }}
              />
              <p className="text-[11px] mt-2" style={{ color: FAINT }}>
                Analyses one page and its linked stylesheets. Client-rendered apps work better as a ZIP.
              </p>
            </div>
          )}

          {error && (
            <p className="text-[13px] mt-4" style={{ color: '#ff3700' }}>
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end">
            <button
              onClick={run}
              disabled={!canRun || loading}
              style={{ ...primaryBtn, opacity: !canRun || loading ? 0.5 : 1 }}
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? 'Analysing…' : 'Run audit'}
            </button>
          </div>
        </div>
      )}

      {report && (
        <>
          <p className="text-[12px] font-mono mb-4 break-all" style={{ color: FAINT }}>
            {source}
          </p>
          <AuditResults report={report} />
        </>
      )}
    </div>
  );
}
