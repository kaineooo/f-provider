/**
 * OCR 文本装配：把带坐标的识别行按版面几何聚合成「段落」。
 *
 * 为什么需要：OCR 返回的是一行行视觉文本（换行位置由排版宽度决定，与语义段落
 * 无关），直接按行拿去翻译会被硬换行切断句子。聚合后同段落的多行合并为一整行、
 * 段落之间用单个换行分隔，翻译质量与复制体验都更接近原文。
 *
 * 聚合流程：
 *   OCR 行结果 → 按 x 重叠分栏（多栏排版各栏独立）→ 栏内按 top 排序
 *   → 估计正常行高 / 正常行间距 → 逐行判断相邻关系
 *   → 综合多个几何特征给出三档裁决：强连接（合并）/ 弱连接（按上下文定）/
 *   强断开（分段）→ paragraph[]（多栏按左缘顺序拼接）
 *
 * 纯函数模块：无 Vue 依赖，供 Recognize（回显 / 复制 / 发送翻译）单独使用。
 */

// ── 几何阈值（均以行高 lineHeight / 正常行距 refGap 为基准的相对量）────────

/** 强断开：垂直空隙超过该倍数行高即分段（与 REF_GAP_BREAK 取大者，兜底无行距统计时）。 */
const BREAK_GAP_LINE = 0.6

/** 强断开：垂直空隙超过该倍数正常行距即分段（空行 / 段间距特征）。 */
const BREAK_GAP_REF = 1.7

/** 强断开：下一行 top 比上一行 bottom 高出该倍数行高 → 换栏 / 新版块，不按阅读顺序续拼。 */
const COLUMN_SHIFT_RATIO = 1.2

/** 强断开：行首相对段落左边距右移超过该倍数行高 → 首行缩进 / 列表缩进，分段。 */
const INDENT_RATIO = 1

/** 强连接：行首与段落左边距偏差在该倍数行高内视为左对齐。 */
const ALIGN_TOL_RATIO = 0.25

/** 强连接：两行 x 区间重叠 ≥ 该比例 × 较窄行宽（同一栏内的水平证据）。 */
const OVERLAP_RATIO = 0.5

/** 分栏：两行 x 区间重叠 ≥ 该比例 × 较窄行宽视为同一栏（跨栏的行互不重叠）。 */
const COLUMN_OVERLAP_RATIO = 0.5

/** 强连接：垂直空隙不超过该倍数正常行距（行距紧凑）。 */
const TIGHT_GAP_REF = 0.6

/** 大字号行（标题）：行高超过该倍数中位行高视为独立展示行，其后强制分段。 */
const DISPLAY_LINE_RATIO = 1.6

/** 句末行未占满：行宽小于该倍数中位行宽 → 段落末行特征。 */
const SHORT_LINE_RATIO = 0.8

/** 弱连接：与上一个已合并接缝的行距偏差在该倍数正常行距内 → 行距一致，倾向合并。 */
const WEAK_GAP_TOL = 0.25

/** 弱连接：左对齐且行距不超过该倍数正常行距 → 倾向合并。 */
const WEAK_MERGE_GAP = 1.2

// ── 文本特征 ─────────────────────────────────────────────────────────────

