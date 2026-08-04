<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/**
 * 公式识别结果展示窗口（由 ztools.createBrowserWindow 打开，纯展示，原生标题栏）。
 *
 * 数据来源：主窗口在「截图 + LaTeX 识别」完成后，通过
 *   win.webContents.executeJavaScript('window.__loadLatexOcrResult({...})')
 * 把 { image, latex, isDark } 注入本窗口；本组件接收后渲染。
 *
 * 布局：左图右文（标题栏/关闭按钮由系统原生标题栏提供，本视图不自绘）。
 *   - 左侧（图区）：1:1 展示截图底图（canvas 按原图自然像素绘制），可拖动缩放。
 *   - 右侧（结果区）：LaTeX 源码 + KaTeX 渲染预览 + 复制按钮（源码 / $…$ / $$…$$）。
 *
 * 与 ScreenOcrResult 区别：右侧不是逐行文字列表，而是单段 LaTeX + 渲染；
 * 左图无透明文字层（公式无逐行坐标）。
 */

// ─── 注入数据 ─────────────────────────────────────────────────────────
const image = ref('')
const latex = ref('')
const loading = ref(true)
const errorText = ref('')

function applyTheme(isDark: boolean) {
  const root = document.documentElement
  root.classList.toggle('dark', isDark)
}

function loadData(data: {
  image?: string
  latex?: string
  isDark?: boolean
  loading?: boolean
  error?: string
}) {
  if (typeof data.image === 'string') image.value = data.image
  if (typeof data.latex === 'string') latex.value = data.latex
  if (typeof data.isDark === 'boolean') applyTheme(data.isDark)
  if (typeof data.loading === 'boolean') loading.value = data.loading
  if (typeof data.error === 'string') errorText.value = data.error
  if (data.image) nextTick(loadImage)
}

// 主窗口注入入口
;(window as any).__loadLatexOcrResult = loadData

// ─── 复制（子窗口无 window.ztools，走 navigator.clipboard）──────────
const copied = ref('')
let copiedTimer: number | null = null
function copyText(text: string) {
  if (!text) return
  try {
    navigator.clipboard?.writeText(text)
  } catch (_) {
    /* 子窗口可能无 clipboard 权限，静默失败 */
  }
}

function copy(mode: 'raw' | 'inline' | 'display') {
  if (!latex.value) return
  let text = latex.value
  if (mode === 'inline') text = '$' + latex.value + '$'
  else if (mode === 'display') text = '$$' + latex.value + '$$'
  copyText(text)
  copied.value = mode
  if (copiedTimer) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => (copied.value = ''), 1200)
}

// ─── KaTeX 渲染 ──────────────────────────────────────────────────────
const previewRef = ref<HTMLDivElement | null>(null)

watch(latex, (val) => {
  nextTick(() => {
    const el = previewRef.value
    if (!el) return
    if (!val) { el.innerHTML = ''; return }
    try {
      el.innerHTML = katex.renderToString(val, {
        displayMode: true,
        throwOnError: false,
        output: 'html'
      })
    } catch (e: any) {
      el.innerHTML = '<span class="katex-error">渲染失败：' + (e?.message || String(e)) + '</span>'
    }
  })
}, { immediate: true })

// ─── canvas 绘图（自然像素）─────────────────────────────────────────────
const canvasRef = ref<HTMLCanvasElement | null>(null)
const viewportRef = ref<HTMLDivElement | null>(null)
const naturalWidth = ref(0)
const naturalHeight = ref(0)
const stageRef = ref<HTMLDivElement | null>(null)

function loadImage() {
  if (!image.value) return
  const img = new Image()
  img.onload = () => {
    naturalWidth.value = img.naturalWidth
    naturalHeight.value = img.naturalHeight
    nextTick(() => {
      drawToCanvas(img)
      fitView()
    })
  }
  img.src = image.value
}

function computeFitScale(): number {
  const vp = viewportRef.value
  const vw = vp ? vp.clientWidth : window.innerWidth
  const vh = vp ? vp.clientHeight : window.innerHeight
  if (!naturalWidth.value || !naturalHeight.value || !vw || !vh) return 1
  const aw = vw - 16
  const ah = vh - 16
  return Math.min(aw / naturalWidth.value, ah / naturalHeight.value, 1)
}

