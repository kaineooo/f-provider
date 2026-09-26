/**
 * OCR 表格聚类（识别页「表格」模式的本机引擎渠道）：把带坐标的识别行按几何
 * 特征切分为「普通文本区域」与「表格区域」，普通文本区域交给段落聚合
 * （ocrText.aggregateOcrParagraphs，表格模式下仅用于完整表达版面、展示时忽略），
 * 表格区域恢复 table / row / cell 结构，经 markdownTable.buildMarkdownTable
 * 序列化为 Markdown 后复用 AI 渠道的表格预览 / 编辑 / 复制链路。
 *
 * 为什么需要：表格截图经 OCR 后被打散成一行行单元格文本，直接做段落聚合会把
 * 不同列的单元格横向拼乱。表格的几何特征非常稳定——单元格之间的竖向空白在
 * 多个行间位置对齐，形成贯穿表格高度的「列分隔走廊」；普通文本（段落正文）
 * 换行位置参差，不具备这种多行对齐的空白。据此把表格区域从版面中分离出来。
 *
 * 聚类流程：
 *   OCR 行结果
 *     ↓
 *   基础几何归一化（过滤无效行 / 排序 / 统计中位行高作为长度基准）
 *     ↓
 *   识别页面中的文本区域：行聚成视觉行带 → 行带内提取列间空白 →
 *   聚合位置对齐的空白成候选「列分隔走廊」→ 不跨越走廊的连续行带组成
 *   候选表格区块 → 区块内按 x 投票复核出精确列分隔并恢复结构
 *     ↓
 *   ┌───────────────────┬───────────────────┐
 *   │   普通文本区域      │     表格区域       │
 *   │   → 段落聚合       │   → 表格结构恢复    │
 *   └───────────────────┴───────────────────┘
 *                          ↓
 *                   table / row / cell
 *
 * 已知局限（命中时回退段落聚合或拆成多表，不影响普通文本的既有行为）：
 *   - 横跨全表宽的行（合并单元格 / 表内小节标题）会切断表格区块；
 *   - OCR 把同一行相邻单元格合并成一行（列间隔太窄）时该列分隔不可恢复；
 *   - 双栏正文与两列表格几何上高度相似，靠「走廊宽度 / 最少行带数」启发式区分。
 *
 * 纯函数模块：无 Vue 依赖。未检出表格时 splitOcrRegions 返回 null，
 * 调用方回退纯段落聚合，保证纯文本页行为与旧版完全一致。
 */

import { aggregateOcrParagraphs, joinInline, median } from './ocrText'

// ── 几何阈值（均以中位行高 lineHeight 为基准的相对量）────────────────────

/** 视觉行带合并：两行垂直重叠 ≥ 该比例 × 较矮行高 → 同一行带（表格同一行的多个单元格）。 */
const BAND_OVERLAP_RATIO = 0.5

/** 列间空白：行带内相邻两行的水平空隙 ≥ 该倍数中位行高才视为列间隔（普通词间距不构成）。 */
const GUTTER_MIN_GAP = 0.4

/** 走廊聚合：两条列间空白水平重叠 ≥ 该比例 × 较窄者 → 同一条列分隔走廊。 */
const CORRIDOR_OVERLAP_RATIO = 0.5

/** 走廊成立门槛：至少该数量的行带在同位 x 提供空白（单行偶然的大间隔不构成走廊）。 */
const CORRIDOR_MIN_SUPPORT = 2

/** 区块内走廊支持率：区块行带中该 x 处为空白的比例需 ≥ 此值（与最小支持数取大者）。 */
const RUN_SUPPORT_RATIO = 0.5

/** 空白并入走廊的宽度上限：空白宽超过当前走廊核的该倍数更可能是「整段缺列」的
 * 稀疏行空白（会桥接相邻两条走廊），拒绝并入，避免列数塌缩。 */
const GUTTER_JOIN_WIDTH_RATIO = 2.5

/** 跨越判定容差：行端点伸入走廊不超过该倍数中位行高不算跨越（OCR 包围盒常有出格松弛）。 */
const CROSS_TOL_RATIO = 0.25

/** 两列表格（单走廊）：走廊宽超过该倍数中位行高更可能是双栏正文而非表格，剔除。 */
const WIDE_GUTTER_RATIO = 3

