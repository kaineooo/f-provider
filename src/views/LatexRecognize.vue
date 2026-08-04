<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { ZButton, ZTag, useToast } from 'ztools-ui'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import EngineStatusCard from '../components/EngineStatusCard.vue'
import { useLatexEngine } from '../composables/useLatexEngine'

/**
 * 公式识别子页（管理页内 Tab，跨平台）。
 *
 * 与「识别」子页（微信 OCR 文字识别）并行：选图/拖拽/粘贴 → 公式识别 →
 * 左图 + 右侧 LaTeX 源码 + KaTeX 渲染预览 + 复制（源码 / $…$ / $$…$$）。
 *
 * 引擎：本地 ONNX（pix2tex 导出），独立于微信 OCR；未就绪时内嵌
 * EngineStatusCard（engine-kind="latex"）引导下载。
 */

const props = withDefaults(
  defineProps<{
    /** 进入时预填的待识别图片（data URI 或本地 path）。 */
    initialImage?: string
  }>(),
  { initialImage: '' }
)

const { success, error } = useToast()
const { latexReady, checkLatex } = useLatexEngine()

// ─── 图片与识别状态 ──────────────────────────────────────────────────
const imageSrc = ref('')
const recognizeSrc = ref('')
const loading = ref(false)
const errorText = ref('')
const latex = ref('')
const dragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const previewRef = ref<HTMLDivElement | null>(null)

const hasResult = computed(() => !!latex.value)

// KaTeX 渲染：latex 变化时把渲染结果写入 previewRef
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
})

// 把 File 读成 data URL
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function pickImage() {
  fileInput.value?.click()
}

async function setImageFromFile(file: File) {
  if (!file.type.startsWith('image/')) {
    errorText.value = '请选择图片文件'
    return
  }
  errorText.value = ''
  latex.value = ''
  const dataUrl = await readFileAsDataURL(file)
  imageSrc.value = dataUrl
  recognizeSrc.value = dataUrl
}

async function setImageFromInitial(image: string) {
  errorText.value = ''
  latex.value = ''
  recognizeSrc.value = image
  if (/^data:/i.test(image) || /^https?:\/\//i.test(image)) {
    imageSrc.value = image
  } else {
    try {
      imageSrc.value = window.services.readFileAsDataURL(image)
    } catch (e: any) {
      imageSrc.value = ''
    }
  }
}

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  await setImageFromFile(file)
  target.value = ''
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) setImageFromFile(file)
}
function onDragOver() { dragOver.value = true }
function onDragLeave() { dragOver.value = false }

async function onPaste(e: ClipboardEvent) {
  const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'))
  const file = item?.getAsFile()
  if (file) await setImageFromFile(file)
}

// 执行识别
async function recognize() {
  if (!recognizeSrc.value || !latexReady.value) return
  loading.value = true
  errorText.value = ''
  latex.value = ''
  try {
    const result = await window.services.latexRecognizeDetail(recognizeSrc.value)
    if (result.ok) {
      latex.value = result.latex || ''
      if (!latex.value) error('未识别到公式')
      else success('公式识别完成')
    } else {
      errorText.value = result.error || '识别失败'
      error(errorText.value)
    }
  } catch (err: any) {
    errorText.value = err?.message ? String(err.message) : String(err)
    error(errorText.value)
  } finally {
    loading.value = false
  }
}

// 复制：源码 / $…$ / $$…$$
function copy(mode: 'raw' | 'inline' | 'display') {
  if (!latex.value) return
  let text = latex.value
  if (mode === 'inline') text = '$' + latex.value + '$'
  else if (mode === 'display') text = '$$' + latex.value + '$$'
  window.ztools.copyText(text)
  success(mode === 'raw' ? '已复制 LaTeX 源码' : mode === 'inline' ? '已复制 $…$ 形式' : '已复制 $$…$$ 形式')
}

// ─── 外部 initialImage 自动识别 ──────────────────────────────────────
const pendingInitial = ref('')
async function applyInitial(image: string) {
  if (!image) return
  if (!latexReady.value) {
    pendingInitial.value = image
    return
  }
  await setImageFromInitial(image)
  recognize()
}