/** CJK / 全角字符：判定同行拼接处是否需要补空格。 */
const CJK = /[\u2e80-\u9fff\u3000-\u303f\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/

/** 句末标点：行尾出现时视为句子结束（强连接被否决；配合未占满行宽则强断开）。 */
const SENTENCE_END = /[。！？!?；;…]$/

/** 续行标点：行尾出现时句子明显未完，弱连接裁决倾向合并。 */
const CONTINUE_END = /[，、：,;；—–-]$/

/** 列表标记：项目符号 / 有序序号（`(?![0-9])` 避免把 "1.5" 这类小数误判为序号）。 */
const LIST_MARKER = /^(?:[-•·◦▪‣]\s*|[（(]?\d{1,3}[.、)）](?![0-9])\s*|[①-⑳]\s*)/

/** 相邻两行的三档裁决。 */
type PairVerdict = 'merge' | 'weak' | 'break'

/** 栏内几何统计：阈值的归一化基准（行高 / 行宽取全篇中位数，行距按栏内相邻空隙估计）。 */
interface GeomStats {
  /** 中位行高。 */
  lineHeight: number
  /** 正常行间距（相邻行空隙中位数，夹取到合理区间）。 */
  refGap: number
  /** 中位行宽（短行判定基准）。 */
  medianWidth: number
}

/** 取中位数（入参需已升序）；空数组返回 0。 */
function median(sorted: number[]): number {
  if (!sorted.length) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 估计正常行间距：取相邻行垂直空隙中「同栏紧凑范围」内的中位数。
 * 段间距 / 换栏产生的大空隙是离群值，用 1.2 倍行高的上限排除；
 * 结果夹取到 [0.15, 1.2] 倍行高，避免极端排版（全贴行 / 全大间距）失真。
 */
function estimateRefGap(sorted: OcrLine[], lineHeight: number): number {
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i].top - sorted[i - 1].bottom
    if (g >= -0.5 * lineHeight && g <= 1.2 * lineHeight) gaps.push(g)
  }
  gaps.sort((a, b) => a - b)
  const m = median(gaps)
  return Math.min(Math.max(m > 0 ? m : 0.15 * lineHeight, 0.15 * lineHeight), 1.2 * lineHeight)
}

/** 两行 x 区间重叠占较窄行宽的比例（0 ~ 1）。 */
function xOverlapRatio(a: OcrLine, b: OcrLine): number {
  const w = Math.min(a.right - a.left, b.right - b.left)
  if (w <= 0) return 0
  const ov = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  return ov > 0 ? ov / w : 0
}

/**
 * 行内拼接：CJK 之间直接相接，其余情况补一个空格（避免英文单词粘连）。
 * @param a 已累积的段落文本。
 * @param b 追加的一行文本（已 trim）。
 */
function joinInline(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  const last = a[a.length - 1]
  const first = b[0]
  return CJK.test(last) && CJK.test(first) ? a + b : a + ' ' + b
}

/**
 * 综合多个几何特征，对相邻两行给出三档裁决：
 *   - break：任一强断开特征命中（大间距 / 换栏 / 缩进 / 新列表项 / 句末短行 / 大字号标题后）
 *   - merge：全部强连接特征满足（行距紧凑 + 左对齐 + 横向重叠 + 非句末）
 *   - weak ：介于两者之间，交由 resolveWeak 结合上下文裁决
 *
 * @param prev          上一行（提供行尾文本与下边界 / 右边界）。
 * @param next          下一行。
 * @param paraLeft      当前段落已累积的左边距（各行 left 最小值）。
 * @param stats         全篇几何统计。
 * @param prevIsList    上一行是否以列表标记开头（其续行允许悬挂缩进）。
 */
