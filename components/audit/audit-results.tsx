'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import type { AuditReport } from '@/lib/project-audit';

const CARD = { background: 'rgb(22, 22, 22)', border: '1px solid rgba(255,255,255,0.07)' } as const;
const MUTED = 'rgba(255,255,255,0.5)';
const FAINT = 'rgba(255,255,255,0.25)';
const RED = '#ff3700';
const GREEN = '#2ECC71';
const AMBER = '#f5a623';
const PAGE = 100;

type Tab = 'classes' | 'tokens' | 'hardcoded' | 'map';

function Pill({ active, onClick, children, count, tone }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
  tone?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-colors whitespace-nowrap"
      style={{
        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
        border: `1px solid ${active ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.07)'}`,
        color: active ? '#fff' : MUTED,
      }}
    >
      {children}
      {count !== undefined && (
        <span className="font-mono text-[10px]" style={{ color: count > 0 && tone ? tone : FAINT }}>
          {count}
        </span>
      )}
    </button>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string | number; tone?: string; hint?: string }) {
  return (
    <div className="rounded-[16px] p-4" style={CARD} title={hint}>
      <div className="text-[10px] uppercase tracking-[0.08em] font-mono mb-1.5" style={{ color: FAINT }}>
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-[-0.03em]" style={{ color: tone ?? '#fff' }}>
        {value}
      </div>
    </div>
  );
}

function Mono({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <code className="font-mono text-[12px] break-all" style={{ color: color ?? '#fff' }}>
      {children}
    </code>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
      style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
    >
      {children}
    </div>
  );
}

