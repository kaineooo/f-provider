<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ZButton, useToast } from 'ztools-ui'
import EngineStatusCard from '../components/EngineStatusCard.vue'
import { useLatexEngine } from '../composables/useLatexEngine'

/**
 * 截图识别公式子页（独立 feature screen-latex 的全屏视图，Windows / macOS）。
 *
 * 与 ScreenOcr.vue（截图识别文字）同构，只是引擎换成 LaTeX ONNX：
 *   1. 检查 LaTeX 引擎是否就绪（latexStatus）。
 *   2. 未就绪 → 留在本页展示下载引导（内嵌 EngineStatusCard engine-kind="latex"）。
 *   3. 已就绪 → 调系统截图 ztools.screenCapture，截完作为参数调 LaTeX 识别。
 *   4. 识别完成 → 通过 ztools.createBrowserWindow 打开「结果展示窗口」，
 *      把图片 + LaTeX 注入该窗口（webContents.executeJavaScript），
 *      窗口内左图右文展示（1:1 图片 + LaTeX 源码 + KaTeX 渲染 + 复制）。
 *   5. 退出主插件（outPlugin），识别结果在独立窗口中查看。
 */

type Phase = 'idle' | 'capturing' | 'recognizing' | 'done' | 'error'

const { success, error: errorToast, info: infoToast } = useToast()
const { latexReady, latexState, checkLatex } = useLatexEngine()

const phase = ref<Phase>('idle')
const errorText = ref('')

const busy = computed(
  () => phase.value === 'capturing' || phase.value === 'recognizing'
)

const showDownloadGuide = computed(
  () => !latexReady.value && latexState.value !== 'checking'
)

async function startFlow(): Promise<void> {
  phase.value = 'idle'
  errorText.value = ''
  await checkLatex()
  if (latexState.value === 'ready') {
    capture()
  }
}

function capture(): void {
  if (busy.value) return
  phase.value = 'capturing'

  window.ztools.screenCapture((imgBase64: string) => {
    if (!imgBase64) {
      errorToast('已取消截图')
      try {
        window.ztools.outPlugin()
      } catch (_) { /* ignore */ }
      return
    }
    const dataUri = imgBase64.startsWith('data:')
      ? imgBase64
      : 'data:image/png;base64,' + imgBase64
    recognize(dataUri)
  })
}

async function recognize(image: string): Promise<void> {
  phase.value = 'recognizing'
  errorText.value = ''
  try {
    const result = await window.services.latexRecognizeDetail(image)
    if (result.ok) {
      phase.value = 'done'
      const latex = result.latex || ''
      if (!latex) {
        infoToast('未识别到公式')
      } else {
        success('公式识别完成')
      }
      openResultWindow(image, latex)
    } else {
      phase.value = 'error'
      errorText.value = result.error || '识别失败'
      errorToast(errorText.value)
    }
  } catch (err: any) {
    phase.value = 'error'
    errorText.value = err?.message ? String(err.message) : String(err)
    errorToast(errorText.value)
  }
}

/**
 * 打开结果展示窗口并把识别数据注入（与 ScreenOcr.openResultWindow 同构）。
 * 窗口使用原生标题栏、隐藏菜单栏；初始尺寸不低于 800×600 且不超屏。
 */
function openResultWindow(image: string, latexStr: string): void {
  const imgSize = decodePngSize(image)

  const display = window.ztools.getPrimaryDisplay()
  const workArea = display.workArea
  const screenWDip = workArea.width
  const screenHDip = workArea.height
  const scaleFactor = display.scaleFactor || 1

  const RESULT_PANE_W = 380
  const TITLEBAR_H = 0

  const availImgWDip = Math.max(200, screenWDip - RESULT_PANE_W - 16)
  const availImgHDip = Math.max(150, screenHDip - TITLEBAR_H - 16)

  let winW: number
  let winH: number
  if (imgSize) {
    const imgWDip = imgSize.width / scaleFactor
    const imgHDip = imgSize.height / scaleFactor
    const imgAreaW = Math.min(imgWDip, availImgWDip)
    const imgAreaH = Math.min(imgHDip, availImgHDip)
    winW = Math.round(imgAreaW + RESULT_PANE_W)
    winH = Math.round(Math.max(imgAreaH + TITLEBAR_H, 320))
  } else {
    winW = Math.round(screenWDip * 0.75)
    winH = Math.round(screenHDip * 0.85)
  }
  winW = Math.min(winW, screenWDip)
  winH = Math.min(winH, screenHDip)
  winW = Math.max(winW, 800)
  winH = Math.max(winH, 600)

  const isDark = window.ztools.isDarkColors()
  const url = 'latex-ocr-result.html'

  try {
    const win = window.ztools.createBrowserWindow(
      url,
      {
        width: winW,
        height: winH,
        x: workArea.x + Math.floor((screenWDip - winW) / 2),
        y: workArea.y + Math.floor((screenHDip - winH) / 2),
        resizable: true,
        title: '公式识别结果',
        autoHideMenuBar: true,
        icon: window.services.pluginLogoNativeImage() || window.services.pluginLogoPath(),
        maxWidth: screenWDip,
        maxHeight: screenHDip,
        webPreferences: { zoomFactor: 1 }
      },
      () => {
        injectData(win, { image, latex: latexStr, isDark })
      }
    )
    window.setTimeout(
      () => injectData(win, { image, latex: latexStr, isDark }),
      800
    )
    try {
      window.ztools.outPlugin()
    } catch (_) { /* ignore */ }
  } catch (err: any) {
    errorToast('打开结果窗口失败：' + (err?.message ? String(err.message) : String(err)))
    phase.value = 'error'
  }
}