/** 两列表格（单走廊）：至少该数量行带才认定（两列版式与两列表格最难区分，提高门槛）。 */
const SINGLE_CORRIDOR_MIN_ROWS = 3

/** 表格区块最少行带数（≥3 列即多走廊时放宽到 2 行）。 */
const MIN_TABLE_ROWS = 2

// ── 结构定义 ─────────────────────────────────────────────────────────────

/** 恢复出的一张表格：首个有效行带作表头，其余为数据行。 */
export interface OcrRecoveredTable {
  /** 表头（表格首个行带按列拆分的文本）。 */
  headers: string[]
  /** 数据行（每行单元格数与列数一致，空白单元格为空串）。 */
  rows: string[][]
  /** 列数。 */
  colCount: number
  /** 表格区域包围盒（像素坐标，图上定位用）。 */
  bounds: { left: number; top: number; right: number; bottom: number }
}

/** 版面区域条目：普通文本区域（已聚合段落）或表格区域，按阅读顺序自上而下。 */
export type OcrRegionItem =
  | { kind: 'text'; top: number; paragraphs: string[] }
  | { kind: 'table'; top: number; table: OcrRecoveredTable }

/** 区域切分结果：items 为自上而下的混合版面，tables 为其中表格的集合。 */
export interface OcrRegionSplit {
  /** 版面区域（文本 / 表格混合，自上而下）。 */
  items: OcrRegionItem[]
  /** 检出的表格（= items 中表格条目的集合，便于调用方快速判断）。 */
  tables: OcrRecoveredTable[]
}

/** 视觉行带：垂直方向重叠的一组行（表格同一行的多个单元格 / 普通文本的一行）。 */
interface Band {
  /** 行带内各行（按 left 升序）。 */
  lines: OcrLine[]
  /** 行带包围盒上下缘。 */
  top: number
  bottom: number
}

/** 列间空白：某行带内相邻两行之间的水平空白区间。 */
interface Gutter {
  x0: number
  x1: number
  /** 所在行带下标（用于统计走廊的行带支持数）。 */
  band: number
}

/** 列分隔走廊：跨行带位置对齐的列间空白聚合，即表格的一列分隔。 */
interface Corridor {
  left: number
  right: number
  /** 支持该走廊的行带下标集合。 */
  bands: Set<number>
}

// ── 几何基础 ─────────────────────────────────────────────────────────────

/** 两行的垂直重叠占较矮行高的比例（0 ~ 1）。 */
function vOverlapRatio(a: OcrLine, b: OcrLine): number {
  const h = Math.min(a.bottom - a.top, b.bottom - b.top)
  if (h <= 0) return 0
  const ov = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return ov > 0 ? ov / h : 0
}

/**
 * 把识别行聚成视觉行带：垂直重叠达标的行归为同一带（表格同一行的多个单元格），
 * 不同行带的行上下堆叠。输入需已按 top 升序，利用序关系剪枝避免全量两两比较。
 *
 * @returns 行带数组（按 top 升序；带内行按 left 升序）。
 */
function clusterBands(sorted: OcrLine[]): Band[] {
  const n = sorted.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // top 升序：一旦后续行的 top 越过当前行 bottom，更靠后的行不可能与之重叠
      if (sorted[j].top >= sorted[i].bottom) break
      if (vOverlapRatio(sorted[i], sorted[j]) >= BAND_OVERLAP_RATIO) {
        const ri = find(i)
        const rj = find(j)
        if (ri !== rj) parent[ri] = rj
      }
    }
  }
  const groups = new Map<number, OcrLine[]>()
  sorted.forEach((line, i) => {
    const root = find(i)
    const g = groups.get(root)
    if (g) g.push(line)
    else groups.set(root, [line])
  })
  return [...groups.values()]
    .map((lines) => {
      lines.sort((a, b) => a.left - b.left)
      return {
        lines,
        top: Math.min(...lines.map((l) => l.top)),
        bottom: Math.max(...lines.map((l) => l.bottom)),
      }
    })
    .sort((a, b) => a.top - b.top)
}

/** 贪心聚类中的候选走廊簇：成员空白的并集范围（随并入扩张）+ 支持行带。 */
interface GutterCluster {
  x0: number
  x1: number
  bands: Set<number>
}

