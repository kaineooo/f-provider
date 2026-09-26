<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated, watch, nextTick } from "vue";
import { ZButton, ZTag, useToast, useColorScheme } from "ztools-ui";
import katex from "katex";
import "katex/dist/katex.min.css";
import EngineStatusCard from "../components/EngineStatusCard.vue";
import OcrImageViewer from "../components/OcrImageViewer.vue";
import { useNativeEngine } from "../composables/useNativeEngine";
import { useLatexEngine } from "../composables/useLatexEngine";
import { usePluginSettings } from "../composables/usePluginSettings";
import { useSegmentIndicator } from "../composables/useSegmentIndicator";
import { aggregateOcrParagraphs, assembleOcrText } from "../utils/ocrText";
import {
  buildMarkdownTable,
  markdownTableToHtml,
  markdownTableToTsv,
  parseMarkdownTable,
} from "../utils/markdownTable";
import { splitOcrRegions } from "../utils/ocrTable";

/**
 * 识别子页（文字 OCR / 公式识别 / 表格识别三合一）：左右结构。
 *
 * 左侧：图片舞台（拖拽/粘贴/选图）。
 *   - 文字模式：复用 OcrImageViewer（canvas 绘图 + 透明文字层 + 全屏预览），
 *     通过 hideResult 隐藏其内置列表，改由右侧统一渲染。
 *   - 公式 / 表格模式：普通 <img> 预览。
 * 右侧：结果面板。
 *   - 顶部：模式切换（文字 / 公式 / 表格）+ 独立 AI 开关 + 引擎状态标签 + 操作按钮。
 *   - 文字：聚合开启时按段落 textarea 回显（可编辑、无置信度）；
 *     关闭时为识别行列表，与左侧图上文字双向高亮联动，点击复制。
 *   - 公式：KaTeX 渲染预览 + LaTeX 源码 + 三种复制形式。
 *   - 表格：AI 渠道输出 Markdown；本机引擎渠道对识别行做几何聚类恢复
 *     table / row / cell 后序列化为 Markdown，两渠道共用表格预览 +
 *     复制为表格（TSV）/ 复制为 md / 复制 HTML。
 *
 * 渠道：AI 统一视觉模型（识图 / 公式 / 表格共用同一模型，提示词内置），由模式切换条
 * 右侧的独立「AI」开关控制渠道：开启走 AI，关闭走本机引擎（文字 / 表格 = 微信 OCR，
 * 公式 = 本地 LaTeX 引擎；表格模式本机渠道对识别行做几何聚类恢复表格结构）。
 * 切换模式时保留同一张图片与各自的识别结果（互不干扰），可对同一图片
 * 分别进行识别。切换到某模式时自动触发一次识别；若该模式已
 * 有缓存结果则直接展示，不重复识别。引擎未就绪期间选图，模型下载完成后
 * 自动补识别当前模式。
 */

const props = withDefaults(
  defineProps<{
    /** 进入时预填的待识别图片（data URI 或本地 path）。 */
    initialImage?: string;
    /** 初始模式（由父组件根据入口 action.code 决定）。 */
    initialMode?: "text" | "formula" | "table";
    /**
     * 进入即自动截屏（screen-ocr / screen-latex feature）。
     * 为 true 时，组件挂载后引擎就绪即自动调系统截图；引擎未就绪则等下载完成后
     * 由 watcher 触发。截图结果留在本页展示，不再弹独立窗口。
     */
    autoCapture?: boolean;
    /**
     * 文字识别成功后自动上抛 translate 事件，由父组件切到「翻译」tab 预填并翻译
     * （screen-ocr-translate / ocr-translate feature）。
     * 门控 translateFired 确保同一张图只联动一次；换新图（resetResults）后重置，
     * 允许再次联动。OCR 空结果 / 失败不上抛。
     */
    translateAfterOcr?: boolean;
  }>(),
  { initialImage: "", initialMode: "text", autoCapture: false, translateAfterOcr: false },
);

// 响应式暗色标记：宿主切换主题时同步，用于避免 :global(html.dark) 在 scoped 下不生效。
const { isDark } = useColorScheme();

/**
 * 识别成功后上抛 history 事件：由 Manage 统一写入历史记录单例（dbStorage），
 * 不在子组件内直接依赖 dbStorage。
 */
const emit = defineEmits<{
  (e: "history", item: HistoryEmitItem): void;
  (e: "translate", text: string): void;
  /**
   * 文字识别成功后上抛当前识别文本（供父组件在用户手动切到翻译 tab 时带入）。
   * 与 translate 事件不同：translate 仅 translateAfterOcr 联动场景触发且只一次，
   * text-result 在每次文字识别成功（含重识别、切渠道重识别）后都同步最新结果。
   * 空结果不上抛。
   */
  (e: "text-result", text: string): void;
}>();

const { success, error } = useToast();
const { nativeReady, checkNative } = useNativeEngine();
const { latexReady, checkLatex } = useLatexEngine();
// 插件行为设置：OCR 结果聚合段落开关（见下方 assembledOcrText）
const { settings } = usePluginSettings();

// ─── AI 渠道开关（统一视觉模型：识图 / 公式 / 表格共用）─────────────────
// 模式切换条右侧的独立「AI」开关：开启后走宿主 AI 视觉模型，
// 关闭则用本机引擎（微信 OCR / 本地 LaTeX 引擎；表格模式对识别行做几何聚类）。
// 统一视觉模型在「渠道」页「AI 识别」中配置（提示词内置）；开关状态持久化到 dbStorage。
type TextProviderName = "ocr" | "ai-ocr";
type FormulaProviderName = "latex" | "ai-latex-ocr";

// AI 统一模型是否已配置（「渠道」页「AI 识别」中选了视觉模型）；本机引擎恒可用。
const aiModelConfigured = ref(false);
function refreshProviderStatus() {
  try {
    const ao = window.services.getOcrSettings("ai-ocr");
    aiModelConfigured.value = !!ao.model;
  } catch (_) {
    /* preload 异常：保持默认，不阻塞 */
  }
}

// AI 开关持久化（dbStorage key: ocr.aiEnabled）。
// 旧版本按模式分渠道存（ocr.textProvider / ocr.formulaProvider）：
// 任一模式上次用了 AI 则迁移为默认开启，避免升级后 AI 偏好丢失。
const AI_ENABLED_KEY = "ocr.aiEnabled";
function loadAiEnabled(): boolean {
  try {
    const v = window.ztools.dbStorage.getItem(AI_ENABLED_KEY);
    if (typeof v === "boolean") return v;
    const tp = window.ztools.dbStorage.getItem<string>("ocr.textProvider");
    const fp = window.ztools.dbStorage.getItem<string>("ocr.formulaProvider");
    return tp === "ai-ocr" || fp === "ai-latex-ocr";
  } catch (_) {
    /* dbStorage 不可用：回落默认（本机引擎） */
  }
  return false;
}
function saveAiEnabled(on: boolean): void {
  try {
    window.ztools.dbStorage.setItem(AI_ENABLED_KEY, on);
  } catch (_) {
    /* 写入失败忽略 */
  }
}

/**
 * AI 开关点击：未配置模型时提示并保持原渠道；
 * 否则切换开关并持久化，watch(aiEnabled) 会触发重识别（三种模式均支持双渠道）。
 */