watch(
  () => props.initialImage,
  (image) => {
    if (image) applyInitial(image)
  },
  { immediate: true }
)

watch(latexReady, (ready) => {
  if (ready && pendingInitial.value) {
    const img = pendingInitial.value
    pendingInitial.value = ''
    applyInitial(img)
  }
})

onMounted(() => {
  window.addEventListener('paste', onPaste)
  checkLatex()
})

onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  window.services.latexDispose()
})
</script>

<template>
  <div class="latex-recognize">
    <header class="page-head">
      <h2 class="page-title">公式识别</h2>
      <div class="page-meta">
        <span v-if="latexReady" class="meta-item">
          <ZTag type="success" size="small">引擎就绪</ZTag>
        </span>
        <span v-else class="meta-item">
          <ZTag type="warning" size="small">引擎未就绪</ZTag>
        </span>
      </div>
    </header>

    <template v-if="!latexReady">
      <EngineStatusCard :show-actions="false" engine-kind="latex" @downloaded="checkLatex" />
    </template>

    <template v-else>
      <!-- 工具栏 -->
      <div class="toolbar">
        <ZButton type="primary" @click="pickImage">选择图片</ZButton>
        <ZButton :disabled="!recognizeSrc || loading" :loading="loading" @click="recognize">
          {{ loading ? '识别中…' : '识别公式' }}
        </ZButton>
        <span class="toolbar-tip">支持点击选图 · 拖入图片 · 粘贴图片（Ctrl+V）</span>
      </div>

      <!-- 主体：左图 + 右侧结果 -->
      <div
        class="stage"
        :class="{ 'drag-over': dragOver }"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <!-- 左：图片预览 -->
        <div class="pane pane-image">
          <img v-if="imageSrc" :src="imageSrc" alt="公式图片" class="formula-img" />
          <div v-else class="empty">点击上方「选择图片」，或拖入 / 粘贴图片</div>
        </div>

        <!-- 右：LaTeX 源码 + KaTeX 预览 + 复制 -->
        <div class="pane pane-result">
          <div v-if="loading" class="result-empty">识别中…</div>
          <div v-else-if="errorText" class="result-empty error">{{ errorText }}</div>
          <div v-else-if="!hasResult" class="result-empty">未识别到公式</div>
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
              <ZButton size="small" @click="copy('raw')">复制源码</ZButton>
              <ZButton size="small" @click="copy('inline')">复制 $…$</ZButton>
              <ZButton size="small" @click="copy('display')">复制 $$…$$</ZButton>
            </div>
          </template>
        </div>
      </div>
    </template>

    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      class="file-input"
      @change="onFileChange"
    />
  </div>
</template>

<style scoped>
.latex-recognize {
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.page-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.page-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary, #999);
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.toolbar-tip {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-secondary, #999);
}

.stage {
  display: flex;
  gap: 16px;
  min-height: 240px;
  border: 1.5px dashed var(--border-color, #c0c0c0);
  border-radius: 12px;
  padding: 16px;
  transition: border-color 0.15s, background 0.15s;
  background: var(--stage-bg, rgba(0, 0, 0, 0.02));
}

.stage.drag-over {
  border-color: var(--primary-color, #1976d2);
  background: var(--hover-bg, rgba(25, 118, 210, 0.05));
}

.pane-image {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--img-bg, #1e1e1e);
  border-radius: 8px;
  overflow: auto;
  min-height: 200px;
}

.formula-img {
  max-width: 100%;
  max-height: 400px;
  object-fit: contain;
}

.empty {
  color: var(--text-secondary, #999);
  font-size: 13px;
  text-align: center;
}

.pane-result {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px;
  background: var(--pane-bg, transparent);
}

.result-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  color: var(--text-secondary, #999);
  font-size: 14px;
  text-align: center;
}

.result-empty.error {
  color: #e53935;
}

.result-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
}

.file-input {
  display: none;
}
</style>
