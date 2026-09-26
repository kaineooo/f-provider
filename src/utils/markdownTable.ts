/**
 * Markdown 表格解析与导出工具。
 *
 * 服务于 AI 表格识别与 OCR 表格聚类：
 *   - parseMarkdownTable  把源码解析为表头 / 数据行 / 对齐方式（表格预览渲染用）；
 *   - markdownTableToTsv  转为 TSV（制表符分隔），可直接粘贴进 Excel / WPS；
 *   - markdownTableToHtml 转为 HTML <table>（富文本粘贴 / 网页用）；
 *   - buildMarkdownTable  把行列结构（OCR 表格聚类的恢复结果）直接序列化为
 *     Markdown 源码，无需经过源码解析。
 *
 * 解析容错：兼容首尾有无 `|` 包裹的写法、单元格内的 `\|` 转义、
 * 分隔行单/多连字符与 `:---:` 对齐标记；无法解析时返回 null，由调用方兜底。
 */

/** 解析后的 Markdown 表格结构。 */
export interface ParsedMarkdownTable {
  /** 表头单元格。 */
  headers: string[]
  /** 数据行（每行单元格数可能与表头不一致，渲染时按表头列数对齐）。 */
  rows: string[][]
  /** 各列对齐方式（来自分隔行的 :---: 标记，未标注为 null）。 */
  aligns: ('left' | 'center' | 'right' | null)[]
}

/**
 * 把一行表格源码切分为单元格。
 * 兼容首尾有无 `|` 包裹两种写法；`\|` 视为字面竖线不切分。
 */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur.trim())
  return cells
}

/** 判断一行单元格是否为表头下的分隔行（形如 --- / :---: / ---:）。 */
function isSeparatorCells(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')))
}

/** 把分隔行单元格解析为对齐方式（未标注为 null）。 */
function parseAlign(cell: string): 'left' | 'center' | 'right' | null {
  const t = cell.trim()
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/**
 * 解析 Markdown 表格源码。
 * @param md Markdown 表格源码（允许夹杂非表格行，取其中含 `|` 的行）。
 * @returns 解析结果；无法解析出「表头 + 分隔行」结构时返回 null。
 */
export function parseMarkdownTable(md: string): ParsedMarkdownTable | null {
  const lines = String(md || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('|'))
  if (lines.length < 2) return null
  const headers = splitRow(lines[0])
  if (!headers.length) return null
  const sepCells = splitRow(lines[1])
  if (!isSeparatorCells(sepCells)) return null
  // 对齐列数以表头为准，分隔行缺失的列补 null
  const aligns = headers.map((_, i) => parseAlign(sepCells[i] ?? '') ?? null)
  const rows = lines
    .slice(2)
    .map(splitRow)
    .filter((cells) => cells.some((c) => c !== ''))
  return { headers, rows, aligns }
}

/**
 * Markdown 表格转 TSV（制表符分隔，可直接粘贴进 Excel / WPS）。
 * 单元格内的制表符 / 换行替换为空格，避免破坏行列结构；
 * 无法解析为表格时原样返回源码（保留兜底复制能力）。
 */
export function markdownTableToTsv(md: string): string {
  const t = parseMarkdownTable(md)
  if (!t) return String(md || '')
  const esc = (c: string) => c.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
  const lines = [t.headers.map(esc).join('\t')]
  for (const r of t.rows) lines.push(r.map(esc).join('\t'))
  return lines.join('\n')
}

/**
 * 把行列结构序列化为 Markdown 表格源码（与 parseMarkdownTable 互逆：
 * 首行表头 + `---` 分隔行 + 数据行）。服务于 OCR 几何聚类恢复出的表格导出。
 * 单元格内的 `|` 转义为 `\|`，制表符 / 换行替换为空格，避免破坏表格结构。
 *
 * @param headers 表头单元格（决定列数：数据行多余列截断、缺失列补空）。
 * @param rows 数据行。
 * @returns Markdown 表格源码。
 */
export function buildMarkdownTable(headers: string[], rows: string[][]): string {
  const esc = (c: unknown) =>
    String(c ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\t/g, ' ')
      .replace(/\r?\n/g, ' ')
      .trim()
  const lines = [
    `| ${headers.map(esc).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${headers.map((_, i) => esc(r[i] ?? '')).join(' | ')} |`),
  ]
  return lines.join('\n')
}

/** HTML 转义（表格 HTML 导出用）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Markdown 表格转 HTML <table>（含 thead/tbody 与对齐 style）。
 * 无法解析为表格时返回空串，由调用方决定兜底行为。
 */
export function markdownTableToHtml(md: string): string {
  const t = parseMarkdownTable(md)
  if (!t) return ''
  const alignStyle = (a: 'left' | 'center' | 'right' | null) =>
    a ? ` style="text-align:${a}"` : ''
  const th = t.headers
    .map((h, i) => `<th${alignStyle(t.aligns[i])}>${escapeHtml(h)}</th>`)
    .join('')
  const trs = t.rows
    .map((r) => {
      const tds = t.headers
        .map((_, i) => `<td${alignStyle(t.aligns[i])}>${escapeHtml(r[i] ?? '')}</td>`)
        .join('')
      return `<tr>${tds}</tr>`
    })
    .join('')
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`
}