function toggleAi(): void {
  if (!aiEnabled.value && !aiModelConfigured.value) {
    error("请先在「渠道」页「AI 识别」中选择视觉模型");
    return;
  }
  aiEnabled.value = !aiEnabled.value;
  saveAiEnabled(aiEnabled.value);
}

/** AI 开关悬浮提示：按配置状态给出操作指引。 */
const aiToggleTitle = computed(() => {
  if (aiEnabled.value) return "已启用 AI 识别，点击关闭改用本机引擎";
  if (!aiModelConfigured.value)
    return "未选择 AI 视觉模型，请先在「渠道」页「AI 识别」中配置";
  return "启用 AI 识别（当前使用本机引擎）";
});

// setup 期初始化：先刷新 AI 配置状态，再回填开关（含旧版本渠道偏好迁移）。
// 在 setup 期完成，确保挂载时渠道已是最终值，避免 initialImage 首次识别用错渠道。
refreshProviderStatus();
const aiEnabled = ref(loadAiEnabled());

// 当前模式实际使用的渠道（由 AI 开关推导）：识别派发与图片叠层控制复用。
const textProvider = computed<TextProviderName>(() =>
  aiEnabled.value ? "ai-ocr" : "ocr",
);
const formulaProvider = computed<FormulaProviderName>(() =>
  aiEnabled.value ? "ai-latex-ocr" : "latex",
);

// ─── 模式 ────────────────────────────────────────────────────────────
const mode = ref<"text" | "formula" | "table">(props.initialMode);

function switchMode(next: "text" | "formula" | "table") {
  if (mode.value === next) return;
  mode.value = next;
  // 切换后自动识别当前模式：若该模式已有缓存结果则直接展示（命中缓存不重识别），
  // 否则触发一次识别；引擎未就绪时静默跳过，由引擎引导卡引导下载，
  // 就绪后由 nativeReady/latexReady watcher 补识别。
  autoRecognize();
}

// 引擎就绪态按模式 + 渠道映射：AI 渠道不依赖本机引擎（已配置模型即视为就绪）；
// 本机渠道：文字 / 表格 = 微信 OCR 引擎，公式 = 本地 LaTeX 引擎。
const engineReady = computed(() => {
  if (!aiEnabled.value) {
    return mode.value === "formula" ? latexReady.value : nativeReady.value;
  }
  return mode.value === "table" ? aiModelConfigured.value : true;
});

// 模式切换条滑动高亮：文字=0、公式=1、表格=2
const modeIndex = computed(() =>
  mode.value === "text" ? 0 : mode.value === "formula" ? 1 : 2,
);
const {
  containerRef: modeSwitchRef,
  setItemRef: setModeItemRef,
  pos: modeIndicator,
  noAnim: modeNoAnim,
} = useSegmentIndicator(modeIndex);

// ─── 图片与识别状态 ──────────────────────────────────────────────────
// imageSrc 用于预览（data URI / URL）；recognizeSrc 才是真正传给识别服务的源。
const imageSrc = ref("");
const recognizeSrc = ref("");
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

// 文字 OCR 结果
const ocrLoading = ref(false);
const ocrError = ref("");
const ocrLines = ref<OcrLine[]>([]);
const ocrDone = ref(false); // 标记是否已识别过（区分空结果与未识别）
// AI 文字渠道返回整段文本无坐标，叠层隐藏：传给 OcrImageViewer 的 lines 在
// AI 渠道下置空，只显示原图；微信 OCR 渠道保留坐标高亮联动。
const viewerLines = computed(() =>
  textProvider.value === "ai-ocr" ? [] : ocrLines.value,
);

/**
 * 整段识别文本：「复制全部 / 发送到翻译 / 识别后自动翻译」共用。
 * - AI 渠道：直接取可编辑的 aiText（本身已是整段，无需聚合）。
 * - 微信 OCR 渠道：
 *   - 聚合开启：取 paraText（识别成功时按段落聚合回填，可在段落视图中编辑，
 *     复制 / 翻译以编辑后为准）。
 *   - 聚合关闭：保持逐行换行（旧行为），右侧也仍按行展示置信度明细。
 */
const assembledOcrText = computed(() => {
  if (textProvider.value === "ai-ocr") return aiText.value;
  if (settings.ocrMergeParagraphs) return paraText.value;
  return assembleOcrText(ocrLines.value, false);
});

/**
 * 聚合段落的编辑/回显状态（仅微信 OCR 渠道、聚合开启时使用）。
 * - paraText：按段落聚合后的整段文本（段落间单个换行），识别成功时回填；
 *   右侧以 textarea 形式回显（不再展示行级置信度），可直接编辑纠错。
 * - 段落数取自编辑后文本的非空行数，随编辑实时更新。
 */
const paraText = ref("");
const paraCount = computed(
  () => paraText.value.split(/\r?\n/).filter((l) => l.trim()).length,
);

/**
 * AI 识图结果编辑/展示模式。
 * AI 渠道返回整段文本无坐标也无真实置信度（伪 OcrLine rate 恒为 1），
 * 故右侧改用可编辑的整段文本呈现，并支持两种模式按需切换：
 * - aiEditMode：false=展示（行列表，无置信度，单击复制该行）；
 *               true=编辑（textarea 双向绑定 aiText，复制全部以编辑后为准）。
 * - aiText：可编辑的整段识别文本，识别成功时回填。
 * - aiDisplayLines：展示模式按行拆分（去掉末尾多余换行避免出现空行）。
 * 切渠道 / 换图时随 resetTextResult 一并重置。
 */
const aiEditMode = ref(false);
const aiText = ref("");
const aiDisplayLines = computed(() => {
  const t = aiText.value;
  if (!t) return [];
  // 去掉末尾连续换行后再拆行，避免列表尾部出现可点击的空行。
  return t.replace(/(\r?\n)+$/, "").split(/\r?\n/);
});

/**
 * 识别并翻译联动门控：translateAfterOcr 下首次文字识别成功才上抛一次 translate，
 * 切回本 tab 对同一图重识别不二次跳翻译；换新图经 resetResults 重置后可再次联动。
 */
const translateFired = ref(false);

// 公式识别结果
const latexLoading = ref(false);
const latexError = ref("");
const latex = ref("");
const latexDone = ref(false);

// 表格识别结果（AI 专属模式，存 Markdown 表格源码，供预览解析与复制）
const tableLoading = ref(false);
const tableError = ref("");
const tableMarkdown = ref("");
const tableDone = ref(false);

const loading = computed(() =>
  mode.value === "text"
    ? ocrLoading.value
    : mode.value === "formula"
      ? latexLoading.value
      : tableLoading.value,
);
const errorText = computed(() =>
  mode.value === "text"
    ? ocrError.value
    : mode.value === "formula"
      ? latexError.value
      : tableError.value,
);

// 文字模式：列表↔图上高亮联动的当前悬停索引（-1 表示无）
const hoveredIndex = ref(-1);
function onViewerHover(i: number) {
  hoveredIndex.value = i;
}

// 把 File 读成 data URL
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function pickImage() {
  fileInput.value?.click();
}

async function setImageFromFile(file: File) {
  if (!file.type.startsWith("image/")) {
    error("请选择图片文件");
    return;
  }
  const dataUrl = await readFileAsDataURL(file);
  setImage(dataUrl);
  autoRecognize();
}

