import { ref, computed } from 'vue'

/**
 * LaTeX OCR 引擎状态机：复用给「公式识别」「截图识别公式」「引擎管理」三处视图。
 *
 * 与 useNativeEngine 完全同构，只是调用 latex* 系列服务（独立于微信 OCR 引擎）。
 * 流程：checking -> (missing | ready) -> downloading/extracting -> ready
 */

export type LatexState =
  | 'checking'
  | 'missing'
  | 'downloading'
  | 'extracting'
  | 'ready'
  | 'error'

export function useLatexEngine() {
  const latexState = ref<LatexState>('checking')
  const downloadPercent = ref(0)
  const downloadLoaded = ref(0)
  const downloadTotal = ref(0)
  const latexError = ref('')
  const latexVersion = ref<string | null>(null)
  const latexMissing = ref<string[]>([])

  // 检查 LaTeX 引擎状态（按文件存在性判断）
  async function checkLatex() {
    latexState.value = 'checking'
    try {
      const status = window.services.latexStatus()
      latexVersion.value = status.version
      latexMissing.value = status.missing || []
      latexState.value = status.ready ? 'ready' : 'missing'
    } catch (_) {
      // preload 方法缺失等异常：保守地进入 missing，避免阻塞
      latexState.value = 'missing'
    }
  }

  // 下载并解压 LaTeX 引擎
  async function downloadLatex(): Promise<boolean> {
    if (latexState.value === 'downloading' || latexState.value === 'extracting') {
      return false
    }
    latexState.value = 'downloading'
    downloadPercent.value = 0
    downloadLoaded.value = 0
    downloadTotal.value = 0
    latexError.value = ''
    try {
      const result = await window.services.latexDownload((progress) => {
        if (progress.phase === 'downloading') {
          latexState.value = 'downloading'
          downloadPercent.value = progress.percent
          downloadLoaded.value = progress.loaded
          downloadTotal.value = progress.total
        } else if (progress.phase === 'extracting') {
          latexState.value = 'extracting'
        }
      })
      if (result.ok) {
        latexState.value = 'ready'
        return true
      } else {
        latexState.value = 'error'
        latexError.value = result.error || '下载失败'
        return false
      }
    } catch (err: any) {
      latexState.value = 'error'
      latexError.value = err?.message ? String(err.message) : String(err)
      return false
    }
  }

  // 删除已下载的 LaTeX 引擎，回到 missing 态
  function removeLatex() {
    try {
      window.services.latexRemove()
    } catch (_) {}
    latexState.value = 'missing'
    checkLatex()
  }

  const latexReady = computed(() => latexState.value === 'ready')
  const isBusy = computed(
    () => latexState.value === 'downloading' || latexState.value === 'extracting'
  )

  // 把字节格式化为人类可读
  function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let n = bytes
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024
      i++
    }
    return `${n.toFixed(1)} ${units[i]}`
  }

  return {
    // state
    latexState,
    downloadPercent,
    downloadLoaded,
    downloadTotal,
    latexError,
    latexVersion,
    latexMissing,
    // computed
    latexReady,
    isBusy,
    // actions
    checkLatex,
    downloadLatex,
    removeLatex,
    // utils
    formatBytes
  }
}