function computeCenterOffset(s: number): { x: number; y: number } {
  const vp = viewportRef.value
  const vw = vp ? vp.clientWidth : window.innerWidth
  const vh = vp ? vp.clientHeight : window.innerHeight
  const scaledW = naturalWidth.value * s
  const scaledH = naturalHeight.value * s
  return {
    x: Math.round((vw - scaledW) / 2),
    y: Math.round((vh - scaledH) / 2)
  }
}

function fitView() {
  const s = computeFitScale()
  scale.value = s
  const center = computeCenterOffset(s)
  offsetX.value = center.x
  offsetY.value = center.y
}

function drawToCanvas(img: HTMLImageElement) {
  const canvas = canvasRef.value
  if (!canvas) return
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
}

watch(image, (src) => {
  if (src) loadImage()
  else {
    naturalWidth.value = 0
    naturalHeight.value = 0
  }
})

// ─── 拖动 + 缩放（CSS transform，不重绘 canvas）──────────────────────
const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const dragging = ref(false)
let pointerActive = false
let dragStart = { x: 0, y: 0 }
let dragOrigin = { x: 0, y: 0 }

const stageStyle = computed(() => ({
  width: naturalWidth.value ? naturalWidth.value + 'px' : 'auto',
  height: naturalHeight.value ? naturalHeight.value + 'px' : 'auto',
  transform: `translate(${offsetX.value}px, ${offsetY.value}px) scale(${scale.value})`
}))

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const vp = viewportRef.value
  if (!vp || !naturalWidth.value) return
  const vpRect = vp.getBoundingClientRect()
  const mx = e.clientX - vpRect.left
  const my = e.clientY - vpRect.top
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const next = Math.min(8, Math.max(0.1, scale.value * factor))
  const pointX = (mx - offsetX.value) / scale.value
  const pointY = (my - offsetY.value) / scale.value
  offsetX.value = mx - pointX * next
  offsetY.value = my - pointY * next
  scale.value = next
}