/**
 * 设置新图片：清空两种模式的结果与 done 标记。
 * data URI / http(s) URL 直接展示；本地 path 经 preload 转 data URI 后展示。
 */
function setImage(src: string) {
  recognizeSrc.value = src;
  if (/^data:/i.test(src) || /^https?:\/\//i.test(src)) {
    imageSrc.value = src;
  } else {
    try {
      imageSrc.value = window.services.readFileAsDataURL(src);
    } catch {
      imageSrc.value = "";
    }
  }
  resetResults();
}

/**
 * 设置图片 / 切换模式后自动识别当前模式。
 * - 引擎未就绪时静默跳过（由引擎引导卡引导下载，就绪后由 watcher 补识别）。
 * - 当前模式若已识别过（*Done 为 true）则复用缓存结果，避免对同一张图片重复识别。
 */
function autoRecognize() {
  if (!recognizeSrc.value || !engineReady.value) return;
  if (mode.value === "text" && ocrDone.value) return;
  if (mode.value === "formula" && latexDone.value) return;
  if (mode.value === "table" && tableDone.value) return;
  nextTick(() => recognize());
}

/** 截图识别：调系统截图，截完设为图片并自动识别当前模式。 */
function captureScreen() {
  window.ztools.screenCapture((imgBase64: string) => {
    if (!imgBase64) return; // 用户取消截屏：留在本页，可手动操作
    const dataUri = imgBase64.startsWith("data:")
      ? imgBase64
      : "data:image/png;base64," + imgBase64;
    setImage(dataUri);
    autoRecognize();
  });
}

/**
 * 自动截图流程（screen-ocr / screen-latex 入口）专用标志与触发器。
 * autoCaptureDone：标记本次进入的自动截图已触发过，防止引擎就绪态抖动
 *   （ready→checking→ready）反复弹出截图框；用户取消截图后也不再自动重弹，
 *   可手动点「截图识别」按钮重试。
 */
const autoCaptureDone = ref(false);

/**
 * 进入即自动截图：仅当 autoCapture 开启、尚未触发、当前模式引擎已就绪时调一次截图。
 * 引擎未就绪时跳过，由 nativeReady/latexReady watcher 在下载完成后补触发。
 */
function maybeAutoCapture() {
  if (!props.autoCapture || autoCaptureDone.value) return;
  if (!engineReady.value) return;
  autoCaptureDone.value = true;
  captureScreen();
}

/** 清空文字模式结果（切渠道 / 换图时调用）。 */
function resetTextResult() {
  ocrLines.value = [];
  ocrError.value = "";
  ocrDone.value = false;
  translateFired.value = false;
  aiEditMode.value = false;
  aiText.value = "";
  paraText.value = "";
}
/** 清空公式模式结果（切渠道 / 换图时调用）。 */
function resetFormulaResult() {
  latex.value = "";
  latexError.value = "";
  latexDone.value = false;
}
/** 清空表格模式结果（换图时调用）。 */
function resetTableResult() {
  tableMarkdown.value = "";
  tableError.value = "";
  tableDone.value = false;
}
/** 清空所有模式的结果与 done 标记（换新图时调用）。 */
function resetResults() {
  resetTextResult();
  resetFormulaResult();
  resetTableResult();
}

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  await setImageFromFile(file);
  target.value = "";
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) setImageFromFile(file);
}
function onDragOver() {
  dragOver.value = true;
}
function onDragLeave() {
  dragOver.value = false;
}

async function onPaste(e: ClipboardEvent) {
  const item = Array.from(e.clipboardData?.items || []).find((i) =>
    i.type.startsWith("image/"),
  );
  const file = item?.getAsFile();
  if (file) await setImageFromFile(file);
}

// ─── 识别执行 ────────────────────────────────────────────────────────
/**
 * 文字识别成功后的统一处理：填 ocrLines、提示、上抛历史与联动翻译。
 * 微信 OCR 渠道传入带坐标的真实 lines；AI 渠道传入按文本拆出的伪 lines（无坐标）。
 */
function applyOcrLines(lines: OcrLine[]) {
  ocrLines.value = lines;
  if (lines.length === 0) {
    error("未识别到文字");
    // 空结果不上抛 text-result，避免清空翻译框
    return;
  }
  // 聚合开启：按段落聚合回填 paraText（段落视图回显 + 复制 / 翻译共用）。
  // 仅微信 OCR 渠道需要——AI 渠道的文本走可编辑的 aiText，无需回填。
  if (settings.ocrMergeParagraphs && textProvider.value !== "ai-ocr") {
    const paras = aggregateOcrParagraphs(lines);
    paraText.value = paras.join("\n");
    success(`识别完成，共 ${paras.length} 段`);
  } else {
    success(`识别完成，共 ${lines.length} 行`);
  }
  // 同步当前识别文本给父组件：供用户手动切到翻译 tab 时带入翻译输入框。
  // 取 assembledOcrText（AI 渠道 = 可编辑的 aiText；微信 OCR 渠道按设置聚合段落）。
  const text = assembledOcrText.value;
  emit("text-result", text);
  // 上抛历史记录：只有真正调识别服务成功才留一笔（命中缓存不会进此分支）
  emit("history", {
    kind: "ocr-text",
    thumbnail: imageSrc.value,
    title: lines[0]?.text ? lines[0].text.slice(0, 40) : "（未识别到文字）",
    payload: {
      kind: "ocr-text",
      imageSrc: imageSrc.value,
      lines: lines.map((l) => ({ ...l })),
    },
  });
  // 识别并翻译联动：translateAfterOcr 下首次成功才上抛一次（门控 translateFired），
  // 父组件切到「翻译」tab 预填识别文字并触发翻译。换新图重置门控后可再次联动。
  if (props.translateAfterOcr && !translateFired.value) {
    translateFired.value = true;
    emit("translate", text);
  }
}

async function recognizeText() {
  if (!recognizeSrc.value) return;
  // AI 渠道不依赖本机引擎；微信 OCR 渠道需引擎就绪。
  if (textProvider.value === "ocr" && !nativeReady.value) return;
  // 并发保护：onMounted 的 checkNative 会让 ready 态瞬时抖动（ready→checking→ready），
  // 从而二次触发引擎就绪 watcher；此处避免对同一图片并发识别。
  if (ocrLoading.value) return;
  ocrLoading.value = true;
  ocrError.value = "";
  ocrLines.value = [];
  try {
    if (textProvider.value === "ai-ocr") {
      // AI 识图：返回整段文本，按行拆成伪 OcrLine（无坐标），复用列表/复制/联动逻辑。
      // 同时回填 aiText 供右侧编辑/展示模式使用（rate 恒为 1 不展示置信度）。
      const out = await window.services.ocrAi(recognizeSrc.value);
      const text = (out && out.text) || "";
      aiText.value = text;
      applyOcrLines(
        text
          ? text.split(/\r?\n/).map((t) => ({
              text: t,
              rate: 1,
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
              boxPoints: [] as OcrLine["boxPoints"],
            }))
          : [],
      );
    } else {
      const result = await window.services.ocrImageDetail(recognizeSrc.value);
      if (result.ok) applyOcrLines(result.lines ?? []);
      else {
        ocrError.value = result.error || "识别失败";
        error(ocrError.value);
      }
    }
  } catch (err: any) {
    ocrError.value = err?.message ? String(err.message) : String(err);
    error(ocrError.value);
  } finally {
    ocrDone.value = true;
    ocrLoading.value = false;
  }
}