function Swatch({ value }: { value: string }) {
  if (!/^(#|rgb|hsl|oklch)/i.test(value)) return null;
  return (
    <span
      className="inline-block h-3.5 w-3.5 rounded-[4px] flex-shrink-0"
      style={{ background: value, border: '1px solid rgba(255,255,255,0.2)' }}
    />
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="px-4 py-10 text-center text-sm" style={{ color: MUTED, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ color: GREEN }}>✓</span> {text}
    </div>
  );
}

function List<T>({ items, render, empty, filter }: {
  items: T[];
  render: (item: T) => React.ReactNode;
  empty: string;
  filter: (item: T, q: string) => boolean;
}) {
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const filtered = useMemo(() => (q ? items.filter((i) => filter(i, q.toLowerCase())) : items), [items, q, filter]);

  return (
    <div className="rounded-[20px] overflow-hidden" style={CARD}>
      <div className="flex items-center gap-2 px-4 py-3">
        <Search className="h-3.5 w-3.5" style={{ color: FAINT }} />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShown(PAGE);
          }}
          placeholder={`Filter ${items.length} items…`}
          className="flex-1 bg-transparent outline-none text-[13px] font-mono placeholder:opacity-40"
        />
      </div>
      {filtered.length === 0 ? (
        <Empty text={items.length ? 'No matches' : empty} />
      ) : (
        <>
          {filtered.slice(0, shown).map((it, i) => (
            <Row key={i}>{render(it)}</Row>
          ))}
          {filtered.length > shown && (
            <button
              onClick={() => setShown((s) => s + PAGE)}
              className="w-full py-3 text-[12px]"
              style={{ borderTop: '1px solid rgba(255,255,255,0.05)', color: MUTED }}
            >
              Show more ({filtered.length - shown} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SubTabs<T extends string>({ value, onChange, tabs }: {
  value: T;
  onChange: (v: T) => void;
  tabs: { id: T; label: string; count: number; tone?: string }[];
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 mb-3">
      {tabs.map((t) => (
        <Pill key={t.id} active={value === t.id} onClick={() => onChange(t.id)} count={t.count} tone={t.tone}>
          {t.label}
        </Pill>
      ))}
    </div>
  );
}

const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// ---------------------------------------------------------------------------

function ClassesTab({ r }: { r: AuditReport }) {
  const [sub, setSub] = useState<'missing' | 'unused' | 'matched' | 'framework'>('missing');
  const matched = useMemo(() => r.classes.used.filter((u) => u.status === 'matched'), [r]);
  const f = <T extends { name: string }>(i: T, q: string) => i.name.toLowerCase().includes(q);

  return (
    <>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'missing', label: 'Missing (used, not defined)', count: r.classes.missing.length, tone: RED },
          { id: 'unused', label: 'Unused (defined, not used)', count: r.classes.unused.length, tone: AMBER },
          { id: 'matched', label: 'Matched', count: matched.length, tone: GREEN },
          ...(r.classes.framework.length
            ? [{ id: 'framework' as const, label: 'Framework utilities', count: r.classes.framework.length }]
            : []),
        ]}
      />
      {sub === 'missing' && (
        <List
          items={r.classes.missing}
          empty="Every class used in markup has a CSS definition."
          filter={f}
          render={(c) => (
            <>
              <Mono color={RED}>.{c.name}</Mono>
              {c.suggestion && (
                <span className="text-[11px]" style={{ color: AMBER }}>
                  did you mean <Mono color={AMBER}>.{c.suggestion}</Mono>?
                </span>
              )}
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                ×{c.count} · {c.files[0]}
              </span>
            </>
          )}
        />
      )}
      {sub === 'unused' && (
        <List
          items={r.classes.unused}
          empty="No unused classes found."
          filter={f}
          render={(c) => (
            <>
              <Mono color={c.maybeDynamic ? MUTED : AMBER}>.{c.name}</Mono>
              {c.maybeDynamic && (
                <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(245,166,35,0.12)', color: AMBER }}>
                  maybe dynamic
                </span>
              )}
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                {c.bytes ? `${kb(c.bytes)} · ` : ''}
                {c.files[0]}
              </span>
            </>
          )}
        />
      )}
      {sub === 'matched' && (
        <List
          items={matched}
          empty="Nothing matched yet."
          filter={f}
          render={(c) => (
            <>
              <Mono color={GREEN}>.{c.name}</Mono>
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                ×{c.count}
              </span>
            </>
          )}
        />
      )}
      {sub === 'framework' && (
        <List
          items={r.classes.framework}
          empty=""
          filter={f}
          render={(c) => (
            <>
              <Mono color={MUTED}>{c.name}</Mono>
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                ×{c.count}
              </span>
            </>
          )}
        />
      )}
    </>
  );
}

function TokensTab({ r }: { r: AuditReport }) {
  const [sub, setSub] = useState<'undefined' | 'unused' | 'all'>('undefined');
  const f = <T extends { name: string }>(i: T, q: string) => i.name.toLowerCase().includes(q);

  return (
    <>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'undefined', label: 'Undefined (used, not defined)', count: r.tokens.undefined.length, tone: RED },
          { id: 'unused', label: 'Unused (defined, not used)', count: r.tokens.unused.length, tone: AMBER },
          { id: 'all', label: 'All tokens', count: r.tokens.defined.length },
        ]}
      />
      {sub === 'undefined' && (
        <List
          items={r.tokens.undefined}
          empty="Every var(--token) has a definition."
          filter={f}
          render={(t) => (
            <>
              <Mono color={RED}>{t.name}</Mono>
              {t.hasFallback && (
                <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', color: MUTED }}>
                  has fallback
                </span>
              )}
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                ×{t.refs} · {t.files[0]}
              </span>
            </>
          )}
        />
      )}
      {sub === 'unused' && (
        <List
          items={r.tokens.unused}
          empty="Every defined token is referenced."
          filter={f}
          render={(t) => (
            <>
              <Swatch value={t.value} />
              <Mono color={AMBER}>{t.name}</Mono>
              <span className="text-[11px] font-mono" style={{ color: FAINT }}>
                {t.value}
              </span>
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                {t.scope.length > 28 ? t.scope.slice(0, 28) + '…' : t.scope}
              </span>
            </>
          )}
        />
      )}
      {sub === 'all' && (
        <List
          items={r.tokens.defined}
          empty="No tokens defined."
          filter={f}
          render={(t) => (
            <>
              <Swatch value={t.value} />
              <Mono>{t.name}</Mono>
              <span className="text-[11px] font-mono" style={{ color: FAINT }}>
                {t.value}
              </span>
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                {t.category} · {t.cssRefs + t.sourceRefs}
                {t.utilityUse ? '+util' : ''} refs
              </span>
            </>
          )}
        />
      )}
    </>
  );
}

function HardcodedTab({ r }: { r: AuditReport }) {
  const [sub, setSub] = useState<'match' | 'repeat'>('match');
  const f = (i: { value: string; category: string }, q: string) =>
    i.value.toLowerCase().includes(q) || i.category.includes(q);

  return (
    <>
      <SubTabs
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'match', label: 'Use existing token', count: r.hardcoded.matchesToken.length, tone: AMBER },
          { id: 'repeat', label: 'Create new token', count: r.hardcoded.repeated.length, tone: AMBER },
        ]}
      />
      {sub === 'match' ? (
        <List
          items={r.hardcoded.matchesToken}
          empty="No hard-coded value duplicates an existing token."
          filter={f}
          render={(h) => (
            <>
              <Swatch value={h.value} />
              <Mono>{h.value}</Mono>
              <span className="text-[11px]" style={{ color: MUTED }}>→</span>
              <Mono color={GREEN}>var({h.tokens[0]})</Mono>
              {h.tokens.length > 1 && (
                <span className="text-[10px]" style={{ color: FAINT }}>
                  +{h.tokens.length - 1} more
                </span>
              )}
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                {h.category} · ×{h.count}
              </span>
            </>
          )}
        />
      ) : (
        <List
          items={r.hardcoded.repeated}
          empty="No repeated hard-coded values."
          filter={f}
          render={(h) => (
            <>
              <Swatch value={h.value} />
              <Mono>{h.value}</Mono>
              <span className="text-[11px]" style={{ color: FAINT }}>
                {h.samples.slice(0, 3).join(', ')}
              </span>
              <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
                {h.category} · ×{h.count}
              </span>
            </>
          )}
        />
      )}
    </>
  );
}