/**
 * 候选走廊检测（第一相位，粗定位用）：逐行带提取相邻单元格间的空白
 * （宽度达标才计入），按「宽度升序」贪心聚合位置对齐的空白成走廊簇。
 * 宽度升序保证窄空白先成核；空白若过分宽于簇核（整段缺列的稀疏行空白，
 * 会横跨两条真实走廊）拒绝并入，防止把相邻走廊桥接成一条导致列数塌缩。
 *
 * 结果只用于判定行带是否跨越走廊、圈出候选表格区块；列边界的精确值
 * 由区块内的 refineRunCorridors 投票给出。
 *
 * @param bands      行带数组（clusterBands 的输出，下标与空白统计对应）。
 * @param lineHeight 中位行高（空白宽度阈值的归一化基准）。
 * @returns 候选走廊数组（按 left 升序）；支持行带数不足时为空数组。
 */
function detectGutterCorridors(bands: Band[], lineHeight: number): Corridor[] {
  const gutters: Gutter[] = []
  bands.forEach((band, bi) => {
    for (let k = 1; k < band.lines.length; k++) {
      const a = band.lines[k - 1]
      const b = band.lines[k]
      if (b.left - a.right >= GUTTER_MIN_GAP * lineHeight) {
        gutters.push({ x0: a.right, x1: b.left, band: bi })
      }
    }
  })
  if (gutters.length < CORRIDOR_MIN_SUPPORT) return []

  gutters.sort((a, b) => a.x1 - a.x0 - (b.x1 - b.x0))
  const clusters: GutterCluster[] = []
  for (const g of gutters) {
    const gw = g.x1 - g.x0
    const host = clusters.find((c) => {
      const ov = Math.min(g.x1, c.x1) - Math.max(g.x0, c.x0)
      if (ov <= 0) return false
      const narrow = Math.min(gw, c.x1 - c.x0)
      return (
        ov / narrow >= CORRIDOR_OVERLAP_RATIO && gw <= (c.x1 - c.x0) * GUTTER_JOIN_WIDTH_RATIO
      )
    })
    if (host) {
      host.x0 = Math.min(host.x0, g.x0)
      host.x1 = Math.max(host.x1, g.x1)
      host.bands.add(g.band)
    } else {
      clusters.push({ x0: g.x0, x1: g.x1, bands: new Set([g.band]) })
    }
  }
  return clusters
    .filter((c) => c.bands.size >= CORRIDOR_MIN_SUPPORT && c.x1 > c.x0)
    .map((c) => ({ left: c.x0, right: c.x1, bands: c.bands }))
    .sort((a, b) => a.left - b.left)
}

/**
 * 区块内精确定列（第二相位）：把区块的 x 范围按 1/4 中位行高分箱，统计每个
 * bin 上「该行带无任何文本覆盖」的行带数（空白支持数），支持数达标的连续 bin
 * 构成列分隔走廊。相比候选走廊，投票只在表格区块内部进行：区块外的正文行
 * 不再稀释支持数，「整段缺列」的稀疏行空白也只会让列边界局部外扩而不会
 * 桥接相邻走廊，列边界更贴近实际空白位置。
 *
 * @param runBands   候选区块内的行带（连续、均不跨越候选走廊，按 top 升序）。
 * @param lineHeight 中位行高。
 * @returns 走廊数组（按 left 升序，宽度不足 0.4 倍行高的丢弃）。
 */