/**
 * 公式识别成功后的统一处理：填 latex、提示、上抛历史记录。
 * 本地引擎与 AI 渠道结果同为 LaTeX 源码，处理一致。
 */
function applyLatexResult(ltx: string) {
  latex.value = ltx;
  if (!ltx) {
    error("未识别到公式");
    return;
  }
  success("公式识别完成");
  // 上抛历史记录：只有真正调识别服务成功才留一笔（命中缓存不会进此分支）
  emit("history", {
    kind: "ocr-formula",
    thumbnail: imageSrc.value,
    title: ltx.slice(0, 40),
    payload: {
      kind: "ocr-formula",
      imageSrc: imageSrc.value,
      latex: ltx,
    },
  });
}

async function recognizeFormula() {
  if (!recognizeSrc.value) return;
  // AI 渠道不依赖本机引擎；本地引擎需就绪。
  if (formulaProvider.value === "latex" && !latexReady.value) return;
  // 并发保护：与 recognizeText 同理，防止引擎就绪态抖动引发的重复识别。
  if (latexLoading.value) return;
  latexLoading.value = true;
  latexError.value = "";
  latex.value = "";
  try {
    if (formulaProvider.value === "ai-latex-ocr") {
      const out = await window.services.latexAi(recognizeSrc.value);
      applyLatexResult(out.latex || "");
    } else {
      const result = await window.services.latexRecognizeDetail(
        recognizeSrc.value,
      );
      if (result.ok) applyLatexResult(result.latex || "");
      else {
        latexError.value = result.error || "识别失败";
        error(latexError.value);
      }
    }
  } catch (err: any) {
    latexError.value = err?.message ? String(err.message) : String(err);
    error(latexError.value);
  } finally {
    latexDone.value = true;
    latexLoading.value = false;
  }
}

/**
 * 表格识别成功后的统一处理：回填 Markdown 源码、提示、上抛历史记录。
 * AI 渠道直接传返回的 Markdown；本机引擎渠道先把聚类恢复的 table / row / cell
 * 序列化为 Markdown 再传入——两渠道共用预览 / 复制链路。
 * @param md        Markdown 表格源码（空串按「未识别到表格」处理）。
 * @param successMsg 成功提示文案（本机渠道带行列规模，AI 渠道用默认）。
 */
function applyTableResult(md: string, successMsg = "表格识别完成") {
  tableMarkdown.value = md;
  if (!md) {
    error("未识别到表格");
    return;
  }
  success(successMsg);
  // 历史标题取首个非空单元格（表头优先），便于在列表中区分不同表格
  const t = parseMarkdownTable(md);
  const firstCell = t ? (t.headers[0] || t.rows[0]?.[0] || "") : md;
  // 上抛历史记录：只有真正调识别服务成功才留一笔（命中缓存不会进此分支）
  emit("history", {
    kind: "ocr-table",
    thumbnail: imageSrc.value,
    title: String(firstCell).slice(0, 40) || "（未识别到表格）",
    payload: {
      kind: "ocr-table",
      imageSrc: imageSrc.value,
      markdown: md,
    },
  });
}

/**
 * 本机引擎（微信 OCR）表格识别的统一处理：识别行经 ocrTable 几何聚类恢复
 * table / row / cell，未检出表格结构（纯文本页 / 无坐标伪行）时按空结果处理。
 * 恢复结果序列化为 Markdown 后走 applyTableResult，与 AI 渠道共用展示与复制。
 */
function applyLocalTableResult(lines: OcrLine[]) {
  const split = splitOcrRegions(lines);
  const tables = split?.tables ?? [];
  if (!tables.length) {
    applyTableResult("");
    return;
  }
  const md = tables.map((t) => buildMarkdownTable(t.headers, t.rows)).join("\n\n");
  const first = tables[0];
  const detail =
    tables.length > 1
      ? `表格识别完成，检出 ${tables.length} 张（首张 ${first.rows.length + 1} 行 × ${first.colCount} 列）`
      : `表格识别完成，共 ${first.rows.length + 1} 行 × ${first.colCount} 列`;
  applyTableResult(md, detail);
}

async function recognizeTable() {
  if (!recognizeSrc.value) return;
  // AI 渠道需已配置视觉模型；本机渠道需微信 OCR 引擎就绪（未就绪静默跳过，
  // 由引擎引导卡引导下载，就绪后由 nativeReady watcher 补识别）
  if (aiEnabled.value) {
    if (!aiModelConfigured.value) return;
  } else if (!nativeReady.value) {
    return;
  }
  // 并发保护：与 recognizeText 同理，防止引擎就绪态抖动引发的重复识别。
  if (tableLoading.value) return;
  tableLoading.value = true;
  tableError.value = "";
  tableMarkdown.value = "";
  try {
    if (aiEnabled.value) {
      const out = await window.services.tableAi(recognizeSrc.value);
      applyTableResult((out && out.table) || "");
    } else {
      // 本机渠道：微信 OCR 返回带坐标的行，几何聚类恢复表格结构
      const result = await window.services.ocrImageDetail(recognizeSrc.value);
      if (result.ok) applyLocalTableResult(result.lines ?? []);
      else {
        tableError.value = result.error || "识别失败";
        error(tableError.value);
      }
    }
  } catch (err: any) {
    tableError.value = err?.message ? String(err.message) : String(err);
    error(tableError.value);
  } finally {
    tableDone.value = true;
    tableLoading.value = false;
  }
}

/** 统一的「识别」入口：按当前模式派发；已识别过则重新识别（覆盖结果）。 */
async function recognize() {
  if (mode.value === "text") await recognizeText();
  else if (mode.value === "formula") await recognizeFormula();
  else await recognizeTable();
}

// ─── 复制 ────────────────────────────────────────────────────────────
function copyLine(text: string) {
  window.ztools.copyText(text);
  success("已复制该行");
}

function copyAllText() {
  // AI 渠道复制编辑后的整段文本；微信 OCR 渠道按设置装配（聚合段落 / 逐行）
  const text = assembledOcrText.value;
  if (!text) return;
  window.ztools.copyText(text);
  success("已复制全部文字");
}

function copyLatex(kind: "raw" | "inline" | "display") {
  if (!latex.value) return;
  let text = latex.value;
  if (kind === "inline") text = "$" + latex.value + "$";
  else if (kind === "display") text = "$$" + latex.value + "$$";
  window.ztools.copyText(text);
  success(
    kind === "raw"
      ? "已复制 LaTeX 源码"
      : kind === "inline"
        ? "已复制 $…$ 形式"
        : "已复制 $$…$$ 形式",
  );
}

// ─── 表格结果：预览数据与复制 ────────────────────────────────────────
// 表格预览：将识别得到的 Markdown 源码解析为表头 / 行列结构供渲染。
const parsedTable = computed(() => parseMarkdownTable(tableMarkdown.value));

/** 表格列对齐样式（来自分隔行的 :---: 标记，未标注用默认左对齐）。 */
function alignStyle(i: number): Record<string, string> {
  const a = parsedTable.value?.aligns[i];
  return a ? { textAlign: a } : {};
}