function classifyPair(
  prev: OcrLine,
  next: OcrLine,
  paraLeft: number,
  stats: GeomStats,
  prevIsList: boolean
): PairVerdict {
  const lh = stats.lineHeight
  const refGap = stats.refGap
  const gap = next.top - prev.bottom
  const nextText = String(next.text).trim()
  const prevText = String(prev.text).trimEnd()
  const prevWidth = prev.right - prev.left
  const prevHeight = prev.bottom - prev.top

  // ── 强断开：任一命中即分段 ──
  // 1) 垂直空隙明显大于常规行距（空行 / 段间距）
  if (gap > Math.max(BREAK_GAP_LINE * lh, BREAK_GAP_REF * refGap)) return 'break'
  // 1') 下一行反而明显靠上（双栏 / 多块排版的换栏）——按阅读顺序不该续着拼
  if (gap < -COLUMN_SHIFT_RATIO * lh) return 'break'
  // 2) 行首相对段落左边距右移（首行缩进 / 列表缩进）→ 新段落；
  //    上一行本身是列表项时放过（其续行允许悬挂缩进），交由后续特征判定
  if (!prevIsList && next.left - paraLeft > INDENT_RATIO * lh) return 'break'
  // 3) 下一行以项目符号 / 序号开头 → 新列表项
  if (LIST_MARKER.test(nextText)) return 'break'
  // 4) 上一行以句末标点结尾且未占满行宽（右侧留白）→ 段落在此结束
  if (SENTENCE_END.test(prevText) && prevWidth < SHORT_LINE_RATIO * stats.medianWidth)
    return 'break'
  // 5) 展示行（标题 / 章节头等大字号行）：行高远超中位行高，前后都不并入正文
  if (prevHeight > DISPLAY_LINE_RATIO * lh) return 'break'
  if (next.bottom - next.top > DISPLAY_LINE_RATIO * lh) return 'break'

  // ── 强连接：全部满足才合并 ──
  const aligned = Math.abs(next.left - paraLeft) <= ALIGN_TOL_RATIO * lh
  // 列表项的续行允许相对列表标记右移（悬挂缩进），只要没有明显左移
  const listContinuation = prevIsList && next.left >= paraLeft - ALIGN_TOL_RATIO * lh
  const overlapOk = xOverlapRatio(prev, next) >= OVERLAP_RATIO
  const tightGap = gap <= TIGHT_GAP_REF * refGap && gap >= -0.3 * lh
  if ((aligned || listContinuation) && overlapOk && tightGap && !SENTENCE_END.test(prevText))
    return 'merge'

  return 'weak'
}

/**
 * 弱连接的上下文裁决：单看一对行无法确定时，结合行尾标点与
 * 前文已合并接缝的行距决定「是否并入当前段落」。
 * @param prevText     上一行行尾文本。
 * @param gap          与上一行的垂直空隙。
 * @param aligned      下一行是否与段落左边距对齐。
 * @param lastMergeGap 上一个「已合并」接缝的行距（-1 表示尚无）。
 * @param refGap       正常行间距。
 * @returns true = 并入当前段落。
 */
function resolveWeak(
  prevText: string,
  gap: number,
  aligned: boolean,
  lastMergeGap: number,
  refGap: number
): boolean {
  // 1) 行尾是续行标点：句子明显未完，合并
  if (CONTINUE_END.test(prevText)) return true
  // 2) 行距与前文已合并接缝一致：延续同一版块，合并
  if (lastMergeGap >= 0 && Math.abs(gap - lastMergeGap) <= WEAK_GAP_TOL * refGap) return true
  // 3) 句末标点 + 行距偏大：段落结束特征，分段
  if (SENTENCE_END.test(prevText) && gap > refGap) return false
  // 4) 左对齐且行距不明显偏大：默认同段
  if (aligned && gap <= WEAK_MERGE_GAP * refGap) return true
  return false
}

/**
 * 按 x 区间重叠把行聚成「栏」：同一栏内的行横向有实质重叠，跨栏的行互不重叠。
 * 双栏 / 多栏排版各自独立成栏，纯 top 排序会把各栏行交错，必须先分栏再聚合。
 *
 * @returns 每栏一组（栏内已按 top、left 排序），各栏按最左缘从左到右排列。
 */