function refineRunCorridors(runBands: Band[], lineHeight: number): Corridor[] {
  const binW = Math.max(lineHeight / 4, 1)
  const x0 = Math.min(...runBands.map((b) => Math.min(...b.lines.map((l) => l.left))))
  const x1 = Math.max(...runBands.map((b) => Math.max(...b.lines.map((l) => l.right))))
  const binCount = Math.max(1, Math.ceil((x1 - x0) / binW))
  // 每行带的覆盖标记：bin 中心落在该行带某行的包围盒内即视为有文本
  const covered = runBands.map((band) => {
    const flags = new Uint8Array(binCount)
    for (const line of band.lines) {
      const s = Math.max(0, Math.ceil((line.left - x0) / binW - 0.5))
      const e = Math.min(binCount - 1, Math.floor((line.right - x0) / binW - 0.5))
      for (let b = s; b <= e; b++) flags[b] = 1
    }
    return flags
  })
  const minSup = Math.max(CORRIDOR_MIN_SUPPORT, Math.ceil(runBands.length * RUN_SUPPORT_RATIO))
  const minWidth = GUTTER_MIN_GAP * lineHeight
  const corridors: Corridor[] = []
  let start = -1
  for (let b = 0; b <= binCount; b++) {
    let ws = 0
    if (b < binCount) for (const flags of covered) if (!flags[b]) ws++
    const isWs = b < binCount && ws >= minSup
    if (isWs && start < 0) start = b
    if (!isWs && start >= 0) {
      const left = x0 + start * binW
      const right = x0 + b * binW
      if (right - left >= minWidth) {
        const bandsSup = new Set<number>()
        covered.forEach((flags, bi) => {
          for (let k = start; k < b; k++)
            if (!flags[k]) {
              bandsSup.add(bi)
              break
            }
        })
        corridors.push({ left, right, bands: bandsSup })
      }
      start = -1
    }
  }
  return corridors
}

/** 行是否「跨越」走廊：行两端均超出走廊边界一定容差（表格单元格不会横跨列分隔）。 */
function crossesCorridor(line: OcrLine, c: Corridor, tol: number): boolean {
  return line.left < c.left - tol && line.right > c.right + tol
}

// ── 表格结构恢复 ─────────────────────────────────────────────────────────

/**
 * 在候选区块内恢复表格结构：每个行带的行按「列分隔走廊」落入列
 * （以行中点落在走廊哪一侧计列号），同行同列的多行合并为一个单元格。
 * 随后修剪区块两端的「单单元格行」（表标题 / 表尾注记），不足最少行带数则判定失败。
 *
 * @param runBands   候选区块内的行带（连续、均不跨越走廊，按 top 升序）。
 * @param corridors  区块内投票复核出的走廊（升序，refineRunCorridors 的输出）。
 * @param lineHeight 中位行高。
 * @returns 恢复结果：table 为表格结构，from / to 为区块内实际归属表格的
 *          行带下标（两端被修剪的标题 / 注记行带不包含在内，调用方将其
 *          留给文本区域）；行带数 / 列数不达标或两列走廊过宽（更像双栏正文）
 *          时返回 null。
 */
function buildTable(
  runBands: Band[],
  corridors: Corridor[],
  lineHeight: number
): { table: OcrRecoveredTable; from: number; to: number } | null {
  const colCount = corridors.length + 1
  if (colCount < 2 || runBands.length < MIN_TABLE_ROWS) return null
  if (
    colCount === 2 &&
    (runBands.length < SINGLE_CORRIDOR_MIN_ROWS ||
      corridors[0].right - corridors[0].left > WIDE_GUTTER_RATIO * lineHeight)
  ) {
    return null
  }

  // 落格：行带 × 列区间 → 单元格文本（同行同列多行拼接）
  const grid = runBands.map(() => Array<string>(colCount).fill(''))
  runBands.forEach((band, ri) => {
    const cellLines: string[][] = Array.from({ length: colCount }, () => [])
    for (const line of band.lines) {
      const mid = (line.left + line.right) / 2
      let col = 0
      for (const c of corridors) if ((c.left + c.right) / 2 < mid) col++
      cellLines[Math.min(col, colCount - 1)].push(String(line.text).trim())
    }
    cellLines.forEach((ts, ci) => {
      grid[ri][ci] = ts.reduce((acc, t) => joinInline(acc, t), '')
    })
  })

  // 修剪区块两端的标题 / 注记行：仅 1 个非空单元格且相邻行内容更满 → 不属于表格本体
  const nonEmpty = grid.map((row) => row.filter((c) => c !== '').length)
  let from = 0
  let to = grid.length - 1
  while (to - from + 1 > MIN_TABLE_ROWS && nonEmpty[from] <= 1 && nonEmpty[from + 1] >= 2) from++
  while (to - from + 1 > MIN_TABLE_ROWS && nonEmpty[to] <= 1 && nonEmpty[to - 1] >= 2) to--
  if (to - from + 1 < MIN_TABLE_ROWS) return null

  const used = runBands.slice(from, to + 1)
  const bounds = {
    left: Math.min(...used.map((b) => Math.min(...b.lines.map((l) => l.left)))),
    top: Math.min(...used.map((b) => b.top)),
    right: Math.max(...used.map((b) => Math.max(...b.lines.map((l) => l.right)))),
    bottom: Math.max(...used.map((b) => b.bottom)),
  }
  return {
    table: { headers: grid[from], rows: grid.slice(from + 1, to + 1), colCount, bounds },
    from,
    to,
  }
}