/** 复制表格：TSV（粘贴进 Excel / WPS）/ Markdown 源码 / HTML；AI 与本机渠道共用。 */
function copyTable(kind: "tsv" | "markdown" | "html") {
  if (!tableMarkdown.value) return;
  let text = tableMarkdown.value;
  if (kind === "tsv") text = markdownTableToTsv(tableMarkdown.value);
  else if (kind === "html") text = markdownTableToHtml(tableMarkdown.value);
  if (!text) return;
  window.ztools.copyText(text);
  success(
    kind === "markdown"
      ? "已复制 Markdown"
      : kind === "tsv"
        ? "已复制表格（TSV），可粘贴进表格软件"
        : "已复制 HTML",
  );
}

// ─── KaTeX 渲染 ─────────────────────────────────────────────────────
// 用 computed + v-html：切换模式导致预览 div 重新挂载时，Vue 会自动按当前
// 缓存的 latex 重新写入 innerHTML，无需依赖 latex 值变化触发 watcher
// （切走再切回时 latex 不变，watch 不会触发，纯手动 innerHTML 会留下空 div）。
const latexHtml = computed(() => {
  const val = latex.value;
  if (!val) return "";
  try {
    return katex.renderToString(val, {
      displayMode: true,
      throwOnError: false,
      output: "html",
    });
  } catch (e: any) {
    return (
      '<span class="katex-error">渲染失败：' +
      (e?.message || String(e)) +
      "</span>"
    );
  }
});

// ─── 外部 initialImage 自动识别 ──────────────────────────────────────
// 引擎未就绪时仅载入图片（不识别），就绪后由下方 watcher 按当前模式补识别。
async function applyInitial(image: string, targetMode: "text" | "formula" | "table") {
  if (!image) return;
  mode.value = targetMode;
  setImage(image);
  autoRecognize();
}

watch(
  () => props.initialImage,
  (image) => {
    if (image) applyInitial(image, props.initialMode);
  },
  { immediate: true },
);

// 文字 / 表格引擎（微信 OCR，同一引擎）就绪后补识别：覆盖「下载期间选图」与
// 「切到该模式时引擎仍在下载」两种场景。另覆盖 autoCapture（screen-ocr / screen-latex
// 入口）：引擎未就绪时截图被搁置，就绪后自动补截图。
// AI 渠道不依赖本机引擎（engineReady 恒就绪），由 setup 期 autoRecognize 直接触发；
// 此 watcher 跳过 AI 渠道，避免引擎下载完成时对 AI 渠道误触发重识别。
watch(nativeReady, (ready) => {
  if (!ready || aiEnabled.value) return;
  const pending =
    (mode.value === "text" && !ocrDone.value) ||
    (mode.value === "table" && !tableDone.value);
  if (recognizeSrc.value && pending) {
    nextTick(() => recognize());
  } else if (props.autoCapture && !autoCaptureDone.value) {
    maybeAutoCapture();
  }
});

// 公式引擎就绪后补识别：与文字引擎对称，含 autoCapture（screen-latex 入口）补截图。
// AI 渠道同理跳过。
watch(latexReady, (ready) => {
  if (!ready || mode.value !== "formula" || aiEnabled.value) return;
  if (recognizeSrc.value && !latexDone.value) {
    nextTick(() => recognizeFormula());
  } else if (props.autoCapture && !autoCaptureDone.value) {
    maybeAutoCapture();
  }
});

// AI 开关切换：三种模式的渠道同时变化，结果全部重置，并对当前模式立即重识别
// （表格模式本机渠道 = 微信 OCR + 几何聚类，AI 渠道 = 视觉模型输出 Markdown）。
// 已有图片但引擎未就绪（关闭 AI 后本机引擎未下载）时跳过，就绪后由上方 watcher 补识别。
watch(aiEnabled, () => {
  resetTextResult();
  resetFormulaResult();
  resetTableResult();
  if (recognizeSrc.value && engineReady.value) {
    nextTick(() => recognize());
  }
});

// 聚合段落开关切换：识别结果已在手时即时重建段落文本，
// 覆盖「识别时开关关闭、中途打开」的场景（关闭方向无需处理，逐行输出现算）。
watch(
  () => settings.ocrMergeParagraphs,
  (on) => {
    if (on && textProvider.value !== "ai-ocr" && ocrLines.value.length) {
      paraText.value = assembleOcrText(ocrLines.value, true);
    }
  },
);

onMounted(() => {
  window.addEventListener("paste", onPaste);
  checkNative();
  checkLatex();
  // 截图识别 feature（screen-ocr / screen-latex）进入即自动截屏：
  // 引擎已就绪则立即截图，否则由上方 nativeReady/latexReady watcher 在就绪后触发。
  maybeAutoCapture();
});

// keep-alive 缓存后切 tab 触发 onActivated/onDeactivated（而非重新挂载）：
//   - activated：重绑 paste 监听（deactivated 时已移除）、重新 check 引擎状态
//     （长时间切走后 ready 可能已过期），不再重复触发自动截图（autoCaptureDone
//     在缓存实例中保留为 true，未触发过的由引擎就绪 watcher 补截图）。
//   - deactivated：暂停 paste 监听，避免非可见时仍响应剪贴板。
onActivated(() => {
  window.addEventListener("paste", onPaste);
  checkNative();
  checkLatex();
  // 重读 AI 渠道配置状态（用户可能在「渠道」页改了模型），与 Translate onMounted 一致。
  refreshProviderStatus();
});

onDeactivated(() => {
  window.removeEventListener("paste", onPaste);
});

onUnmounted(() => {
  window.removeEventListener("paste", onPaste);
  window.services.ocrDispose();
  window.services.latexDispose();
});
</script>