function injectData(
  win: BrowserWindow.WindowInstance,
  data: { image: string; latex: string; isDark: boolean }
): void {
  try {
    const payload = JSON.stringify(data)
    const code = `window.__loadLatexOcrResult && window.__loadLatexOcrResult(${payload});`
    win.webContents.executeJavaScript(code)
  } catch (_) { /* ignore */ }
}

/** 从 PNG data URI 解析宽高（IHDR 在固定偏移）。非 PNG / 解析失败返回 null。 */
function decodePngSize(dataUri: string): { width: number; height: number } | null {
  try {
    const m = /^data:image\/png;base64,(.+)$/i.exec(dataUri)
    if (!m) return null
    const b64 = m[1].slice(0, 32)
    const bin = atob(b64)
    if (bin.length < 24) return null
    const width =
      (bin.charCodeAt(16) << 24) |
      (bin.charCodeAt(17) << 16) |
      (bin.charCodeAt(18) << 8) |
      bin.charCodeAt(19)
    const height =
      (bin.charCodeAt(20) << 24) |
      (bin.charCodeAt(21) << 16) |
      (bin.charCodeAt(22) << 8) |
      bin.charCodeAt(23)
    if (width > 0 && height > 0) return { width, height }
  } catch (_) { /* ignore */ }
  return null
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && phase.value !== 'capturing') {
    try {
      window.ztools.outPlugin()
    } catch (_) { /* ignore */ }
  }
}

function onDownloaded(): void {
  capture()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // 每次进入都由 App.vue 的 :key（含 enterSeq）重建本组件、触发 onMounted，
  // 故这里显式启动一次即可覆盖「首次进入」与「同 feature 重复唤醒」两种情形。
  // ⚠️ 切勿在此注册 window.ztools.onPluginEnter：它是覆盖式 setter（无 off API），
  // 会顶掉 App.vue 的中央路由回调，导致之后切到其它 feature（如「ZTools 提供商」）
  // 时 enterAction 不再更新、仍被劫持来截图。
  startFlow()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.services.latexDispose()
})
</script>

<template>
  <div class="screen-orchestrator">
    <!-- 未就绪：内嵌下载引导 -->
    <div v-if="showDownloadGuide" class="download-wrap">
      <EngineStatusCard :show-actions="false" engine-kind="latex" @downloaded="onDownloaded" />
      <p class="after-tip">下载完成后将自动开始截图识别公式</p>
    </div>

    <!-- 就绪后 / 识别流程中的状态展示 -->
    <div v-else class="status-card">
      <div class="status-icon" :class="{ spin: phase === 'recognizing' }">
        {{ phase === 'capturing' ? '✂️' : phase === 'recognizing' ? '🔍' : '📷' }}
      </div>
      <div class="status-text">
        <template v-if="phase === 'capturing'">请在屏幕上框选要识别的公式…</template>
        <template v-else-if="phase === 'recognizing'">正在识别公式…</template>
        <template v-else-if="phase === 'error'">{{ errorText || '识别失败' }}</template>
        <template v-else-if="phase === 'done'">识别完成，已打开结果窗口</template>
        <template v-else>
          {{ latexState === 'checking' ? '检查引擎中…' : '准备截图…' }}
        </template>
      </div>
      <ZButton v-if="phase === 'error'" type="primary" @click="capture">重试截图</ZButton>
    </div>
  </div>
</template>

<style scoped>
.screen-orchestrator {
  padding: 24px 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  box-sizing: border-box;
}

.download-wrap {
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.after-tip {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary, #999);
  text-align: center;
}

.status-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
}

.status-icon {
  font-size: 36px;
  opacity: 0.85;
}

.status-icon.spin {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.status-text {
  font-size: 14px;
  color: var(--text-secondary, #999);
}
</style>