const DRAG_THRESHOLD = 4
let didDrag = false
function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  pointerActive = true
  didDrag = false
  dragStart = { x: e.clientX, y: e.clientY }
  dragOrigin = { x: offsetX.value, y: offsetY.value }
}
function onPointerMove(e: PointerEvent) {
  if (!pointerActive) return
  const dx = e.clientX - dragStart.x
  const dy = e.clientY - dragStart.y
  if (!dragging.value && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
  if (!dragging.value) {
    dragging.value = true
    didDrag = true
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  offsetX.value = dragOrigin.x + dx
  offsetY.value = dragOrigin.y + dy
}
function onPointerUp(e: PointerEvent) {
  pointerActive = false
  if (dragging.value) {
    dragging.value = false
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }
}

function zoomBy(factor: number) {
  const next = Math.min(8, Math.max(0.1, scale.value * factor))
  scale.value = next
}

function resetView() {
  scale.value = 1
  offsetX.value = 0
  offsetY.value = 0
}

// ─── 生命周期 ─────────────────────────────────────────────────────────
function onWinResize() {
  if (scale.value <= computeFitScale() + 0.001) {
    fitView()
  }
}

onMounted(() => {
  const vp = viewportRef.value
  if (vp) {
    vp.addEventListener('wheel', onWheel, { passive: false })
  }
  window.addEventListener('resize', onWinResize)
})

onUnmounted(() => {
  const vp = viewportRef.value
  if (vp) vp.removeEventListener('wheel', onWheel)
  window.removeEventListener('resize', onWinResize)
  if (copiedTimer) window.clearTimeout(copiedTimer)
})
</script>

<template>
  <div class="result-window">
    <div class="body">
      <!-- 左侧：图片区（适应窗口展示 + 拖动缩放） -->
      <div class="pane pane-image">
        <div ref="viewportRef" class="viewport" :class="{ 'is-dragging': dragging }">
          <div
            v-if="image"
            ref="stageRef"
            class="stage"
            :style="stageStyle"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <canvas ref="canvasRef" class="stage-canvas"></canvas>
          </div>
          <div v-else-if="loading" class="state-hint">识别中…</div>
          <div v-else-if="errorText" class="state-hint error">{{ errorText }}</div>
          <div v-else class="state-hint">无图片</div>
        </div>

        <!-- 图片工具栏 -->
        <div v-if="image" class="img-toolbar">
          <button type="button" class="tool-btn" title="缩小" @click="zoomBy(1 / 1.2)">−</button>
          <span class="zoom-text">{{ Math.round(scale * 100) }}%</span>
          <button type="button" class="tool-btn" title="放大" @click="zoomBy(1.2)">+</button>
          <button type="button" class="tool-btn" title="适应窗口" @click="fitView">适应</button>
          <button type="button" class="tool-btn reset-btn" title="1:1 原始尺寸" @click="resetView">
            1:1
          </button>
        </div>
      </div>

      <!-- 右侧：LaTeX 源码 + KaTeX 预览 + 复制 -->
      <div class="pane pane-result">
        <header class="result-head">
          <span class="result-title">识别结果</span>
          <span v-if="copied" class="copied-tip">已复制</span>
        </header>

        <div v-if="loading" class="result-empty">识别中…</div>
        <div v-else-if="errorText" class="result-empty error">{{ errorText }}</div>
        <div v-else-if="!latex" class="result-empty">未识别到公式</div>
        <template v-else>
          <!-- KaTeX 渲染预览 -->
          <div class="result-section">
            <div class="section-title">渲染预览</div>
            <div ref="previewRef" class="katex-preview"></div>
          </div>
          <!-- LaTeX 源码 -->
          <div class="result-section">
            <div class="section-title">LaTeX 源码</div>
            <pre class="latex-source">{{ latex }}</pre>
          </div>
          <!-- 复制按钮 -->
          <div class="copy-actions">
            <button type="button" class="copy-btn" @click="copy('raw')">复制源码</button>
            <button type="button" class="copy-btn" @click="copy('inline')">复制 $…$</button>
            <button type="button" class="copy-btn" @click="copy('display')">复制 $$…$$</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.result-window {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.pane-image {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--img-bg, #1e1e1e);
  position: relative;
}

.viewport {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  cursor: grab;
  padding: 0;
}

.viewport.is-dragging {
  cursor: grabbing;
}

.stage {
  position: relative;
  flex: 0 0 auto;
  transform-origin: 0 0;
  line-height: 0;
  touch-action: none;
  user-select: none;
}

.stage-canvas {
  display: block;
  width: 100%;
  height: 100%;
  user-select: none;
}

.state-hint {
  margin: auto;
  color: var(--text-secondary, #999);
  font-size: 14px;
}

.state-hint.error {
  color: #e53935;
}

.img-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px;
  background: var(--toolbar-bg, rgba(0, 0, 0, 0.04));
  border-top: 1px solid #454545;
}

.tool-btn {
  min-width: 30px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid #454545;
  border-radius: 6px;
  background: var(--btn-bg, rgba(255, 255, 255, 0.08));
  color: #fff;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s;
}

.tool-btn:hover {
  background: var(--btn-hover-bg, rgba(128, 128, 128, 0.2));
}

.reset-btn {
  font-size: 12px;
}

.zoom-text {
  min-width: 48px;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary, #999);
}

/* 右侧结果区 */
.pane-result {
  flex: 0 0 380px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  background: var(--pane-bg, transparent);
}

.result-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.15));
}

.result-title {
  font-size: 14px;
  font-weight: 600;
}

.copied-tip {
  font-size: 11px;
  color: #4caf50;
}

.result-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #999);
  font-size: 14px;
  padding: 24px;
  text-align: center;
}

.result-empty.error {
  color: #e53935;
}

.result-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #666);
}

.katex-preview {
  padding: 16px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid var(--border-color, #e5e6eb);
  overflow-x: auto;
  min-height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
}

:global(html.dark) .katex-preview {
  background: #2a2a2a;
}

.katex-error {
  color: #e53935;
  font-size: 13px;
}

.latex-source {
  margin: 0;
  padding: 12px;
  background: var(--code-bg, #f5f5f5);
  border-radius: 8px;
  border: 1px solid var(--border-color, #e5e6eb);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow: auto;
  color: var(--text-primary, #333);
}

.copy-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 16px;
}

.copy-btn {
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
  border-radius: 6px;
  background: var(--btn-bg, rgba(128, 128, 128, 0.1));
  color: inherit;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.copy-btn:hover {
  background: var(--btn-hover-bg, rgba(128, 128, 128, 0.22));
}
</style>

<!-- 全局样式兜底：子窗口由 createBrowserWindow 打开，无 main.css 的 html/body 重置可能不生效 -->
<style>
html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC',
    'Microsoft YaHei', sans-serif;
}
#app {
  height: 100vh;
}
</style>
