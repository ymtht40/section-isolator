// Project Audit engine
// ---------------------------------------------------------------------------
// Pure TypeScript (no DOM / no Node APIs) so it runs in the browser, in an API
// route, or in a worker. Given a set of project files it maps:
//   • classes used in markup  ↔  classes defined in CSS
//   • design tokens (CSS custom properties) defined  ↔  tokens referenced
//   • hard-coded values that should be (or could become) tokens
// and reports what is MISSING and what is UNUSED.

export interface ProjectFile {
  path: string;
  content: string;
}

export type HardcodedCategory =
  | 'color'
  | 'spacing'
  | 'radius'
  | 'font-size'
  | 'shadow'
  | 'font-family';
export type TokenCategory = HardcodedCategory | 'other';

export interface UsedClass {
  name: string;
  count: number;
  files: string[];
  status: 'matched' | 'framework' | 'missing';
  /** closest defined class name (only for missing — likely typo) */
  suggestion?: string;
}

export interface DefinedClass {
  name: string;
  files: string[];
  used: boolean;
  /** could be built dynamically (e.g. `bg-${color}`) so it is not safe to delete */
  maybeDynamic: boolean;
  /** bytes of CSS that would be removed if this class were deleted */
  bytes: number;
}

export interface TokenInfo {
  name: string;
  value: string;
  scope: string;
  file: string;
  category: TokenCategory;
  /** every definition (light/dark/@theme…) */
  defs: { value: string; scope: string; file: string }[];
  cssRefs: number;
  sourceRefs: number;
  /** used implicitly by Tailwind v4 utilities generated from @theme */
  utilityUse: boolean;
  usedByClasses: string[];
}

export interface UndefinedToken {
  name: string;
  refs: number;
  files: string[];
  hasFallback: boolean;
}

export interface HardcodedItem {
  category: HardcodedCategory;
  value: string;
  count: number;
  files: string[];
  samples: string[];
  /** existing tokens that already hold this exact value */
  tokens: string[];
}

export interface MapRow {
  className: string;
  files: string[];
  usedInMarkup: boolean;
  tokens: string[];
  hardcoded: { prop: string; value: string; token?: string }[];
}

export interface AuditReport {
  generatedAt: string;
  frameworks: string[];
  externalStylesheets: string[];
  warnings: string[];
  stats: {
    files: number;
    markupFiles: number;
    scriptFiles: number;
    styleFiles: number;
    usedClasses: number;
    definedClasses: number;
    matchedClasses: number;
    missingClasses: number;
    frameworkClasses: number;
    unusedClasses: number;
    tokensDefined: number;
    tokensUndefined: number;
    tokensUnused: number;
    cssBytes: number;
    deadBytes: number;
    deadRules: number;
    totalRules: number;
    /** % of colour/spacing/radius/… values that go through a token */
    tokenCoverage: number | null;
  };
  classes: {
    used: UsedClass[];
    missing: UsedClass[];
    framework: UsedClass[];
    unused: DefinedClass[];
  };
  tokens: {
    defined: TokenInfo[];
    undefined: UndefinedToken[];
    unused: TokenInfo[];
  };
  hardcoded: {
    matchesToken: HardcodedItem[];
    repeated: HardcodedItem[];
  };
  map: MapRow[];
}

export interface AuditOptions {
  /** extra warnings to show (e.g. from the URL fetcher) */
  warnings?: string[];
  /** stylesheet URLs the project links to but that are not part of `files` */
  externalStylesheets?: string[];
  /** stylesheet URLs that WERE fetched and are part of `files` */
  ignoreExternal?: string[];
}

// ---------------------------------------------------------------------------
// File type helpers
// ---------------------------------------------------------------------------

const MARKUP_EXT =
  /\.(html?|jsx|tsx|vue|svelte|astro|php|mdx|liquid|njk|hbs|ejs|erb|twig|cshtml)$/i;
const SCRIPT_EXT = /\.(js|mjs|cjs|ts)$/i;
const STYLE_EXT = /\.(css|pcss|postcss|scss|less)$/i;
const PRE_EXT = /\.(scss|less)$/i;

// ---------------------------------------------------------------------------
// Small string utilities
// ---------------------------------------------------------------------------

function stripComments(css: string, preprocessor: boolean): string {
  let out = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (preprocessor) out = out.replace(/(^|[^:\w"'(])\/\/.*$/gm, '$1');
  return out;
}

/** index of the first top-level `{`, `;` or `}` (respects quotes, (), [], escapes) */
function scanTo(t: string, from: number): number {
  let q: string | null = null;
  let p = 0;
  let b = 0;
  for (let i = from; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === '(') p++;
    else if (c === ')') p = Math.max(0, p - 1);
    else if (c === '[') b++;
    else if (c === ']') b = Math.max(0, b - 1);
    else if (p === 0 && b === 0 && (c === '{' || c === ';' || c === '}')) return i;
  }
  return t.length;
}

/** index of the `}` that closes the `{` at `open` */
function findClose(t: string, open: number): number {
  let d = 0;
  let q: string | null = null;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d === 0) return i;
    }
  }
  return t.length;
}

function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let p = 0;
  let b = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      cur += c;
      if (c === '\\') cur += text[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') {
      cur += c + (text[++i] ?? '');
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === '(') p++;
    else if (c === ')') p = Math.max(0, p - 1);
    else if (c === '[') b++;
    else if (c === ']') b = Math.max(0, b - 1);
    if (c === ',' && p === 0 && b === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripNot(sel: string): string {
  let prev = '';
  let cur = sel;
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(/:not\([^()]*\)/g, '');
  }
  return cur;
}