function MapTab({ r }: { r: AuditReport }) {
  return (
    <List
      items={r.map}
      empty="No class uses tokens or hard-coded values."
      filter={(i, q) => i.className.toLowerCase().includes(q) || i.tokens.some((t) => t.includes(q))}
      render={(m) => (
        <div className="w-full">
          <div className="flex items-center gap-2">
            <Mono color={m.usedInMarkup ? '#fff' : AMBER}>.{m.className}</Mono>
            {!m.usedInMarkup && (
              <span className="text-[10px]" style={{ color: AMBER }}>
                unused
              </span>
            )}
            <span className="ml-auto text-[11px] font-mono" style={{ color: FAINT }}>
              {m.files[0]}
            </span>
          </div>
          {(m.tokens.length > 0 || m.hardcoded.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.tokens.map((t) => (
                <span
                  key={t}
                  className="font-mono text-[11px] px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(46,204,113,0.1)', color: GREEN }}
                >
                  {t}
                </span>
              ))}
              {m.hardcoded.map((h, i) => (
                <span
                  key={i}
                  className="font-mono text-[11px] px-2 py-0.5 rounded-full flex items-center gap-1.5"
                  style={{ background: 'rgba(245,166,35,0.1)', color: AMBER }}
                  title={h.token ? `Already tokenised as ${h.token}` : 'No matching token'}
                >
                  <Swatch value={h.value} />
                  {h.prop}: {h.value}
                  {h.token && <span style={{ color: GREEN }}>→ {h.token}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------

export function AuditResults({ report: r }: { report: AuditReport }) {
  const [tab, setTab] = useState<Tab>('classes');
  const s = r.stats;

  return (
    <div className="space-y-4">
      {r.warnings.length > 0 && (
        <div className="rounded-[16px] p-4 space-y-1.5" style={{ background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.2)' }}>
          {r.warnings.map((w, i) => (
            <div key={i} className="flex gap-2 text-[12px]" style={{ color: AMBER }}>
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-[11px] font-mono" style={{ color: FAINT }}>
        <span>{s.files} files</span>·<span>{s.markupFiles} markup</span>·<span>{s.styleFiles} CSS</span>·
        <span>{s.scriptFiles} scripts</span>
        {r.frameworks.length > 0 && (
          <>
            ·<span style={{ color: MUTED }}>{r.frameworks.join(', ')}</span>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Missing classes" value={s.missingClasses} tone={s.missingClasses ? RED : GREEN} hint="Used in markup but not defined in CSS" />
        <Stat label="Unused classes" value={s.unusedClasses} tone={s.unusedClasses ? AMBER : GREEN} hint="Defined in CSS but never used" />
        <Stat label="Undefined tokens" value={s.tokensUndefined} tone={s.tokensUndefined ? RED : GREEN} hint="var(--x) with no definition" />
        <Stat label="Unused tokens" value={s.tokensUnused} tone={s.tokensUnused ? AMBER : GREEN} hint="--x defined but never referenced" />
        <Stat label="Token coverage" value={s.tokenCoverage === null ? '—' : `${s.tokenCoverage}%`} hint="Share of colour / spacing / radius / font values that go through a var(--token)" />
        <Stat label="Dead CSS" value={kb(s.deadBytes)} tone={s.deadBytes ? AMBER : GREEN} hint={`${s.deadRules} of ${s.totalRules} rules can be removed`} />
        <Stat label="Classes matched" value={`${s.matchedClasses}/${s.usedClasses}`} />
        <Stat label="Tokens defined" value={s.tokensDefined} />
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <Pill active={tab === 'classes'} onClick={() => setTab('classes')} count={s.missingClasses + s.unusedClasses} tone={AMBER}>
          Classes
        </Pill>
        <Pill active={tab === 'tokens'} onClick={() => setTab('tokens')} count={s.tokensUndefined + s.tokensUnused} tone={AMBER}>
          Tokens
        </Pill>
        <Pill active={tab === 'hardcoded'} onClick={() => setTab('hardcoded')} count={r.hardcoded.matchesToken.length + r.hardcoded.repeated.length} tone={AMBER}>
          Hard-coded values
        </Pill>
        <Pill active={tab === 'map'} onClick={() => setTab('map')} count={r.map.length}>
          Class ↔ Token map
        </Pill>
      </div>

      <div>
        {tab === 'classes' && <ClassesTab r={r} />}
        {tab === 'tokens' && <TokensTab r={r} />}
        {tab === 'hardcoded' && <HardcodedTab r={r} />}
        {tab === 'map' && <MapTab r={r} />}
      </div>

      {r.externalStylesheets.length > 0 && (
        <div className="rounded-[16px] p-4" style={CARD}>
          <div className="text-[10px] uppercase tracking-[0.08em] font-mono mb-2" style={{ color: FAINT }}>
            External stylesheets (not analysed)
          </div>
          {r.externalStylesheets.map((u) => (
            <div key={u} className="font-mono text-[11px] break-all" style={{ color: MUTED }}>
              {u}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