<template>
  <div class="recognize">
    <!-- 主体：左右结构 -->
    <div
      class="stage"
      :class="{ 'drag-over': dragOver }"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
    >
      <!-- 左：图片预览 + 底部操作按钮 -->
      <div class="pane pane-image">
        <div class="image-canvas">
          <OcrImageViewer
            v-if="mode === 'text'"
            :image-src="imageSrc"
            :lines="viewerLines"
            :loading="ocrLoading"
            :hide-result="true"
            empty-text="选择图片或截图识别，也可拖入 / 粘贴图片"
            @copy="copyLine"
            @hover="onViewerHover"
          />
          <template v-else>
            <img
              v-if="imageSrc"
              :src="imageSrc"
              alt="公式图片"
              class="formula-img"
            />
            <div v-else class="empty">
              <div class="empty-icon">🖼️</div>
              <div class="empty-text">
                选择图片或截图识别，也可拖入 / 粘贴图片
              </div>
            </div>
            <div
              v-if="latexLoading || tableLoading"
              class="loading-overlay"
            >识别中…</div>
          </template>
        </div>

        <!-- 底部操作：选择图片（左）· 截图识别（右） -->
        <div class="image-actions">
          <ZButton size="small" type="text" @click="pickImage">
            <template #icon>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
              >
                <!-- Icon from Material Symbols by Google - https://github.com/google/material-design-icons/blob/master/LICENSE -->
                <path
                  fill="currentColor"
                  d="M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21zm0-2h14V5H5zm0 0V5zm2-2h10q.3 0 .45-.275t-.05-.525l-2.75-3.675q-.15-.2-.4-.2t-.4.2L11.25 16L9.4 13.525q-.15-.2-.4-.2t-.4.2l-2 2.675q-.2.25-.05.525T7 17m2.563-7.438Q10 9.125 10 8.5t-.437-1.062T8.5 7t-1.062.438T7 8.5t.438 1.063T8.5 10t1.063-.437"
                />
              </svg>
            </template>
            选择图片
          </ZButton>
          <ZButton size="small" type="text" @click="captureScreen">
            <template #icon>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
              >
                <!-- Icon from Material Design Icons by Pictogrammers - https://github.com/Templarian/MaterialDesign/blob/master/LICENSE -->
                <path
                  fill="currentColor"
                  d="M7 17V1H5v4H1v2h4v10a2 2 0 0 0 2 2h10v4h2v-4h4v-2m-6-2h2V7a2 2 0 0 0-2-2H9v2h8z"
                />
              </svg>
            </template>
            截图识别
          </ZButton>
        </div>
      </div>

      <!-- 右：结果面板 -->
      <div class="pane pane-result">
        <!-- 顶部操作条：左侧三模式切换（文字 / 公式 / 表格）+ 右侧独立 AI 开关 -->
        <div class="mode-bar" :class="{ dark: isDark }">
          <!-- 模式切换：滑动高亮分段控件 -->
          <div
            class="mode-switch"
            role="tablist"
            aria-label="识别模式"
            ref="modeSwitchRef"
          >
            <!-- 滑动高亮指示条：吸附到当前模式按钮 -->
            <span
              class="mode-indicator"
              :class="{ 'no-anim': modeNoAnim }"
              :style="{
                transform: `translateX(${modeIndicator.x}px)`,
                width: modeIndicator.w ? `${modeIndicator.w}px` : '0px'
              }"
            ></span>
            <button
              type="button"
              role="tab"
              class="mode-btn"
              :class="{ active: mode === 'text' }"
              :aria-selected="mode === 'text'"
              :ref="(el) => setModeItemRef(el, 0)"
              @click="switchMode('text')"
            >
              <svg
                class="mode-icon"
                xmlns="http://www.w3.org/2000/svg"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
              <span class="mode-label">文字</span>
            </button>
            <button
              type="button"
              role="tab"
              class="mode-btn"
              :class="{ active: mode === 'formula' }"
              :aria-selected="mode === 'formula'"
              :ref="(el) => setModeItemRef(el, 1)"
              @click="switchMode('formula')"
            >
              <svg
                class="mode-icon"
                xmlns="http://www.w3.org/2000/svg"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <!-- Σ 求和符号：公式识别 -->
                <path d="M17 5H7l6 7-6 7h10" />
              </svg>
              <span class="mode-label">公式</span>
            </button>
            <button
              type="button"
              role="tab"
              class="mode-btn"
              :class="{ active: mode === 'table' }"
              :aria-selected="mode === 'table'"
              :ref="(el) => setModeItemRef(el, 2)"
              @click="switchMode('table')"
            >
              <svg
                class="mode-icon"
                xmlns="http://www.w3.org/2000/svg"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <!-- 网格：表格识别 -->
                <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                <path d="M3.5 9.5h17M9.5 9.5V19.5M15.5 9.5V19.5" />
              </svg>
              <span class="mode-label">表格</span>
            </button>
          </div>

          <!-- AI 渠道开关：独立于模式选择。开启后走 AI 视觉模型（表格识别输出
               Markdown）；关闭用本机引擎（表格识别 = 微信 OCR + 几何聚类）；
               未配置模型时置灰并提示。 -->
          <button
            type="button"
            class="ai-toggle"
            :class="{
              active: aiEnabled,
              disabled: !aiEnabled && !aiModelConfigured,
            }"
            :title="aiToggleTitle"
            :aria-pressed="aiEnabled"
            @click="toggleAi"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <!-- Icon from Material Symbols (auto_awesome / sparkle) - https://github.com/google/material-design-icons/blob/master/LICENSE -->
              <path
                fill="currentColor"
                d="m19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"
              />
            </svg>
            <span>AI</span>
          </button>
        </div>

        <!-- 引擎未就绪引导（按当前模式与渠道） -->
        <div v-if="!engineReady" class="engine-guide">
          <EngineStatusCard
            v-if="mode !== 'table' || !aiEnabled"
            :show-actions="false"
            style="width: 100%;height: 100%;justify-content: center;"
            :engine-kind="mode === 'formula' ? 'latex' : 'wechat'"
            @downloaded="mode === 'formula' ? checkLatex() : checkNative()"
          />
          <!-- 表格模式 AI 渠道：就绪 = 已配置 AI 视觉模型 -->
          <div v-else class="ai-guide">
            <div class="ai-guide-icon">✨</div>
            <div class="ai-guide-text">
              表格识别由 AI 视觉模型完成，请先在「渠道」页「AI
              识别」中选择支持视觉的模型
            </div>
          </div>
        </div>

        <!-- 结果区 -->
        <template v-else>
          <!-- 文字模式结果 -->
          <div v-if="mode === 'text'" class="result-body">
            <div v-if="ocrLoading" class="result-empty">识别中…</div>
            <div v-else-if="ocrError" class="result-empty error">
              {{ ocrError }}
            </div>
            <div
              v-else-if="ocrDone && ocrLines.length === 0"
              class="result-empty"
            >
              未识别到文字
            </div>
            <div v-else-if="!ocrDone" class="result-empty placeholder">
              选择图片或截图后自动识别，结果将在此显示
            </div>
            <template v-else>
              <!-- 微信 OCR · 聚合开启：按段落回显（textarea 形式，可编辑），不展示行级置信度 -->
              <div
                v-if="textProvider !== 'ai-ocr' && settings.ocrMergeParagraphs"
                class="ocr-result"
                :class="{ dark: isDark }"
              >
                <div class="result-head">
                  <span class="result-title"
                    >识别结果（{{ paraCount }} 段）</span
                  >
                  <ZButton size="small" @click="copyAllText">复制全部</ZButton>
                </div>
                <textarea
                  class="para-view"
                  v-model="paraText"
                  spellcheck="false"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="off"
                ></textarea>
              </div>
              <!-- 微信 OCR · 聚合关闭：带置信度的行列表，与图上文字双向高亮联动 -->
              <template v-else-if="textProvider !== 'ai-ocr'">
                <div class="result-head">
                  <span class="result-title"
                    >识别明细（{{ ocrLines.length }} 行）</span
                  >
                  <ZButton size="small" @click="copyAllText">复制全部</ZButton>
                </div>
                <div class="line-list">
                  <div
                    v-for="(line, i) in ocrLines"
                    :key="i"
                    class="result-line"
                    :class="{ active: hoveredIndex === i }"
                    @mouseenter="hoveredIndex = i"
                    @mouseleave="hoveredIndex = -1"
                    @click="copyLine(line.text)"
                  >
                    <span class="result-rate"
                      >{{ (line.rate * 100).toFixed(0) }}%</span
                    >
                    <span class="result-text">{{ line.text }}</span>
                  </div>
                </div>
              </template>
              <!-- AI 识图：不展示置信度，提供展示/编辑模式图标切换 -->
              <div v-else class="ai-result" :class="{ dark: isDark }">
                <div class="result-head">
                  <span class="result-title"
                    >识别结果（{{ aiDisplayLines.length }} 行）</span
                  >
                  <div class="result-head-actions">
                    <!-- 展示模式（eye）· 编辑模式（pencil）图标切换组 -->
                    <div
                      class="mode-toggle"
                      role="group"
                      aria-label="结果模式"
                    >
                      <button
                        type="button"
                        class="mode-toggle-btn"
                        :class="{ active: !aiEditMode }"
                        title="展示模式"
                        aria-label="展示模式"
                        @click="aiEditMode = false"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <!-- Icon from Material Symbols (visibility) - https://github.com/google/material-design-icons/blob/master/LICENSE -->
                          <path
                            fill="currentColor"
                            d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="mode-toggle-btn"
                        :class="{ active: aiEditMode }"
                        title="编辑模式"
                        aria-label="编辑模式"
                        @click="aiEditMode = true"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <!-- Icon from Material Symbols (edit) - https://github.com/google/material-design-icons/blob/master/LICENSE -->
                          <path
                            fill="currentColor"
                            d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
                          />
                        </svg>
                      </button>
                    </div>
                    <ZButton size="small" @click="copyAllText"
                      >复制全部</ZButton
                    >
                  </div>
                </div>
                <!-- 展示模式：行列表（无置信度），单击复制该行 -->
                <div v-if="!aiEditMode" class="line-list">
                  <div
                    v-for="(line, i) in aiDisplayLines"
                    :key="i"
                    class="result-line"
                    @click="copyLine(line)"
                  >
                    <span class="result-text">{{ line }}</span>
                  </div>
                </div>
                <!-- 编辑模式：可编辑整段文本，复制全部以编辑后为准 -->
                <textarea
                  v-else
                  class="ai-text-edit"
                  v-model="aiText"
                  spellcheck="false"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="off"
                  placeholder="可编辑识别结果，切换到展示模式查看行列表"
                ></textarea>
              </div>
            </template>
          </div>

          <!-- 公式模式结果 -->
          <div v-else-if="mode === 'formula'" class="result-body">
            <div v-if="latexLoading" class="result-empty">识别中…</div>
            <div v-else-if="latexError" class="result-empty error">
              {{ latexError }}
            </div>
            <div v-else-if="latexDone && !latex" class="result-empty">
              未识别到公式
            </div>
            <div v-else-if="!latexDone" class="result-empty placeholder">
              选择图片或截图后自动识别，结果将在此显示
            </div>
            <template v-else>
              <div class="formula-layout" :class="{ dark: isDark }">
                <!-- 上半：渲染预览（随下方源码实时渲染） -->
                <div class="result-section formula-half">
                  <div class="section-title">渲染预览</div>
                  <div class="katex-preview" v-html="latexHtml"></div>
                </div>
                <!-- 下半：LaTeX 源码，可编辑 -->
                <div class="result-section formula-half">
                  <div class="section-title">LaTeX 源码</div>
                  <textarea
                    class="latex-source"
                    v-model="latex"
                    spellcheck="false"
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                    placeholder="可编辑 LaTeX 源码，上方预览实时渲染"
                  ></textarea>
                </div>
              </div>
              <div class="copy-actions">
                <ZButton @click="copyLatex('raw')">复制源码</ZButton>
                <ZButton @click="copyLatex('inline')">复制 $…$</ZButton>
                <ZButton @click="copyLatex('display')">复制 $$…$$</ZButton>
              </div>
            </template>
          </div>

          <!-- 表格模式结果：Markdown 表格预览 + 三种复制形式 -->
          <div v-else class="result-body">
            <div v-if="tableLoading" class="result-empty">识别中…</div>
            <div v-else-if="tableError" class="result-empty error">
              {{ tableError }}
            </div>
            <div v-else-if="tableDone && !tableMarkdown" class="result-empty">
              未识别到表格
            </div>
            <div v-else-if="!tableDone" class="result-empty placeholder">
              选择图片或截图后自动识别，结果将在此显示
            </div>
            <template v-else>
              <div class="table-layout" :class="{ dark: isDark }">
                <!-- 表格预览（随识别结果实时解析渲染） -->
                <div class="result-section table-half">
                  <div class="section-title">表格预览</div>
                  <div class="table-preview">
                    <table v-if="parsedTable" class="md-table">
                      <thead>
                        <tr>
                          <th
                            v-for="(h, i) in parsedTable.headers"
                            :key="'h' + i"
                            :style="alignStyle(i)"
                          >
                            {{ h }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="(r, ri) in parsedTable.rows"
                          :key="'r' + ri"
                        >
                          <td
                            v-for="(c, ci) in r"
                            :key="ci"
                            :style="alignStyle(ci)"
                          >
                            {{ c }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <div v-else class="table-fallback">
                      暂无法解析为表格
                    </div>
                  </div>
                </div>
              </div>
              <div class="copy-actions">
                <ZButton @click="copyTable('tsv')">复制为表格</ZButton>
                <ZButton @click="copyTable('markdown')">复制为 md</ZButton>
                <ZButton @click="copyTable('html')">复制 HTML</ZButton>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>

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
.recognize {
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
  height: 100%;
}

/* ── 主体左右结构 ── */
.stage {
  flex: 1;
  display: flex;
  gap: 14px;
  min-height: 0;
  /* 底部留白由 SettingLayout 内容区统一预留，这里不再重复 */
  padding: 14px 14px 0;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.stage.drag-over {
  border-color: var(--primary-color, #1976d2);
  background: var(--hover-bg, rgba(25, 118, 210, 0.05));
}

/* 左：图片预览 + 底部操作 */
.pane-image {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 200px;
  position: relative;
}

.image-canvas {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  overflow: hidden;
  min-height: 0;
}

.formula-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-size: 14px;
  border-radius: 8px;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px 0;
}

.empty-icon {
  font-size: 40px;
  opacity: 0.6;
}

.empty-text {
  font-size: 13px;
  color: var(--text-secondary, #999);
  text-align: center;
}

/* 底部操作按钮：选择图片（左对齐）· 截图识别（右对齐） */
.image-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  position: absolute;
  top: 0;
  width: 100%;

  .zt-button {
    height: 34.8px;
    color: #666666;
  }
}

/* 右：结果面板 */
.pane-result {
  flex: 1 1 50%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0;
  background: var(--pane-bg, transparent);
  overflow: hidden;
}

/* 顶部操作条：左侧模式切换（撑满）+ 右侧独立 AI 开关 */
.mode-bar {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

/* 模式切换：占满剩余宽度 */
.mode-switch {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--sub-bar-bg, rgba(0, 0, 0, 0.05));
  border-radius: 9px;
}

/* 滑动高亮指示条：吸附到当前模式按钮，背景即原 active 底色 */
.mode-indicator {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 0;
  border-radius: 7px;
  background: var(--sub-item-active-bg, #fff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  pointer-events: none;
  z-index: 0;
  transition:
    transform 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    width 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}

.mode-indicator.no-anim {
  transition: none;
}

/* scoped 下 :global 失效，改用 .dark 类驱动暗色高亮（不刺眼）。
   dark 类挂在 .mode-bar 上，指示条 / AI 开关均为其后代。 */
.mode-bar.dark .mode-indicator {
  background: var(--sub-item-active-bg, rgba(255, 255, 255, 0.08));
  box-shadow: none;
}

.mode-btn {
  flex: 1;
  /* 图标与文字横向居中排列 */
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 14px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1.4;
  border-radius: 7px;
  cursor: pointer;
  font-family: inherit;
  /* 置于指示条之上，使文字始终清晰 */
  position: relative;
  z-index: 1;
  transition: color 0.15s;
  white-space: nowrap;
}

.mode-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

/* 激活态：仅着色 + 加粗，背景由 .mode-indicator 滑动提供 */
.mode-btn.active {
  color: var(--primary-color, #1976d2);
  font-weight: 600;
}

/* AI 渠道开关：独立于模式选择的 pill 按钮（sparkle + AI 字样）。
   - active：AI 渠道启用时主色 + 浅色底；
   - 默认态：灰色，hover 主色描边；
   - disabled：未配置 AI 模型，置灰不可点。 */
.ai-toggle {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
  border: 1px solid transparent;
  background: var(--sub-bar-bg, rgba(0, 0, 0, 0.05));
  color: var(--text-secondary, #999);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  border-radius: 9px;
  cursor: pointer;
  font-family: inherit;
  transition:
    color 0.15s,
    background 0.15s,
    border-color 0.15s;
}

.ai-toggle:not(.active):not(.disabled):hover {
  color: var(--primary-color, #1976d2);
  border-color: color-mix(in srgb, var(--primary-color, #1976d2), transparent 60%);
}

.ai-toggle.active {
  color: var(--primary-color, #1976d2);
  background: color-mix(in srgb, var(--primary-color, #1976d2), transparent 85%);
}

.ai-toggle.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* scoped 下 :global 失效，用 .dark 类驱动暗色 hover 背景 */
.mode-bar.dark .ai-toggle:not(.active):not(.disabled):hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

/* 引擎引导 */
.engine-guide {
  flex: 1;
  overflow-y: auto;
}

/* 结果区 */
.result-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
}

.result-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--text-secondary, #999);
  font-size: 14px;
  text-align: center;
}

.result-empty.error {
  color: #e53935;
}

.result-empty.placeholder {
  opacity: 0.7;
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.result-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #666);
}

.line-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.result-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}

.result-line:hover,
.result-line.active {
  background: var(--hover-bg, rgba(0, 0, 0, 0.05));
}

.result-rate {
  color: var(--text-secondary, #999);
  font-size: 12px;
  min-width: 34px;
  flex-shrink: 0;
}

.result-text {
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}

/* AI 识图结果容器（展示/编辑模式） */
.ai-result {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.result-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 展示模式（eye，左）· 编辑模式（pencil，右）图标切换组 */
.mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--sub-bar-bg, rgba(0, 0, 0, 0.05));
  border-radius: 6px;
}

.mode-toggle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #999);
  border-radius: 5px;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s;
}

.mode-toggle-btn:hover {
  color: var(--primary-color, #1976d2);
}

.mode-toggle-btn.active {
  color: var(--primary-color, #1976d2);
  background: var(--sub-item-active-bg, #fff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

/* scoped 下 :global 失效，用 .dark 类驱动暗色切换组 */
.ai-result.dark .mode-toggle {
  background: var(--sub-bar-bg, rgba(255, 255, 255, 0.08));
}

.ai-result.dark .mode-toggle-btn.active {
  background: var(--sub-item-active-bg, rgba(255, 255, 255, 0.08));
  box-shadow: none;
}

/* 微信 OCR 聚合段落视图（textarea 形式回显，可编辑） */
.ocr-result {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.para-view {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 12px;
  background: var(--code-bg, #f5f5f5);
  border-radius: 8px;
  border: 1px solid var(--border-color, #e5e6eb);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.7;
  resize: none;
  color: var(--text-color, #333);
  outline: none;
}

/* scoped 下 :global 失效，用 .dark 类驱动暗色段落视图 */
.ocr-result.dark .para-view {
  background: var(--code-bg, #2a2a2a);
  color: var(--text-color, #f3f4f6);
  border-color: var(--border-color, #374151);
}

/* AI 展示模式行列表：撑满并内部滚动 */
.ai-result .line-list {
  flex: 1;
  min-height: 0;
}

/* 编辑模式：整段可编辑文本 */
.ai-text-edit {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 12px;
  background: var(--code-bg, #f5f5f5);
  border-radius: 8px;
  border: 1px solid var(--border-color, #e5e6eb);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  resize: none;
  color: var(--text-color, #333);
  outline: none;
}

/* scoped 下 :global 失效，用 .dark 类驱动暗色编辑框 */
.ai-result.dark .ai-text-edit {
  background: var(--code-bg, #2a2a2a);
  color: var(--text-color, #f3f4f6);
  border-color: var(--border-color, #374151);
}

/* 公式结果 */
.result-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 渲染预览与源码上下两半，各占一半高度撑满 */
.formula-layout {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.formula-half {
  flex: 1 1 0;
  min-height: 0;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #666);
}

.katex-preview {
  flex: 1 1 0;
  min-height: 0;
  padding: 16px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid var(--border-color, #e5e6eb);
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* scoped 下 :global 失效，用 .dark 类驱动暗色渲染预览 */
.formula-layout.dark .katex-preview {
  background: #2a2a2a;
  border-color: var(--border-color, #374151);
  color: var(--text-color, #f3f4f6);
}

.katex-error {
  color: #e53935;
  font-size: 13px;
}

.latex-source {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 12px;
  background: var(--code-bg, #f5f5f5);
  border-radius: 8px;
  border: 1px solid var(--border-color, #e5e6eb);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  resize: none;
  color: var(--text-color, #333);
  outline: none;
}

/* scoped 下 :global 失效，用 .dark 类驱动暗色 LaTeX 源码框 */
.formula-layout.dark .latex-source {
  background: var(--code-bg, #2a2a2a);
  color: var(--text-color, #f3f4f6);
  border-color: var(--border-color, #374151);
}

/* 表格结果：预览区独占撑满（dark 类驱动暗色预览） */
.table-layout {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.table-half {
  flex: 1 1 0;
  min-height: 0;
}

.table-preview {
  flex: 1 1 0;
  min-height: 0;
  padding: 8px;
  background: var(--card-bg, #fff);
  border-radius: 8px;
  border: 1px solid var(--border-color, #e5e6eb);
  overflow: auto;
}

/* scoped 下 :global 失效，用 .dark 类驱动暗色表格预览 */
.table-layout.dark .table-preview {
  background: var(--code-bg, #2a2a2a);
  border-color: var(--border-color, #374151);
}

.md-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.md-table th,
.md-table td {
  border: 1px solid var(--border-color, #e5e6eb);
  padding: 6px 10px;
  text-align: left;
  word-break: break-all;
}

.md-table th {
  background: var(--hover-bg, rgba(0, 0, 0, 0.04));
  font-weight: 600;
}

.table-layout.dark .md-table th {
  background: var(--hover-bg, rgba(255, 255, 255, 0.06));
}

/* 源码解析不出表格结构时的占位提示 */
.table-fallback {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-secondary, #999);
  text-align: center;
}

/* 表格模式 AI 引导卡（未配置视觉模型时占位） */
.ai-guide {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  border: 1px dashed var(--border-color, #e5e6eb);
  border-radius: 10px;
  text-align: center;
}

.ai-guide-icon {
  font-size: 28px;
}

.ai-guide-text {
  font-size: 13px;
  color: var(--text-secondary, #999);
  line-height: 1.6;
  max-width: 320px;
}

.copy-actions {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.file-input {
  display: none;
}
</style>