/** class names referenced by a selector (CSS escapes resolved) */
function classesInSelector(sel: string): string[] {
  const clean = sel
    .replace(/\[[^\]]*\]/g, '')
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, '');
  const out: string[] = [];
  const re = /\.((?:\\.|[\w-]|[^\x00-\x7F])+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const raw = m[1];
    if (/^\d/.test(raw)) continue; // `.5` etc.
    out.push(raw.replace(/\\(.)/g, '$1'));
  }
  return out;
}

/** remove balanced `fn( ... )` calls from a value */
function stripFn(value: string, fn: string): string {
  let out = '';
  let i = 0;
  const needle = fn + '(';
  while (i < value.length) {
    const at = value.indexOf(needle, i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at) + ' ';
    let depth = 0;
    let j = at + fn.length;
    for (; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSS parsing → flat list of rules
// ---------------------------------------------------------------------------

interface Decl {
  prop: string;
  value: string;
}

interface RawRule {
  file: string;
  selectors: string[];
  context: string[];
  decls: Decl[];
  bytes: number;
  theme: boolean;
}

interface ParseCtx {
  rules: RawRule[];
  propertyDefs: { name: string; value: string; file: string }[];
  applied: Set<string>;
  utilities: Set<string>;
  tailwind: boolean;
}

const SKIP_AT = /^@(?:-\w+-)?(?:keyframes|font-face|page|counter-style|font-feature-values|view-transition)\b/i;

function parseCss(text: string, file: string, preprocessor: boolean, ctx: ParseCtx): void {
  const src = stripComments(text, preprocessor);

  const walk = (
    t: string,
    context: string[],
    parentSel: string[] | null,
    theme: boolean,
    owner0: RawRule | null
  ) => {
    let owner = owner0;
    const getOwner = (): RawRule | null => {
      if (owner || parentSel === null) return owner;
      owner = {
        file,
        selectors: parentSel,
        context,
        decls: [],
        bytes: 0,
        theme,
      };
      ctx.rules.push(owner);
      return owner;
    };

    let i = 0;
    while (i < t.length) {
      while (i < t.length && /\s/.test(t[i])) i++;
      if (i >= t.length) break;
      if (t[i] === ';' || t[i] === '}') {
        i++;
        continue;
      }

      const end = scanTo(t, i);
      const head = t.slice(i, end).trim();

      if (t[end] === '{') {
        const close = findClose(t, end);
        const inner = t.slice(end + 1, close);

        if (head.startsWith('@')) {
          if (SKIP_AT.test(head)) {
            /* ignored */
          } else if (/^@property\b/i.test(head)) {
            const name = head.replace(/^@property\s+/i, '').trim();
            const iv = inner.match(/initial-value\s*:\s*([^;]+)/i)?.[1]?.trim() ?? '';
            if (name.startsWith('--')) ctx.propertyDefs.push({ name, value: iv, file });
          } else if (/^@theme\b/i.test(head)) {
            ctx.tailwind = true;
            walk(inner, [...context, '@theme'], ['@theme'], true, null);
          } else if (/^@utility\b/i.test(head)) {
            ctx.tailwind = true;
            const name = head.replace(/^@utility\s+/i, '').trim();
            if (name && !name.includes('*')) ctx.utilities.add(name);
            walk(inner, context, [`.${name}`], false, null);
          } else if (/^@(?:custom-variant|variant|source|plugin|config)\b/i.test(head)) {
            if (!/^@variant\b/i.test(head)) ctx.tailwind = true;
          } else {
            walk(inner, [...context, head], parentSel, theme, null);
          }
        } else {
          const sels = splitSelectors(head);
          const rule: RawRule = {
            file,
            selectors: sels,
            context,
            decls: [],
            bytes: head.length + inner.length + 2,
            theme: false,
          };
          ctx.rules.push(rule);
          walk(inner, context, sels, false, rule);
        }
        i = close + 1;
      } else {
        if (head) {
          if (head.startsWith('@')) {
            if (/^@apply\b/i.test(head)) {
              ctx.tailwind = true;
              head
                .replace(/^@apply\s+/i, '')
                .replace(/!important/g, '')
                .split(/\s+/)
                .filter(Boolean)
                .forEach((c) => ctx.applied.add(c));
            } else if (/^@(?:tailwind|plugin|source|config)\b/i.test(head)) {
              ctx.tailwind = true;
            } else if (/^@import\b[^;]*tailwindcss/i.test(head)) {
              ctx.tailwind = true;
            }
          } else {
            const idx = head.indexOf(':');
            if (idx > 0) {
              const rawProp = head.slice(0, idx).trim();
              const prop = rawProp.startsWith('--') ? rawProp : rawProp.toLowerCase();
              const value = head.slice(idx + 1).trim();
              if (/^[-\w]+$/.test(prop)) getOwner()?.decls.push({ prop, value });
            }
          }
        }
        i = end + 1;
      }
    }
  };

  walk(src, [], null, false, null);
}

// ---------------------------------------------------------------------------
// Class usage extraction (markup + scripts)
// ---------------------------------------------------------------------------

const CALL_RE =
  /\b(?:cn|clsx|classnames|classNames|cx|twMerge|twJoin|cva|tw|clsxm)\s*\(/g;
const ATTR_RE =
  /(?<![\w-])(class|className|:class|v-bind:class|class:list|ngClass|\[ngClass\]|\[class\])\s*=\s*/g;

function readBalanced(t: string, open: number, o: string, c: string): string {
  let d = 0;
  let q: string | null = null;
  for (let i = open; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '\\') i++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      q = ch;
      continue;
    }
    if (ch === o) d++;
    else if (ch === c) {
      d--;
      if (d === 0) return t.slice(open + 1, i);
    }
  }
  return t.slice(open + 1);
}

function stringLiterals(expr: string): string[] {
  const out: string[] = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) out.push(m[2]);
  return out;
}

const TOKEN_OK = /^[A-Za-z_!\[@-][^\s{}$<>"'`;]*$/;

function addClassString(
  raw: string,
  add: (c: string) => void,
  addPrefix: (p: string) => void
): void {
  let s = raw;
  // dynamic fragments: `bg-${color}` → prefix "bg-" (class cannot be resolved)
  s.replace(/(?:^|\s)([^\s${}]*)\$\{/g, (_m, pre: string) => {
    if (pre && pre.length >= 3) addPrefix(pre);
    return '';
  });
  s = s
    .replace(/\S*\$\{[^}]*\}\S*/g, ' ')
    .replace(/\S*\{\{[\s\S]*?\}\}\S*/g, ' ')
    .replace(/\S*\{%[\s\S]*?%\}\S*/g, ' ')
    .replace(/<\?(?:php)?[\s\S]*?\?>/g, ' ')
    .replace(/<%[\s\S]*?%>/g, ' ');
  for (const tok of s.split(/\s+/)) {
    const t = tok.replace(/[,;]+$/, '');
    if (!t || t.length > 120 || /^\d+$/.test(t)) continue;
    if (!TOKEN_OK.test(t)) continue;
    add(t.replace(/^!/, ''));
  }
}

function collectUsedClasses(
  text: string,
  file: string,
  used: Map<string, { count: number; files: Set<string> }>,
  prefixes: Set<string>
): void {
  const add = (c: string) => {
    let e = used.get(c);
    if (!e) used.set(c, (e = { count: 0, files: new Set() }));
    e.count++;
    if (e.files.size < 8) e.files.add(file);
  };
  const addPrefix = (p: string) => prefixes.add(p);

  // class="…" / className={…} / :class / class:list …
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(text))) {
    const attr = m[1];
    const pos = ATTR_RE.lastIndex;
    const ch = text[pos];
    const plain = attr === 'class' || attr === 'className';
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, pos + 1);
      if (end < 0) continue;
      const val = text.slice(pos + 1, end);
      if (plain) addClassString(val, add, addPrefix);
      else stringLiterals(val).forEach((s) => addClassString(s, add, addPrefix));
    } else if (ch === '{') {
      const expr = readBalanced(text, pos, '{', '}');
      stringLiterals(expr).forEach((s) => addClassString(s, add, addPrefix));
    }
  }

  // cn("a", cond && "b") / clsx / cva / twMerge …
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(text))) {
    const open = m.index + m[0].length - 1;
    const body = readBalanced(text, open, '(', ')');
    stringLiterals(body).forEach((s) => addClassString(s, add, addPrefix));
  }

  // JS hooks: classList.add('x'), querySelector('.x'), $('.x'), getElementsByClassName('x')
  const cl = /classList\s*\.\s*(?:add|remove|toggle|contains|replace)\s*\(([^)]*)\)/g;
  while ((m = cl.exec(text))) stringLiterals(m[1]).forEach((s) => addClassString(s, add, addPrefix));

  const qs =
    /(?:\b(?:querySelector(?:All)?|closest|matches)\s*\(|\$\(|jQuery\()\s*(["'`])([^"'`]+)\1/g;
  while ((m = qs.exec(text))) classesInSelector(m[2]).forEach(add);

  const gb = /getElementsByClassName\s*\(\s*(["'`])([^"'`]+)\1/g;
  while ((m = gb.exec(text))) addClassString(m[2], add, addPrefix);
}

function collectSourceTokens(
  text: string,
  file: string,
  refs: Map<string, { count: number; files: Set<string> }>,
  runtimeDefs: Set<string>
): void {
  const bump = (name: string) => {
    let e = refs.get(name);
    if (!e) refs.set(name, (e = { count: 0, files: new Set() }));
    e.count++;
    if (e.files.size < 8) e.files.add(file);
  };
  let m: RegExpExecArray | null;
  const v = /var\(\s*(--[\w-]+)/g;
  while ((m = v.exec(text))) bump(m[1]);
  const tw4 = /[\w\]\-/]\(\s*(--[\w-]+)\s*\)/g; // bg-(--brand)
  while ((m = tw4.exec(text))) bump(m[1]);
  const quoted = /['"`](--[\w-]+)['"`]/g; // getPropertyValue('--x')
  while ((m = quoted.exec(text))) bump(m[1]);
  const setP = /setProperty\(\s*['"`](--[\w-]+)/g;
  while ((m = setP.exec(text))) runtimeDefs.add(m[1]);
  const objKey = /['"`](--[\w-]+)['"`]\s*:/g; // style={{ '--x': 1 }}
  while ((m = objKey.exec(text))) runtimeDefs.add(m[1]);
  const styleAttr = /style\s*=\s*(["'])([^"']*)\1/gi;
  while ((m = styleAttr.exec(text))) {
    const decl = /(--[\w-]+)\s*:/g;
    let d: RegExpExecArray | null;
    while ((d = decl.exec(m[2]))) runtimeDefs.add(d[1]);
  }
}

// ---------------------------------------------------------------------------
// Framework heuristics
// ---------------------------------------------------------------------------

const TW_UTIL =
  /^(?:\[.+\]|-?(?:(?:min-|max-)?(?:w|h)|size|p[xytrblse]?|m[xytrblse]?|space-[xy]|gap(?:-[xy])?|inset(?:-[xy])?|top|right|bottom|left|start|end|z|order|col(?:-span|-start|-end)?|row(?:-span|-start|-end)?|grid(?:-cols|-rows|-flow)?|flex(?:-row|-col|-wrap|-nowrap|-1|-auto|-none|-initial|-row-reverse|-col-reverse)?|basis|grow|shrink|items|justify|content|self|place-(?:items|content|self)|text|font|leading|tracking|line-clamp|bg|from|via|to|border(?:-[xytrblse])?|rounded(?:-[a-z]{1,2})?|shadow|ring(?:-offset)?|outline|opacity|blur|backdrop|brightness|contrast|grayscale|saturate|sepia|invert|hue-rotate|drop-shadow|transition|duration|ease|delay|animate|scale(?:-[xy])?|rotate|translate-[xyz]|skew-[xy]|origin|cursor|select|pointer-events|overflow(?:-[xy])?|overscroll|object|aspect|fill|stroke|divide(?:-[xy])?|sr-only|not-sr-only|truncate|underline|overline|line-through|no-underline|uppercase|lowercase|capitalize|normal-case|italic|not-italic|antialiased|subpixel-antialiased|block|inline(?:-block|-flex|-grid|-table)?|hidden|contents|table(?:-[a-z]+)?|relative|absolute|fixed|sticky|static|visible|invisible|collapse|container|float|clear|isolate|isolation|list|decoration|underline-offset|whitespace|break|hyphens|accent|caret|resize|scroll|snap|touch|will-change|appearance|columns|mix-blend|bg-blend|data|group|peer|sm|md|lg|xl|2xl|tw|prose|dark|sidebar|animate-in|animate-out|fade-in|fade-out|zoom-in|zoom-out|slide-in|slide-out|spin|ping|pulse|bounce|forwards|backwards|filter)(?:[-/\[]|$))/;

const BS_UTIL =
  /^(?:btn|col|row|container(?:-fluid)?|d|navbar|nav|card|alert|badge|form|input-group|list-group|modal|dropdown|table|text|bg|border|rounded|shadow|justify-content|align-items|align-self|flex|fw|fs|g|gx|gy|position|fixed|sticky|visually-hidden|collapse|carousel|accordion|breadcrumb|pagination|spinner|toast|offcanvas|progress|img-fluid|lead|display|clearfix|ratio|stretched-link|p[xytrblse]?|m[xytrblse]?|w|h|order|offset)(?:-|$)/;

/** variants (`md:hover:`) and important/negative markers removed */
function baseUtility(cls: string): string {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) cut = i;
  }
  return cls.slice(cut + 1).replace(/^!/, '');
}

function variantsOf(cls: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) {
      out.push(cls.slice(last, i));
      last = i + 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Value normalisation (for token ↔ hard-coded matching)
// ---------------------------------------------------------------------------

function normNum(s: string): string {
  return s.replace(/-?\d*\.?\d+/g, (n) => String(Number(n)));
}

function normColor(raw: string): string {
  const v = raw.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length === 8 && h.endsWith('ff')) h = h.slice(0, 6);
    return '#' + h;
  }
  const fn = v.match(/^(rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(\s*([^)]*)\)$/);
  if (!fn) return v.replace(/\s+/g, '');
  const name = fn[1].replace(/^(rgb|hsl)a$/, '$1');
  const parts = fn[2]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(normNum);
  if (
    name === 'rgb' &&
    (parts.length === 3 || (parts.length === 4 && Number(parts[3]) === 1)) &&
    parts.slice(0, 3).every((p) => /^\d+$/.test(p) && Number(p) <= 255)
  ) {
    return '#' + parts.slice(0, 3).map((p) => Number(p).toString(16).padStart(2, '0')).join('');
  }
  return `${name}(${parts.join(',')})`;
}

const HSL_TRIPLE = /^-?[\d.]+(?:deg)?\s+[\d.]+%\s+[\d.]+%$/;

function isColorValue(v: string): boolean {
  const s = v.trim();
  return (
    /^#[0-9a-f]{3,8}$/i.test(s) ||
    /^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/i.test(s) ||
    HSL_TRIPLE.test(s)
  );
}

function normLength(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (!/^-?(?:\d*\.)?\d+(?:px|rem|em|%)$/.test(s)) return null;
  if (/^-?0*\.?0+(?:px|rem|em|%)$/.test(s)) return null; // zero
  return normNum(s);
}

function normGeneric(v: string): string {
  return v.trim().toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
}

function inferCategory(name: string, value: string): TokenCategory {
  if (isColorValue(value)) return 'color';
  const n = name.toLowerCase();
  if (/radius|rounded/.test(n)) return 'radius';
  if (/shadow/.test(n)) return 'shadow';
  if (/font-?family|font-(sans|serif|mono|display|body|heading)/.test(n)) return 'font-family';
  if (/font-?size|(^|-)text-(xs|sm|base|lg|xl|\d)|(^|-)fs-/.test(n)) return 'font-size';
  if (/space|spacing|gap|padding|margin|(^|-)size/.test(n) && normLength(value)) return 'spacing';
  if (/color|clr|background|foreground|primary|secondary|accent|muted|surface|brand|border|ring/.test(n) && !normLength(value))
    return 'color';
  return 'other';
}

// ---------------------------------------------------------------------------
// Typo suggestions
// ---------------------------------------------------------------------------

function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ---------------------------------------------------------------------------
// Hard-coded value extraction
// ---------------------------------------------------------------------------

const RADIUS_PROP = /^border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius$/;
const SPACING_PROP =
  /^(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?$/;
const COLOR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\([^)]*\)/g;

function literalsOf(prop: string, value: string): { category: HardcodedCategory; value: string }[] {
  const hits: { category: HardcodedCategory; value: string }[] = [];
  const v = stripFn(stripFn(value, 'var'), 'url');

  for (const m of v.matchAll(COLOR_LITERAL)) {
    const lit = m[0];
    if (lit.startsWith('#') && ![4, 5, 7, 9].includes(lit.length)) continue;
    hits.push({ category: 'color', value: normColor(lit) });
  }

  if (prop === 'font-size') {
    const l = normLength(v);
    if (l) hits.push({ category: 'font-size', value: l });
  } else if (RADIUS_PROP.test(prop)) {
    for (const part of v.split(/[\s/]+/)) {
      const l = normLength(part);
      if (l) hits.push({ category: 'radius', value: l });
    }
  } else if (SPACING_PROP.test(prop)) {
    for (const part of v.split(/\s+/)) {
      const l = normLength(part);
      if (l && !l.endsWith('%')) hits.push({ category: 'spacing', value: l });
    }
  } else if (prop === 'box-shadow' || prop === 'text-shadow') {
    const g = normGeneric(v);
    if (g && g !== 'none' && !/^(inherit|initial|unset)$/.test(g))
      hits.push({ category: 'shadow', value: g });
  } else if (prop === 'font-family') {
    const g = normGeneric(v);
    if (g && !/^(inherit|initial|unset)$/.test(g)) hits.push({ category: 'font-family', value: g });
  }
  return hits;
}

function propCategory(prop: string): HardcodedCategory | null {
  if (
    /(?:^|-)color$|^(?:fill|stroke)$|^background(?:-image)?$|^background$|^box-shadow$|^text-shadow$/.test(
      prop
    )
  )
    return 'color';
  if (prop === 'font-size') return 'font-size';
  if (RADIUS_PROP.test(prop)) return 'radius';
  if (SPACING_PROP.test(prop)) return 'spacing';
  if (prop === 'font-family') return 'font-family';
  return null;
}

const REPEAT_MIN: Record<HardcodedCategory, number> = {
  color: 3,
  'font-size': 3,
  radius: 3,
  spacing: 5,
  shadow: 2,
  'font-family': 2,
};

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function auditProject(files: ProjectFile[], opts: AuditOptions = {}): AuditReport {
  const warnings = [...(opts.warnings ?? [])];
  const external = new Set(opts.externalStylesheets ?? []);
  const frameworks = new Set<string>();

  const cssSources: { file: string; text: string; pre: boolean }[] = [];
  const usedMap = new Map<string, { count: number; files: Set<string> }>();
  const dynamicPrefixes = new Set<string>();
  const sourceVarRefs = new Map<string, { count: number; files: Set<string> }>();
  const runtimeDefs = new Set<string>();
  let markupFiles = 0;
  let scriptFiles = 0;
  let styleFiles = 0;

  // 1 ── scan files ----------------------------------------------------------
  for (const f of files) {
    const lower = f.path.toLowerCase();

    if (/(^|\/)package\.json$/.test(lower) && !lower.includes('node_modules')) {
      try {
        const pkg = JSON.parse(f.content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.tailwindcss) frameworks.add('Tailwind CSS');
        if (deps.bootstrap) frameworks.add('Bootstrap');
      } catch {
        /* ignore */
      }
      continue;
    }
    if (/tailwind\.config\.(js|ts|cjs|mjs)$/.test(lower)) frameworks.add('Tailwind CSS');

    if (STYLE_EXT.test(lower)) {
      styleFiles++;
      cssSources.push({ file: f.path, text: f.content, pre: PRE_EXT.test(lower) });
      continue;
    }

    const isMarkup = MARKUP_EXT.test(lower);
    const isScript = SCRIPT_EXT.test(lower);
    if (!isMarkup && !isScript) continue;
    if (isMarkup) markupFiles++;
    else scriptFiles++;

    let text = f.content;
    if (isMarkup) {
      text = text.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs: string, css: string) => {
        cssSources.push({
          file: `${f.path} <style>`,
          text: css,
          pre: /lang\s*=\s*["']?(scss|less|sass)/i.test(attrs),
        });
        return ' ';
      });
      for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
        const tag = m[0];
        if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
        const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!href || !/^(?:https?:)?\/\//i.test(href)) continue;
        external.add(href.startsWith('//') ? 'https:' + href : href);
        if (/bootstrap/i.test(href)) frameworks.add('Bootstrap');
        if (/tailwind/i.test(href)) frameworks.add('Tailwind CSS');
      }
      if (/cdn\.tailwindcss\.com/.test(text)) frameworks.add('Tailwind CSS');
    }
    if (isScript && /\.min\./.test(lower)) continue;

    collectUsedClasses(text, f.path, usedMap, dynamicPrefixes);
    collectSourceTokens(text, f.path, sourceVarRefs, runtimeDefs);
  }

  for (const u of opts.ignoreExternal ?? []) external.delete(u);

  // 2 ── parse CSS -----------------------------------------------------------
  const ctx: ParseCtx = {
    rules: [],
    propertyDefs: [],
    applied: new Set(),
    utilities: new Set(),
    tailwind: false,
  };
  let cssBytes = 0;
  for (const s of cssSources) {
    cssBytes += s.text.length;
    parseCss(s.text, s.file, s.pre, ctx);
  }
  if (ctx.tailwind) frameworks.add('Tailwind CSS');
  const hasTailwind = frameworks.has('Tailwind CSS');
  const hasBootstrap = frameworks.has('Bootstrap');

  if (!cssSources.length) warnings.push('No CSS files or <style> blocks were found in this project.');
  if (!markupFiles && !scriptFiles)
    warnings.push('No markup or script files were found — every class will look unused.');
  if (external.size)
    warnings.push(
      `${external.size} external stylesheet${external.size > 1 ? 's' : ''} could not be analysed — classes and tokens defined there will appear as missing.`
    );

  // 3 ── classes ------------------------------------------------------------
  const defined = new Map<string, { files: Set<string>; bytes: number }>();
  const isUsedClass = (c: string) => usedMap.has(c) || ctx.applied.has(c);
  const prefixList = [...dynamicPrefixes];
  const isDynamic = (c: string) => prefixList.some((p) => c.startsWith(p));

  let deadRules = 0;
  let deadBytes = 0;
  const contentRules = ctx.rules.filter((r) => !r.theme && r.selectors.length);

  for (const rule of contentRules) {
    const ruleClasses = new Set<string>();
    for (const sel of rule.selectors) classesInSelector(stripNot(sel)).forEach((c) => ruleClasses.add(c));

    const dead =
      rule.selectors.length > 0 &&
      rule.selectors.every((sel) => {
        const cs = classesInSelector(stripNot(sel));
        return cs.length > 0 && cs.some((c) => !isUsedClass(c) && !isDynamic(c));
      });
    if (dead) {
      deadRules++;
      deadBytes += rule.bytes;
    }

    for (const c of ruleClasses) {
      let e = defined.get(c);
      if (!e) defined.set(c, (e = { files: new Set(), bytes: 0 }));
      e.files.add(rule.file);
      if (dead && !isUsedClass(c) && !isDynamic(c)) e.bytes += rule.bytes;
    }
  }
  for (const u of ctx.utilities) {
    if (!defined.has(u)) defined.set(u, { files: new Set(['@utility']), bytes: 0 });
  }

  const definedNames = [...defined.keys()];
  const used: UsedClass[] = [];
  for (const [name, u] of usedMap) {
    const base = baseUtility(name);
    let status: UsedClass['status'];
    if (defined.has(name)) status = 'matched';
    else if (hasTailwind && TW_UTIL.test(base)) status = 'framework';
    else if (hasBootstrap && BS_UTIL.test(base)) status = 'framework';
    else status = 'missing';
    used.push({ name, count: u.count, files: [...u.files], status });
  }
  used.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const missing = used.filter((u) => u.status === 'missing');
  if (definedNames.length <= 6000) {
    for (const m of missing.slice(0, 400)) {
      let best: string | undefined;
      let bestD = 3;
      for (const d of definedNames) {
        if (usedMap.has(d)) continue; // an already-used class is not a typo target
        const dist = lev(m.name, d, 2);
        if (dist < bestD) {
          bestD = dist;
          best = d;
          if (dist === 1) break;
        }
      }
      if (best) m.suggestion = best;
    }
  }

  const unused: DefinedClass[] = [];
  for (const [name, d] of defined) {
    if (isUsedClass(name)) continue;
    unused.push({
      name,
      files: [...d.files],
      used: false,
      maybeDynamic: isDynamic(name),
      bytes: d.bytes,
    });
  }
  unused.sort((a, b) => Number(a.maybeDynamic) - Number(b.maybeDynamic) || b.bytes - a.bytes || a.name.localeCompare(b.name));

  // 4 ── tokens -------------------------------------------------------------
  interface RawDef {
    name: string;
    value: string;
    scope: string;
    file: string;
  }
  const defsByName = new Map<string, RawDef[]>();
  const pushDef = (d: RawDef) => {
    const arr = defsByName.get(d.name);
    if (arr) arr.push(d);
    else defsByName.set(d.name, [d]);
  };
  for (const r of ctx.rules) {
    for (const d of r.decls) {
      if (!d.prop.startsWith('--')) continue;
      const scope = r.theme
        ? '@theme'
        : r.selectors.join(', ') + (r.context.length ? ` @ ${r.context.join(' ')}` : '');
      pushDef({ name: d.prop, value: d.value, scope, file: r.file });
    }
  }
  for (const p of ctx.propertyDefs) pushDef({ ...p, scope: '@property' });

  const cssRefs = new Map<string, { count: number; files: Set<string>; noFallback: boolean; classes: Set<string> }>();
  const classTokens = new Map<string, Set<string>>();
  for (const r of ctx.rules) {
    const ruleClasses = new Set<string>();
    if (!r.theme) for (const sel of r.selectors) classesInSelector(stripNot(sel)).forEach((c) => ruleClasses.add(c));
    for (const d of r.decls) {
      const re = /var\(\s*(--[\w-]+)\s*(,)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(d.value))) {
        const name = m[1];
        let e = cssRefs.get(name);
        if (!e) cssRefs.set(name, (e = { count: 0, files: new Set(), noFallback: false, classes: new Set() }));
        e.count++;
        e.files.add(r.file);
        if (!m[2]) e.noFallback = true;
        for (const c of ruleClasses) {
          e.classes.add(c);
          let s = classTokens.get(c);
          if (!s) classTokens.set(c, (s = new Set()));
          s.add(name);
        }
      }
    }
  }

  // Tailwind v4: @theme tokens are consumed by generated utilities
  const utilitySuffixes = new Set<string>();
  const variantSet = new Set<string>();
  for (const name of usedMap.keys()) {
    variantsOf(name).forEach((v) => variantSet.add(v));
    const base = baseUtility(name).replace(/\/[\w.[\]%-]+$/, '');
    const parts = base.split('-');
    for (let i = 0; i < parts.length; i++) utilitySuffixes.add(parts.slice(i).join('-'));
  }
  const themeNs =
    /^--(inset-shadow|drop-shadow|font-weight|color|font|text|tracking|leading|breakpoint|container|spacing|radius|shadow|blur|perspective|aspect|ease|animate)(?:-(.*))?$/;
  const usedViaUtility = (name: string): boolean => {
    const m = name.match(themeNs);
    if (!m) return false;
    const key = (m[2] ?? '').split('--')[0];
    if (!key) return true; // `--spacing`, `--color-*` base
    if (m[1] === 'breakpoint') return variantSet.has(key);
    return utilitySuffixes.has(key);
  };

  // value resolution for alias chains
  const primaryDef = (name: string): RawDef | undefined => {
    const defs = defsByName.get(name);
    if (!defs) return undefined;
    return (
      defs.find((d) => /^(?::root|html|@theme|@property)/.test(d.scope)) ?? defs[0]
    );
  };
  const resolveValue = (name: string, depth = 0): string => {
    const d = primaryDef(name);
    if (!d) return '';
    const alias = d.value.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
    if (alias && depth < 6) return resolveValue(alias[1], depth + 1) || d.value;
    return d.value;
  };

  const tokenInfos: TokenInfo[] = [];
  for (const [name, defs] of defsByName) {
    const p = primaryDef(name)!;
    const resolved = resolveValue(name);
    const css = cssRefs.get(name);
    const src = sourceVarRefs.get(name);
    const isTheme = defs.some((d) => d.scope === '@theme');
    tokenInfos.push({
      name,
      value: p.value,
      scope: p.scope,
      file: p.file,
      category: inferCategory(name, resolved),
      defs: defs.map(({ value, scope, file }) => ({ value, scope, file })),
      cssRefs: css?.count ?? 0,
      sourceRefs: src?.count ?? 0,
      utilityUse: isTheme && usedViaUtility(name),
      usedByClasses: css ? [...css.classes].slice(0, 30) : [],
    });
  }
  tokenInfos.sort((a, b) => a.name.localeCompare(b.name));
  const unusedTokens = tokenInfos.filter((t) => !t.cssRefs && !t.sourceRefs && !t.utilityUse);

  const undef: UndefinedToken[] = [];
  const allRefNames = new Set([...cssRefs.keys(), ...sourceVarRefs.keys()]);
  for (const name of allRefNames) {
    if (defsByName.has(name) || runtimeDefs.has(name)) continue;
    if (/^--(?:tw|radix|vaul|cmdk)-/.test(name)) continue;
    const c = cssRefs.get(name);
    const s = sourceVarRefs.get(name);
    undef.push({
      name,
      refs: (c?.count ?? 0) + (s?.count ?? 0),
      files: [...new Set([...(c?.files ?? []), ...(s?.files ?? [])])].slice(0, 8),
      hasFallback: c ? !c.noFallback : false,
    });
  }
  undef.sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name));

  // 5 ── hard-coded values ↔ tokens ---------------------------------------
  const tokenIndex = new Map<string, string[]>();
  for (const t of tokenInfos) {
    if (t.category === 'other') continue;
    const raw = resolveValue(t.name);
    if (!raw || /var\(/.test(raw)) continue;
    let norm: string | null = null;
    if (t.category === 'color') {
      norm = HSL_TRIPLE.test(raw.trim()) ? normColor(`hsl(${raw.trim()})`) : normColor(raw);
    } else if (t.category === 'font-family' || t.category === 'shadow') norm = normGeneric(raw);
    else norm = normLength(raw);
    if (!norm) continue;
    const key = `${t.category}|${norm}`;
    const arr = tokenIndex.get(key);
    if (arr) arr.push(t.name);
    else tokenIndex.set(key, [t.name]);
  }

  const hard = new Map<string, HardcodedItem>();
  const mapRows = new Map<string, MapRow>();
  let tokenized = 0;
  let literal = 0;

  for (const r of contentRules) {
    const ruleClasses = new Set<string>();
    for (const sel of r.selectors) classesInSelector(stripNot(sel)).forEach((c) => ruleClasses.add(c));

    for (const d of r.decls) {
      if (d.prop.startsWith('--')) continue;
      const cat = propCategory(d.prop);
      if (cat) tokenized += (d.value.match(/var\(\s*--/g) ?? []).length;

      const hits = literalsOf(d.prop, d.value);
      for (const h of hits) {
        literal++;
        const key = `${h.category}|${h.value}`;
        let item = hard.get(key);
        if (!item) {
          item = {
            category: h.category,
            value: h.value,
            count: 0,
            files: [],
            samples: [],
            tokens: tokenIndex.get(key) ?? [],
          };
          hard.set(key, item);
        }
        item.count++;
        if (!item.files.includes(r.file) && item.files.length < 6) item.files.push(r.file);
        const sample = ruleClasses.size ? `.${[...ruleClasses][0]}` : r.selectors[0];
        if (!item.samples.includes(sample) && item.samples.length < 5) item.samples.push(sample);

        for (const c of ruleClasses) {
          const row = rowFor(c);
          if (row.hardcoded.length < 12)
            row.hardcoded.push({ prop: d.prop, value: h.value, token: item.tokens[0] });
        }
      }
    }

    for (const c of ruleClasses) {
      const row = rowFor(c);
      if (!row.files.includes(r.file)) row.files.push(r.file);
    }
  }

  function rowFor(c: string): MapRow {
    let row = mapRows.get(c);
    if (!row) {
      row = {
        className: c,
        files: [],
        usedInMarkup: isUsedClass(c),
        tokens: [...(classTokens.get(c) ?? [])].sort(),
        hardcoded: [],
      };
      mapRows.set(c, row);
    }
    return row;
  }
  for (const [c, toks] of classTokens) if (defined.has(c) && !mapRows.has(c)) rowFor(c).tokens = [...toks].sort();

  const hardItems = [...hard.values()].sort((a, b) => b.count - a.count);
  const matchesToken = hardItems.filter((h) => h.tokens.length);
  const repeated = hardItems.filter((h) => !h.tokens.length && h.count >= REPEAT_MIN[h.category]);

  const mapList = [...mapRows.values()]
    .filter((r) => r.tokens.length || r.hardcoded.length)
    .sort(
      (a, b) =>
        b.hardcoded.length - a.hardcoded.length ||
        b.tokens.length - a.tokens.length ||
        a.className.localeCompare(b.className)
    );

  const coverageBase = tokenized + literal;
  const tokenCoverage = coverageBase ? Math.round((tokenized / coverageBase) * 100) : null;

  const framework = used.filter((u) => u.status === 'framework');
  const matched = used.filter((u) => u.status === 'matched');

  return {
    generatedAt: new Date().toISOString(),
    frameworks: [...frameworks],
    externalStylesheets: [...external],
    warnings,
    stats: {
      files: files.length,
      markupFiles,
      scriptFiles,
      styleFiles,
      usedClasses: used.length,
      definedClasses: defined.size,
      matchedClasses: matched.length,
      missingClasses: missing.length,
      frameworkClasses: framework.length,
      unusedClasses: unused.length,
      tokensDefined: tokenInfos.length,
      tokensUndefined: undef.length,
      tokensUnused: unusedTokens.length,
      cssBytes,
      deadBytes,
      deadRules,
      totalRules: contentRules.length,
      tokenCoverage,
    },
    classes: { used, missing, framework, unused },
    tokens: { defined: tokenInfos, undefined: undef, unused: unusedTokens },
    hardcoded: { matchesToken, repeated },
    map: mapList,
  };
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

export function reportToMarkdown(r: AuditReport, limit = 40): string {
  const s = r.stats;
  const L: string[] = [];
  const list = (title: string, rows: string[], total: number) => {
    if (!rows.length) return;
    L.push(`\n## ${title} (${total})\n`);
    rows.slice(0, limit).forEach((x) => L.push(`- ${x}`));
    if (total > limit) L.push(`- … and ${total - limit} more`);
  };

  L.push('# Project Audit');
  L.push(`\nFrameworks: ${r.frameworks.join(', ') || 'none detected'}`);
  L.push(
    `\n| Metric | Value |\n|---|---|\n| Classes used / defined | ${s.usedClasses} / ${s.definedClasses} |\n| Missing classes | ${s.missingClasses} |\n| Unused classes | ${s.unusedClasses} |\n| Tokens defined | ${s.tokensDefined} |\n| Undefined tokens | ${s.tokensUndefined} |\n| Unused tokens | ${s.tokensUnused} |\n| Dead CSS | ${s.deadRules}/${s.totalRules} rules (~${(s.deadBytes / 1024).toFixed(1)} KB) |\n| Token coverage | ${s.tokenCoverage ?? 'n/a'}% |`
  );
  r.warnings.forEach((w) => L.push(`\n> ⚠ ${w}`));

  list(
    'Missing classes (used in markup, not defined)',
    r.classes.missing.map((c) => `\`${c.name}\` ×${c.count}${c.suggestion ? ` — did you mean \`${c.suggestion}\`?` : ''}`),
    r.classes.missing.length
  );
  list(
    'Unused classes (defined, never used)',
    r.classes.unused.map((c) => `\`${c.name}\`${c.maybeDynamic ? ' (maybe dynamic)' : ''} — ${c.bytes} B`),
    r.classes.unused.length
  );
  list(
    'Undefined tokens',
    r.tokens.undefined.map((t) => `\`${t.name}\` ×${t.refs}${t.hasFallback ? ' (has fallback)' : ''}`),
    r.tokens.undefined.length
  );
  list(
    'Unused tokens',
    r.tokens.unused.map((t) => `\`${t.name}\`: ${t.value}`),
    r.tokens.unused.length
  );
  list(
    'Hard-coded values that already have a token',
    r.hardcoded.matchesToken.map((h) => `\`${h.value}\` ×${h.count} → \`var(${h.tokens[0]})\``),
    r.hardcoded.matchesToken.length
  );
  list(
    'Repeated hard-coded values (candidate tokens)',
    r.hardcoded.repeated.map((h) => `${h.category}: \`${h.value}\` ×${h.count}`),
    r.hardcoded.repeated.length
  );
  return L.join('\n');
}