// ── 区域切分主入口 ───────────────────────────────────────────────────────

/**
 * 按版面几何把识别行切分为文本区域与表格区域，并恢复表格的行列结构。
 *
 * 处理顺序：几何归一化 → 行带聚类 → 走廊检测 → 连续「表格行带」组成候选区块 →
 * 区块内复检走廊支持率并构建表格（校验失败整块回退文本）→ 剩余行带按连续段
 * 交给段落聚合。输出条目按版面自上而下排列。
 *
 * @param lines OCR 识别行（需带真实坐标；AI 渠道的伪行坐标全 0 会返回 null）。
 * @returns 切分结果；未检出表格（纯文本页 / 无有效几何）时返回 null，
 *          调用方回退纯段落聚合，保证既有行为不变。
 */
export function splitOcrRegions(lines: OcrLine[]): OcrRegionSplit | null {
  // 1) 基础几何归一化：过滤空行与无效包围盒，统计中位行高作为阈值基准
  const valid = (lines || []).filter(
    (l) => l && String(l.text ?? '').trim() && l.right - l.left > 0 && l.bottom - l.top > 0
  )
  if (valid.length < 3) return null
  const sorted = [...valid].sort((a, b) => a.top - b.top || a.left - b.left)
  const lineHeight = median(sorted.map((l) => l.bottom - l.top).filter((h) => h > 0).sort((a, b) => a - b))
  if (!(lineHeight > 0)) return null

  // 2) 行带聚类 + 全页候选走廊（空白贪心聚类，仅用于行带分类与区块定位）
  const bands = clusterBands(sorted)
  const corridors = detectGutterCorridors(bands, lineHeight)
  if (!corridors.length) return null

  // 3) 行带分类：跨越任一走廊的行带不是表格行（全宽文本行 / 段落行）
  const tol = CROSS_TOL_RATIO * lineHeight
  const isGridRow = bands.map((band) =>
    !band.lines.some((line) => corridors.some((c) => crossesCorridor(line, c, tol)))
  )

  // 4) 连续表格行带组成候选区块：区块内按 x 投票精确复核列分隔，
  //    再恢复行列结构；复核 / 校验失败的区块整块回退为文本区域
  const bandTable: (OcrRecoveredTable | null)[] = bands.map(() => null)
  let i = 0
  while (i < bands.length) {
    if (!isGridRow[i]) {
      i++
      continue
    }
    let j = i
    while (j + 1 < bands.length && isGridRow[j + 1]) j++
    const runBands = bands.slice(i, j + 1)
    if (runBands.length >= MIN_TABLE_ROWS) {
      const runCorridors = refineRunCorridors(runBands, lineHeight)
      if (runCorridors.length) {
        const built = buildTable(runBands, runCorridors, lineHeight)
        if (built) {
          // 仅实际归属表格的行带标记为表格，被修剪的标题 / 注记行带留给文本区域
          for (let k = i + built.from; k <= i + built.to; k++) bandTable[k] = built.table
        }
      }
    }
    i = j + 1
  }

  // 5) 装配输出：表格区块 → table 条目；其余连续行带 → 文本区域（段落聚合）
  const items: OcrRegionItem[] = []
  const tables: OcrRecoveredTable[] = []
  let k = 0
  while (k < bands.length) {
    const table = bandTable[k]
    if (table) {
      items.push({ kind: 'table', top: table.bounds.top, table })
      tables.push(table)
      do {
        k++
      } while (k < bands.length && bandTable[k] === table)
    } else {
      const regionLines: OcrLine[] = []
      const top = bands[k].top
      while (k < bands.length && !bandTable[k]) {
        regionLines.push(...bands[k].lines)
        k++
      }
      const paragraphs = aggregateOcrParagraphs(regionLines)
      if (paragraphs.length) items.push({ kind: 'text', top, paragraphs })
    }
  }
  // 未检出任何表格 → null，调用方回退（表格模式按「未识别到表格」处理）
  if (!tables.length) return null
  return { items, tables }
}