function clusterColumns(sorted: OcrLine[]): OcrLine[][] {
  const n = sorted.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (xOverlapRatio(sorted[i], sorted[j]) >= COLUMN_OVERLAP_RATIO) {
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
    .map((g) => g.sort((a, b) => a.top - b.top || a.left - b.left))
    .sort(
      (a, b) =>
        Math.min(...a.map((l) => l.left)) - Math.min(...b.map((l) => l.left))
    )
}

/**
 * 单栏内的聚合主循环：逐行判断相邻关系 → 三档裁决 → 合并 / 分段。
 * 强 / 弱连接并入当前段落（段落左边距随更靠左的行收缩），强断开另起新段。
 */
function aggregateColumn(col: OcrLine[], stats: GeomStats): string[] {
  const paragraphs: { text: string; left: number }[] = []
  let prev: OcrLine | null = null
  let lastMergeGap = -1
  for (const line of col) {
    const text = String(line.text).trim()
    const cur = paragraphs[paragraphs.length - 1]
    let merged = false
    if (cur && prev) {
      const verdict = classifyPair(
        prev,
        line,
        cur.left,
        stats,
        LIST_MARKER.test(String(prev.text).trimStart())
      )
      if (verdict === 'merge') {
        merged = true
      } else if (verdict === 'weak') {
        merged = resolveWeak(
          String(prev.text).trimEnd(),
          line.top - prev.bottom,
          Math.abs(line.left - cur.left) <= ALIGN_TOL_RATIO * stats.lineHeight,
          lastMergeGap,
          stats.refGap
        )
      }
    }
    if (merged && cur) {
      cur.text = joinInline(cur.text, text)
      if (line.left < cur.left) cur.left = line.left
      lastMergeGap = line.top - prev!.bottom
    } else {
      paragraphs.push({ text, left: line.left })
    }
    prev = line
  }
  return paragraphs.map((p) => p.text)
}

/**
 * 按版面几何把识别行聚合成段落，返回每段合并后的文本。
 *
 * 行本身（含坐标）不在此处修改：调用方仍可按原行做图上高亮联动，
 * 仅「整段文本」的输出走本函数——保证坐标可点选与语义段落两者兼得。
 *
 * 无法做几何判定时（AI 识图返回的伪行：坐标为 0、行高为 0）原样按行返回，
 * 即这类渠道的文本不受聚合影响。
 *
 * @param lines OCR 识别行（可为空）。
 * @returns 段落文本数组；段落内部已按需拼接，段落之间由调用方决定分隔符。
 */
export function aggregateOcrParagraphs(lines: OcrLine[]): string[] {
  const valid = (lines || []).filter((l) => l && String(l.text ?? '').trim())
  if (!valid.length) return []

  // 1) 预排序：top 升序，同排按 left（仅用于稳定统计；聚合按栏进行）
  const sorted = [...valid].sort((a, b) => a.top - b.top || a.left - b.left)

  // 2) 估计正常行高 / 中位行宽
  const heights = sorted
    .map((l) => l.bottom - l.top)
    .filter((h) => h > 0)
    .sort((a, b) => a - b)
  const lineHeight = median(heights)
  // 无有效行高（伪行 / 缺坐标）→ 不做几何判定，原样逐行返回
  if (!(lineHeight > 0)) return sorted.map((l) => String(l.text).trim())
  const medianWidth = median(
    sorted
      .map((l) => l.right - l.left)
      .filter((w) => w > 0)
      .sort((a, b) => a - b)
  )

  // 3) 分栏后逐栏聚合：正常行距按栏内相邻空隙估计（跨栏空隙是噪声）
  const columns = clusterColumns(sorted)
  const paragraphs: string[] = []
  for (const col of columns) {
    const stats: GeomStats = {
      lineHeight,
      refGap: estimateRefGap(col, lineHeight),
      medianWidth
    }
    paragraphs.push(...aggregateColumn(col, stats))
  }
  return paragraphs
}

/**
 * 装配 OCR 整段文本：聚合开关开启时按段落输出，否则保持逐行输出。
 * 供「复制全部 / 发送到翻译 / 识别后自动翻译」共用，保证同一开关下各处一致。
 *
 * @param lines           OCR 识别行。
 * @param mergeParagraphs 是否聚合段落（插件设置 ocrMergeParagraphs）。
 * @returns 以换行分隔的整段文本；无有效行时返回空串。
 */
export function assembleOcrText(lines: OcrLine[], mergeParagraphs: boolean): string {
  const valid = (lines || []).filter((l) => l && String(l.text ?? '').trim())
  if (!valid.length) return ''
  if (!mergeParagraphs) return valid.map((l) => String(l.text).trimEnd()).join('\n')
  return aggregateOcrParagraphs(valid).join('\n')
}
