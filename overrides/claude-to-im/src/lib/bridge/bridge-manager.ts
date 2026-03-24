/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { BridgeStatus, InboundMessage, OutboundAttachment, OutboundMessage, StreamingPreviewState } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';
const DEFAULT_CTI_HOME = path.join(os.homedir(), '.claude-to-im');
const AUDIO_TRANSCRIBE_TIMEOUT_MS = 120_000;
const DEFAULT_TASK_TIMEOUT_MS = 180_000;
const DEFAULT_VISUAL_TASK_TIMEOUT_MS = 1_200_000;
const FEISHU_ATTACHMENT_LABEL_RE = /^(?:.*?[，,;；]\s*)?(?:文件(?:已)?生成|文件路径|文件在这里|当前文件是|路径|附件|下载|保存(?:到)?|输出|截图(?:路径)?|file(?:\s+path)?|path|saved(?:\s+to)?|created(?:\s+at)?|generated(?:\s+at)?|截图已经拿到了，保存在桌面)\s*[:：]\s*(.+?)\s*$/i;
const FEISHU_SENDABLE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.bmp', '.ico']);
const FEISHU_MAX_FILE_UPLOAD_SIZE = 100 * 1024 * 1024;

interface BridgeRestartPlan {
  command: string;
  args: string[];
  options: {
    detached: boolean;
    stdio: 'ignore';
    env: NodeJS.ProcessEnv;
  };
}

interface PendingBridgeRestartNotice {
  channelType: string;
  chatId: string;
  requestedAt: string;
}

interface RecentBridgeRestart {
  channelType: string;
  chatId: string;
  pid: number;
  expiresAt: number;
}

const BRIDGE_RESTART_NOTICE_MAX_AGE_MS = 10 * 60_000;
const BRIDGE_RESTART_GUARD_WINDOW_MS = 15_000;

function shouldEnableVerboseProgress(channelType: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq') return false;
  return process.env.CTI_IM_VERBOSE_PROGRESS === 'true';
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function getCommandHelpLines(): string[] {
  return [
    '/new [path] - Start new session',
    '/bind &lt;session_id&gt; - Bind to existing session',
    '/cwd /path - Change working directory',
    '/mode plan|code|ask - Change mode',
    '/status - Show current status',
    '/sessions - List recent sessions',
    '/stop - Stop current session',
    '/bridge-restart - Restart bridge daemon',
    '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
    '1/2/3 - Quick permission reply (Feishu/QQ, single pending)',
    '/help - Show this help',
  ];
}

function buildBridgeRestartPlan(params?: {
  daemonScriptPath?: string;
  ctiHome?: string;
  shell?: string;
  platform?: NodeJS.Platform;
  launchdLabel?: string;
  uid?: number;
}): BridgeRestartPlan {
  const daemonScriptPath = params?.daemonScriptPath || path.resolve(process.cwd(), 'scripts/daemon.sh');
  const ctiHome = params?.ctiHome || process.env.CTI_HOME || DEFAULT_CTI_HOME;
  const shell = params?.shell || '/bin/bash';
  const platform = params?.platform || process.platform;
  const launchdLabel = params?.launchdLabel || 'com.claude-to-im.bridge';
  const uid = params?.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);

  if (platform === 'darwin' && uid !== undefined) {
    return {
      command: '/bin/launchctl',
      args: ['kickstart', '-k', `gui/${uid}/${launchdLabel}`],
      options: {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CTI_HOME: ctiHome },
      },
    };
  }

  const daemonScriptQuoted = shellDoubleQuote(daemonScriptPath);
  const ctiHomeQuoted = shellDoubleQuote(ctiHome);
  const script = [
    'sleep 1',
    `CTI_HOME=${ctiHomeQuoted} bash ${daemonScriptQuoted} stop || true`,
    'sleep 1',
    `CTI_HOME=${ctiHomeQuoted} bash ${daemonScriptQuoted} start >/dev/null 2>&1 || true`,
  ].join('; ');

  return {
    command: shell,
    args: ['-lc', script],
    options: {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CTI_HOME: ctiHome },
    },
  };
}

function triggerBridgeRestart(plan?: BridgeRestartPlan): void {
  const resolvedPlan = plan || buildBridgeRestartPlan();
  const child = spawn(resolvedPlan.command, resolvedPlan.args, resolvedPlan.options);
  child.unref();
}

function getBridgeRestartNoticePath(ctiHome?: string): string {
  const home = ctiHome || process.env.CTI_HOME || DEFAULT_CTI_HOME;
  return path.join(home, 'runtime', 'pending-bridge-restart.json');
}

function persistPendingBridgeRestartNotice(address: ChannelAddress, ctiHome?: string): void {
  const target = getBridgeRestartNoticePath(ctiHome);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload: PendingBridgeRestartNotice = {
    channelType: address.channelType,
    chatId: address.chatId,
    requestedAt: new Date().toISOString(),
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf-8');
}

function readPendingBridgeRestartNotice(ctiHome?: string): PendingBridgeRestartNotice | null {
  const target = getBridgeRestartNoticePath(ctiHome);
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8')) as Partial<PendingBridgeRestartNotice>;
    if (!parsed || typeof parsed.channelType !== 'string' || typeof parsed.chatId !== 'string' || typeof parsed.requestedAt !== 'string') {
      return null;
    }
    const requestedAtMs = Date.parse(parsed.requestedAt);
    if (!Number.isFinite(requestedAtMs) || Date.now() - requestedAtMs > BRIDGE_RESTART_NOTICE_MAX_AGE_MS) {
      return null;
    }
    return {
      channelType: parsed.channelType,
      chatId: parsed.chatId,
      requestedAt: parsed.requestedAt,
    };
  } catch {
    return null;
  }
}

function clearPendingBridgeRestartNotice(ctiHome?: string): void {
  const target = getBridgeRestartNoticePath(ctiHome);
  try {
    fs.unlinkSync(target);
  } catch {
    // ignore cleanup errors
  }
}

function formatBridgeRestartCompletedMessage(pid: number): string {
  return `bridge 已更新，新的 PID 是 ${pid}，请继续和我交流。`;
}

function formatBridgeRestartStartedMessage(): string {
  return '收到，正在重启 bridge。稍后我会主动告诉你新的 PID。';
}

function formatStreamingCompletionMessage(): string {
  return '本轮内容已全部生成，等待你的回复。';
}

function getTaskTimeoutMs(): number {
  const raw = process.env.CTI_TASK_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TASK_TIMEOUT_MS;
  return parsed;
}

function getVisualTaskTimeoutMs(defaultTimeoutMs: number): number {
  const raw = process.env.CTI_TASK_TIMEOUT_VISUAL_MS?.trim();
  if (!raw) return Math.max(defaultTimeoutMs, DEFAULT_VISUAL_TASK_TIMEOUT_MS);
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(defaultTimeoutMs, DEFAULT_VISUAL_TASK_TIMEOUT_MS);
  }
  return parsed;
}

function looksLikeVisualHeavyTask(text: string): boolean {
  if (!text.trim()) return false;
  return /(?:svg|png|jpg|jpeg|gif|webp|渲染|截图|截屏|画图|绘图|示意图|流程图|波形图|电路图|网页里打开|网页打开|浏览器里打开|浏览器打开|screenshot|render|diagram|figure|mermaid|camera|拍一张|拍照|图片发给我|发图|改图|修图|去水印)/i.test(text);
}

function computeTaskTimeoutMs(params: {
  rawText: string;
  effectiveText: string;
  hasImageAttachments: boolean;
  defaultTimeoutMs?: number;
}): number {
  const base = params.defaultTimeoutMs ?? getTaskTimeoutMs();
  if (params.hasImageAttachments) {
    return getVisualTaskTimeoutMs(base);
  }
  const combined = [params.rawText, params.effectiveText].filter(Boolean).join('\n');
  if (looksLikeVisualHeavyTask(combined)) {
    return getVisualTaskTimeoutMs(base);
  }
  return base;
}

async function withTaskTimeout<T>(
  promise: Promise<T>,
  abortController: AbortController,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        abortController.abort();
      } catch {
        // ignore abort errors
      }
      reject(new Error(`Task timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pre-shape full response so local attachment paths are extracted
    // before chunking; otherwise an attachment link in an earlier chunk can be
    // lost when only the last chunk carries message.attachments.
    const shaped = buildFeishuFinalDeliveryPayload(responseText, '');
    const outboundText = shaped.text || (shaped.attachments.length > 0 ? '' : responseText);
    if (!outboundText && shaped.attachments.length === 0) {
      return { ok: true };
    }
    return deliver(adapter, {
      address,
      text: outboundText,
      parseMode: 'Markdown',
      attachments: shaped.attachments.length > 0 ? shaped.attachments : undefined,
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

function buildFeishuFinalDeliveryPayload(
  fullText: string,
  streamedText: string,
): { text: string; attachments: OutboundAttachment[] } {
  const attachments: OutboundAttachment[] = [];
  const seen = new Set<string>();
  const keptLines: string[] = [];

  for (const line of fullText.split('\n')) {
    let cleanedLine = line;
    const candidates = findFeishuAttachmentMatches(line);

    for (const match of candidates) {
      const isStandaloneLink = line.trim() === match.fullMatch.trim();
      const isLabeledLink = isFeishuAttachmentCarrierLine(line, match);
      if (!match.isImageSyntax && !isStandaloneLink && !isLabeledLink) continue;
      const attachment = validateFeishuDeliveryAttachment(match.target || '');
      if (attachment && !seen.has(attachment.path)) {
        attachments.push(attachment);
        seen.add(attachment.path);
        cleanedLine = isLabeledLink ? '' : cleanedLine.replace(match.fullMatch, '').trim();
      }
    }

    if (cleanedLine === line) {
      const labeledPath = line.match(FEISHU_ATTACHMENT_LABEL_RE)?.[1];
      if (labeledPath) {
        const attachment = validateFeishuDeliveryAttachment(labeledPath);
        if (attachment && !seen.has(attachment.path)) {
          attachments.push(attachment);
          seen.add(attachment.path);
          cleanedLine = '';
        }
      }
    }

    if (cleanedLine === line) {
      const trimmed = line.trim();
      const attachment = validateFeishuDeliveryAttachment(trimmed);
      if (attachment && !seen.has(attachment.path)) {
        attachments.push(attachment);
        seen.add(attachment.path);
        cleanedLine = '';
      }
    }

    if (cleanedLine.trim()) {
      keptLines.push(cleanedLine);
    }
  }

  const textWithoutAttachmentPaths = keptLines.join('\n').trim();
  if (!streamedText) {
    return { text: textWithoutAttachmentPaths, attachments };
  }

  if (textWithoutAttachmentPaths.startsWith(streamedText)) {
    return {
      text: textWithoutAttachmentPaths.slice(streamedText.length).trimStart(),
      attachments,
    };
  }

  if (fullText.startsWith(streamedText)) {
    return {
      text: fullText.slice(streamedText.length).trimStart(),
      attachments,
    };
  }

  return { text: textWithoutAttachmentPaths, attachments };
}

function validateFeishuDeliveryAttachment(candidate: string): OutboundAttachment | null {
  if (!candidate) return null;
  const resolvedPath = resolveFeishuDeliveryAttachmentPath(candidate);
  if (!resolvedPath) return null;
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > FEISHU_MAX_FILE_UPLOAD_SIZE) return null;
    const kind: 'image' | 'file' = FEISHU_SENDABLE_IMAGE_EXTS.has(path.extname(resolvedPath).toLowerCase()) ? 'image' : 'file';
    return { path: resolvedPath, kind };
  } catch {
    return null;
  }
}

function resolveFeishuDeliveryAttachmentPath(candidate: string): string | null {
  const normalized = candidate.trim().replace(/^`|`$/g, '');
  if (!normalized || normalized.includes('\0')) return null;

  const possiblePaths: string[] = [];
  if (path.isAbsolute(normalized)) {
    possiblePaths.push(normalized);
  } else if (!normalized.includes(path.sep)) {
    const home = os.homedir();
    possiblePaths.push(path.join(home, 'Desktop', normalized));
    possiblePaths.push(path.join(home, 'Pictures', 'Screenshots', normalized));
    possiblePaths.push(path.join(home, 'Pictures', normalized));
    possiblePaths.push(path.join(home, 'Downloads', normalized));
    possiblePaths.push(path.join(home, 'Documents', normalized));
    possiblePaths.push(path.join(os.tmpdir(), normalized));
  }

  for (const candidatePath of possiblePaths) {
    try {
      if (fs.existsSync(candidatePath)) return candidatePath;
    } catch {
      // ignore
    }
  }
  return null;
}

function findFeishuAttachmentMatches(line: string): Array<{
  fullMatch: string;
  target: string;
  isImageSyntax: boolean;
  index: number;
}> {
  const matches: Array<{ fullMatch: string; target: string; isImageSyntax: boolean; index: number }> = [];
  const patterns = [
    { regex: /!\[[^\]]*\]\(([^)]+)\)/g, isImageSyntax: true },
    { regex: /\[[^\]]+\]\(([^)]+)\)/g, isImageSyntax: false },
  ];

  for (const { regex, isImageSyntax } of patterns) {
    for (const match of line.matchAll(regex)) {
      matches.push({
        fullMatch: match[0],
        target: match[1] || '',
        isImageSyntax,
        index: match.index ?? 0,
      });
    }
  }

  return matches.sort((a, b) => a.index - b.index);
}

function isFeishuAttachmentCarrierLine(
  line: string,
  match: { fullMatch: string; index: number },
): boolean {
  const before = line.slice(0, match.index).trim();
  const after = line.slice(match.index + match.fullMatch.length).trim();
  if (after.length > 0) return false;
  if (!before) return false;
  return FEISHU_ATTACHMENT_LABEL_RE.test(`${before} placeholder`);
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Processing chains for overlapping concurrency domains such as session/worktree. */
  processingLocks: Map<string, Promise<void>>;
  /** Sessions waiting for a manual auth/login step before the next continue. */
  manualInterventions: Map<string, { chatId: string; detectedAt: string; reason: string }>;
  /** Last time we emitted a busy/queued notice per chat. */
  busyNoticeAt: Map<string, number>;
  /** Very short post-restart guard so status pings don't fall back into old model context. */
  recentBridgeRestarts: Map<string, RecentBridgeRestart>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      processingLocks: new Map(),
      manualInterventions: new Map(),
      busyNoticeAt: new Map(),
      recentBridgeRestarts: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill processingLocks for states created before this field existed
  if (!g[GLOBAL_KEY].processingLocks) {
    g[GLOBAL_KEY].processingLocks = new Map();
  }
  if (!g[GLOBAL_KEY].manualInterventions) {
    g[GLOBAL_KEY].manualInterventions = new Map();
  }
  if (!g[GLOBAL_KEY].busyNoticeAt) {
    g[GLOBAL_KEY].busyNoticeAt = new Map();
  }
  if (!g[GLOBAL_KEY].recentBridgeRestarts) {
    g[GLOBAL_KEY].recentBridgeRestarts = new Map();
  }
  return g[GLOBAL_KEY];
}

function normalizeIntentText(text: string): string {
  return text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase();
}

function isContinueMessage(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  if (normalized.length <= 16 && /^(继续|继续吧|resume|continue|go on|carry on)$/.test(normalized)) {
    return true;
  }
  return /(?:继续|resume|continue|已登录|登录好了|授权好了|认证好了|done login|login done)/.test(normalized);
}

function isSkipMessage(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  if (normalized.length <= 16 && /^(跳过|跳过吧|skip|skip it|pass|cancel this|算了)$/.test(normalized)) {
    return true;
  }
  return /(?:跳过这步|跳过当前|skip this|skip current|不用继续|不继续了|先跳过|先略过)/.test(normalized);
}

function isRestartStatusQuery(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  if (normalized.length > 20) return false;
  return /^(?:在吗|还在吗|你还在吗|hello|hi|ping|恢复了吗|好了吗|ok了吗|重启好了吗)$/.test(normalized);
}

function detectManualIntervention(text: string): { reason: string; resumeHint: string } | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;

  const authPattern = /(log[\s-]?in|sign[\s-]?in|authenticate|authentication|authorize|authorization|oauth|2fa|two[- ]factor|verification code|captcha|sso|consent|browser login|登录|扫码|验证码|二次验证|二步验证|授权|认证|人机验证)/i;
  const manualPattern = /(manual|manually|by hand|手动|在电脑上|在浏览器里|完成后回复|reply ["']?continue["']?|回复["“]?继续["”]?)/i;

  if (!authPattern.test(normalized)) return null;

  const reason = manualPattern.test(normalized)
    ? 'manual_auth_required'
    : 'auth_like_step_detected';

  return {
    reason,
    resumeHint: 'A manual login/auth step was detected. Finish it on the computer, then reply "继续" here and I will continue from the same session.',
  };
}

function detectSystemPermissionIntervention(
  text: string,
  context?: { currentStage?: string; timedOut?: boolean },
): { reason: string; resumeHint: string } | null {
  const normalized = normalizeIntentText(text);
  const stage = normalizeIntentText(context?.currentStage || '');
  const combined = [normalized, stage].filter(Boolean).join('\n');
  if (!combined) return null;

  const explicitPermissionPattern = /(?:operation not permitted|permission denied|not authorized to send apple events|not allowed assistive access|accessibility access|screen recording|screen capture|apple events|automation permission|system events got an error|kAXError|tcc|osascript)/i;
  const timedOutPermissionPattern = /(?:osascript|system events|screencapture|screen capture|screen recording|apple events|accessibility)/i;

  const looksLikePermissionBlock = explicitPermissionPattern.test(combined)
    || (!!context?.timedOut && timedOutPermissionPattern.test(combined));

  if (!looksLikePermissionBlock) return null;

  return {
    reason: context?.timedOut ? 'system_permission_blocked_timeout' : 'system_permission_required',
    resumeHint: '检测到这一步可能被 macOS 系统权限拦住了。请在电脑上完成对应授权（例如辅助功能、屏幕录制、自动化/Apple Events），处理完后在这里回复“继续”，我会从同一会话接着做。',
  };
}

function detectUserActionIntervention(
  text: string,
  context?: { currentStage?: string; timedOut?: boolean },
): { reason: string; resumeHint: string } | null {
  return detectSystemPermissionIntervention(text, context) || detectManualIntervention(text);
}

function appendResumeHint(text: string, hint: string): string {
  if (!text.trim()) return hint;
  if (text.includes(hint)) return text;
  return `${text}\n\n${hint}`;
}

function buildManualResumePrompt(userText: string): string {
  const note = userText.trim();
  if (!note || isContinueMessage(userText)) {
    return 'The user has completed the required manual login/authentication step in the desktop environment. Continue from where you left off.';
  }
  return `The user has completed the required manual login/authentication step in the desktop environment. Continue from where you left off. User note: ${note}`;
}

function shouldSuppressPostResumeHint(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return /(?:已经视为完成|已视为完成|当前没有挂起|没有挂起中的后续命令|没有排队中的实际操作|没有排队中的后续操作|可以继续下一步|接着做|接着执行|直接接着执行|继续下一步|ready for the next step|no pending follow[- ]up|no pending command|nothing pending)/.test(normalized);
}

function splitForwardableAttachments(
  attachments?: import('./host.js').FileAttachment[],
): {
  imageAttachments: import('./host.js').FileAttachment[];
  unsupportedAttachments: import('./host.js').FileAttachment[];
} {
  const imageAttachments: import('./host.js').FileAttachment[] = [];
  const unsupportedAttachments: import('./host.js').FileAttachment[] = [];

  for (const attachment of attachments ?? []) {
    if (attachment.type.startsWith('image/')) {
      imageAttachments.push(attachment);
    } else {
      unsupportedAttachments.push(attachment);
    }
  }

  return { imageAttachments, unsupportedAttachments };
}

function summarizeUnsupportedAttachments(
  attachments: import('./host.js').FileAttachment[],
): string {
  const counts = new Map<string, number>();

  for (const attachment of attachments) {
    let label = 'file';
    if (attachment.type.startsWith('audio/')) label = 'audio';
    else if (attachment.type.startsWith('video/')) label = 'video';
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([label, count]) => `${count} ${label}${count > 1 ? 's' : ''}`)
    .join(', ');
}

function getAudioFileExtension(mimeType: string): string {
  if (mimeType.includes('ogg')) return '.ogg';
  if (mimeType.includes('wav') || mimeType.includes('wave')) return '.wav';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return '.mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
  if (mimeType.includes('aac')) return '.aac';
  return path.extname(mimeType) || '.bin';
}

async function transcribeAudioAttachment(
  attachment: import('./host.js').FileAttachment,
): Promise<string | null> {
  const cli = process.env.CTI_AUDIO_TRANSCRIBE_COMMAND?.trim() || 'whisperkit-cli';
  const model = process.env.CTI_AUDIO_TRANSCRIBE_MODEL?.trim() || 'tiny';
  const language = process.env.CTI_AUDIO_TRANSCRIBE_LANGUAGE?.trim() || '';
  const ctiHome = process.env.CTI_HOME || DEFAULT_CTI_HOME;
  const cacheDir = path.join(ctiHome, 'cache', 'whisperkit');
  fs.mkdirSync(cacheDir, { recursive: true });

  const ext = getAudioFileExtension(attachment.type);
  const tmpPath = path.join(os.tmpdir(), `cti-audio-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);

  try {
    fs.writeFileSync(tmpPath, Buffer.from(attachment.data, 'base64'));

    const args = [
      'transcribe',
      '--audio-path', tmpPath,
      '--model', model,
      '--download-model-path', cacheDir,
      '--download-tokenizer-path', cacheDir,
      '--without-timestamps',
    ];

    if (language) {
      args.push('--language', language);
    }

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(cli, args, { timeout: AUDIO_TRANSCRIBE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (error, out, err) => {
        if (error) {
          const detail = err?.trim() || out?.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(out);
      });
    });

    const transcript = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    return transcript || null;
  } catch (err) {
    console.warn('[bridge-manager] Audio transcription failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Resolve a stable worktree key so different bindings targeting the same repo
 * serialize through one queue. Falls back to the real working directory when
 * no repo marker is present.
 */
function resolveWorktreeKey(workingDirectory: string): string | null {
  const raw = workingDirectory.trim();
  if (!raw) return null;

  let current = raw;
  try {
    current = fs.realpathSync(raw);
  } catch {
    current = path.resolve(raw);
  }

  let probe = current;
  while (true) {
    if (fs.existsSync(path.join(probe, '.git'))) {
      return probe;
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }

  return current;
}

/**
 * Process a function with overlapping concurrency domains serialized together.
 * Any shared session key or worktree key will force sequential execution.
 */
function processWithConcurrencyLocks(lockKeys: string[], fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const uniqueKeys = Array.from(new Set(lockKeys.filter(Boolean))).sort();
  const previousLocks = uniqueKeys
    .map((lockKey) => state.processingLocks.get(lockKey))
    .filter((lock): lock is Promise<void> => !!lock);
  const previous = previousLocks.length > 0 ? Promise.all(previousLocks).then(() => undefined) : Promise.resolve();
  const current = previous.then(fn, fn);

  for (const lockKey of uniqueKeys) {
    state.processingLocks.set(lockKey, current);
  }

  current.finally(() => {
    for (const lockKey of uniqueKeys) {
      if (state.processingLocks.get(lockKey) === current) {
        state.processingLocks.delete(lockKey);
      }
    }
  }).catch(() => {});
  return current;
}

function hasProcessingLock(lockKeys: string[]): boolean {
  const state = getState();
  return lockKeys.some((lockKey) => !!state.processingLocks.get(lockKey));
}

async function maybeSendBusyNotice(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const state = getState();
  const chatId = msg.address.chatId;
  const now = Date.now();
  const lastAt = state.busyNoticeAt.get(chatId) || 0;
  if (now - lastAt < 15_000) return;

  state.busyNoticeAt.set(chatId, now);
  await deliver(adapter, {
    address: msg.address,
    text: '上一条任务还在处理中。我已经收到这条新消息，会在当前任务结束后继续处理。',
    parseMode: 'plain',
    replyToMessageId: msg.messageId,
  });
}

async function maybeDeliverPendingBridgeRestartNotice(): Promise<void> {
  const pending = readPendingBridgeRestartNotice();
  if (!pending) return;

  const state = getState();
  const adapter = state.adapters.get(pending.channelType);
  if (!adapter?.isRunning()) {
    return;
  }

  const message = formatBridgeRestartCompletedMessage(process.pid);
  const result = await deliver(adapter, {
    address: {
      channelType: pending.channelType,
      chatId: pending.chatId,
    },
    text: message,
    parseMode: 'plain',
  }, {
    dedupKey: `bridge-restart-complete:${pending.channelType}:${pending.chatId}:${pending.requestedAt}`,
  });

  if (!result.ok) {
    console.warn('[bridge-manager] Failed to deliver bridge restart completion notice:', result.error || 'unknown error');
    return;
  }

  state.recentBridgeRestarts.set(pending.chatId, {
    channelType: pending.channelType,
    chatId: pending.chatId,
    pid: process.pid,
    expiresAt: Date.now() + BRIDGE_RESTART_GUARD_WINDOW_MS,
  });
  clearPendingBridgeRestartNotice();
}

function resetSessionRuntime(binding: { codepilotSessionId: string }): void {
  const llm = getBridgeContext().llm as import('./host.js').LLMProvider;
  try {
    llm.resetSessionRuntime?.(binding.codepilotSessionId, { recreateClient: true });
  } catch (err) {
    console.warn('[bridge-manager] Failed to reset transient LLM session state:', err instanceof Error ? err.message : err);
  }
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  await maybeDeliverPendingBridgeRestartNotice();

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for unrelated sessions/worktrees are dispatched concurrently;
 * overlapping sessions or worktrees are serialized via shared lock keys.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside the queued concurrency path).
        // Regular messages use shared session/worktree locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the queued lock path. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters that queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          const session = getBridgeContext().store.getSession(binding.codepilotSessionId);
          const worktreeKey = resolveWorktreeKey(
            binding.workingDirectory || session?.working_directory || '',
          );
          const lockKeys = [
            `session:${binding.codepilotSessionId}`,
            ...(worktreeKey ? [`worktree:${worktreeKey}`] : []),
          ];
          if (hasProcessingLock(lockKeys)) {
            await maybeSendBusyNotice(adapter, msg);
          }
          // Fire-and-forget into the shared concurrency queue — the loop keeps
          // accepting unrelated messages immediately.
          processWithConcurrencyLocks(lockKeys, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();
  const managerState = getState();

  const recentRestart = managerState.recentBridgeRestarts.get(msg.address.chatId);
  if (recentRestart) {
    if (Date.now() > recentRestart.expiresAt) {
      managerState.recentBridgeRestarts.delete(msg.address.chatId);
    } else if (
      recentRestart.channelType === msg.address.channelType &&
      isRestartStatusQuery(msg.text)
    ) {
      await deliver(adapter, {
        address: msg.address,
        text: formatBridgeRestartCompletedMessage(recentRestart.pid),
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      }, {
        dedupKey: `bridge-restart-status:${msg.address.channelType}:${msg.address.chatId}:${recentRestart.pid}:${msg.messageId}`,
      });
      if (msg.updateId != null && adapter.acknowledgeUpdate) {
        adapter.acknowledgeUpdate(msg.updateId);
      }
      return;
    }
  }

  // Update lastMessageAt for this adapter
  const adapterState = managerState;
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const { imageAttachments, unsupportedAttachments } = splitForwardableAttachments(msg.attachments);
  const audioAttachments = unsupportedAttachments.filter((attachment) => attachment.type.startsWith('audio/'));
  const passthroughUnsupported = unsupportedAttachments.filter((attachment) => !attachment.type.startsWith('audio/'));
  const hasImageAttachments = imageAttachments.length > 0;
  const hasUnsupportedAttachments = unsupportedAttachments.length > 0;
  const hasAttachments = hasImageAttachments || hasUnsupportedAttachments;

  // Handle image-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as { imageDownloadFailed?: boolean; failedCount?: number } | undefined;
    if (rawData?.imageDownloadFailed) {
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} image(s). Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu' || adapter.channelType === 'qq') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  let effectiveText = text;
  let failedAudioAttachments: import('./host.js').FileAttachment[] = [];

  if (audioAttachments.length > 0) {
    const transcripts: string[] = [];
    for (let index = 0; index < audioAttachments.length; index += 1) {
      const attachment = audioAttachments[index];
      const transcript = await transcribeAudioAttachment(attachment);
      if (transcript) {
        const label = audioAttachments.length > 1 ? `Voice transcript ${index + 1}:\n${transcript}` : transcript;
        transcripts.push(label);
      } else {
        failedAudioAttachments.push(attachment);
      }
    }

    if (transcripts.length > 0) {
      effectiveText = [effectiveText, ...transcripts].filter(Boolean).join('\n\n').trim();
    }
  }

  const unresolvedUnsupported = [...passthroughUnsupported, ...failedAudioAttachments];

  if (!effectiveText && !hasImageAttachments && unresolvedUnsupported.length === 0) { ack(); return; }

  if (!effectiveText && !hasImageAttachments && unresolvedUnsupported.length > 0) {
    const unsupportedSummary = summarizeUnsupportedAttachments(unresolvedUnsupported);
    await deliver(adapter, {
      address: msg.address,
      text: `This bridge currently forwards image attachments only. Received ${unsupportedSummary}, which could not be turned into text for Codex. Please send text/transcript instead, or send an image.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    return;
  }

  if ((effectiveText || hasImageAttachments) && unresolvedUnsupported.length > 0) {
    const unsupportedSummary = summarizeUnsupportedAttachments(unresolvedUnsupported);
    await deliver(adapter, {
      address: msg.address,
      text: `Note: ignored ${unsupportedSummary}. This bridge currently forwards image attachments only, with local voice transcription when available.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
  }

  if (!effectiveText && !hasImageAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);
  const manualState = getState().manualInterventions.get(binding.codepilotSessionId);
  const shouldResumeManualStep = !!manualState
    && manualState.chatId === msg.address.chatId
    && isContinueMessage(rawText);
  const shouldSkipManualStep = !!manualState
    && manualState.chatId === msg.address.chatId
    && isSkipMessage(rawText);

  if (shouldSkipManualStep) {
    getState().manualInterventions.delete(binding.codepilotSessionId);
    resetSessionRuntime(binding);
    await deliver(adapter, {
      address: msg.address,
      text: '已跳过当前挂起的人工介入步骤。你可以直接发下一条任务，我会按新上下文继续处理。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    }, { sessionId: binding.codepilotSessionId });
    ack();
    return;
  }

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);
  const effectiveTimeoutMs = computeTaskTimeoutMs({
    rawText,
    effectiveText,
    hasImageAttachments,
  });

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;
  const shouldSendProgressNotices = adapter.channelType === 'feishu' || adapter.channelType === 'qq';
  const verboseProgressEnabled = shouldEnableVerboseProgress(adapter.channelType);
  const progressState = shouldSendProgressNotices ? {
    currentStage: '',
    lastSentText: '',
    lastSentAt: 0,
    startedAt: Date.now(),
    sendChain: Promise.resolve(),
    heartbeatTimer: null as ReturnType<typeof setInterval> | null,
  } : null;

  const queueProgressNotice = (text: string, opts?: { force?: boolean }) => {
    if (!progressState || !text.trim()) return;
    const normalized = text.trim();
    if (!opts?.force && !verboseProgressEnabled) {
      return;
    }
    const now = Date.now();
    if (!opts?.force && normalized === progressState.currentStage && now - progressState.lastSentAt < 30_000) {
      return;
    }
    if (!opts?.force) {
      progressState.currentStage = normalized;
    }
    progressState.sendChain = progressState.sendChain
      .catch(() => {})
      .then(async () => {
        await deliver(adapter, {
          address: msg.address,
          text: `Progress: ${normalized}`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        }, { sessionId: binding.codepilotSessionId });
        progressState.lastSentAt = Date.now();
        progressState.lastSentText = normalized;
      })
      .catch((err) => {
        console.warn('[bridge-manager] Progress notice failed:', err instanceof Error ? err.message : err);
      });
  };

  if (progressState && verboseProgressEnabled) {
    progressState.heartbeatTimer = setInterval(() => {
      if (Date.now() - progressState.startedAt < 25_000) return;
      const idleFor = Date.now() - progressState.lastSentAt;
      const heartbeatText = progressState.currentStage
        ? `Still working: ${progressState.currentStage}`
        : 'Still working on it...';
      if (idleFor >= 25_000 && heartbeatText !== progressState.lastSentText) {
        queueProgressNotice(heartbeatText, { force: true });
      }
    }, 15_000);
  }

  // Build the onPartialText callback (or undefined if preview not supported)
  const onPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or a small default prompt for image-only messages (prompt is
    // still required by the Codex SDK). Non-image attachments are filtered
    // out above because the current SDK wiring only supports local images.
    const promptText = shouldResumeManualStep
      ? buildManualResumePrompt(rawText)
      : effectiveText || (hasImageAttachments ? 'Describe the attached image.' : '');
    if (shouldResumeManualStep) {
      getState().manualInterventions.delete(binding.codepilotSessionId);
      queueProgressNotice('Manual auth step completed by user; resuming the task.', { force: true });
    }

    const result = await withTaskTimeout(engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasImageAttachments ? imageAttachments : undefined, onPartialText, (update) => {
      queueProgressNotice(update.text);
    }), taskAbort, effectiveTimeoutMs);

    if (progressState) {
      await progressState.sendChain.catch(() => {});
    }

    // Send response text — render via channel-appropriate format
    let responseText = result.responseText;
    const manualIntervention = shouldResumeManualStep && shouldSuppressPostResumeHint(result.responseText || result.errorMessage)
      ? null
      : detectUserActionIntervention(result.responseText || result.errorMessage, {
        currentStage: progressState?.currentStage,
        timedOut: false,
      });
    if (manualIntervention) {
      getState().manualInterventions.set(binding.codepilotSessionId, {
        chatId: msg.address.chatId,
        detectedAt: new Date().toISOString(),
        reason: manualIntervention.reason,
      });
      responseText = appendResumeHint(responseText, manualIntervention.resumeHint);
    }

    if (responseText) {
      if (adapter.channelType === 'feishu' && previewState?.lastSentText) {
        const finalPayload = buildFeishuFinalDeliveryPayload(responseText, previewState.lastSentText);
        if (finalPayload.text || finalPayload.attachments.length > 0) {
          await deliver(adapter, {
            address: msg.address,
            text: finalPayload.text,
            parseMode: 'Markdown',
            attachments: finalPayload.attachments,
            replyToMessageId: msg.messageId,
          }, { sessionId: binding.codepilotSessionId });
        }
        await deliver(adapter, {
          address: msg.address,
          text: formatStreamingCompletionMessage(),
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        }, { sessionId: binding.codepilotSessionId });
      } else {
        await deliverResponse(adapter, msg.address, responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      const errorText = manualIntervention
        ? appendResumeHint(`<b>Error:</b> ${escapeHtml(result.errorMessage)}`, manualIntervention.resumeHint)
        : `<b>Error:</b> ${escapeHtml(result.errorMessage)}`;
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: errorText,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bridge-manager] Message handling failed:', message);
    if (binding.id) {
      try {
        store.updateChannelBinding(binding.id, { sdkSessionId: '' });
      } catch {
        // best effort
      }
    }
    resetSessionRuntime(binding);
    const manualIntervention = detectUserActionIntervention(message, {
      currentStage: progressState?.currentStage,
      timedOut: /task timed out after/i.test(message),
    });
    if (manualIntervention) {
      getState().manualInterventions.set(binding.codepilotSessionId, {
        chatId: msg.address.chatId,
        detectedAt: new Date().toISOString(),
        reason: manualIntervention.reason,
      });
      await deliver(adapter, {
        address: msg.address,
        text: `处理这条消息时被系统权限拦住了。\n\n${manualIntervention.resumeHint}`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      }, { sessionId: binding.codepilotSessionId });
    } else {
      await deliver(adapter, {
        address: msg.address,
        text: `处理这条消息时出错了：${message}`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      }, { sessionId: binding.codepilotSessionId });
    }
  } finally {
  if (progressState?.heartbeatTimer) {
      clearInterval(progressState.heartbeatTimer);
      progressState.heartbeatTimer = null;
    }
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let postResponseAction: (() => void | Promise<void>) | null = null;

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        ...getCommandHelpLines().filter((line) => !line.startsWith('1/2/3')),
      ].join('\n');
      break;

    case '/new': {
      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        resetSessionRuntime(binding);
        router.updateBinding(binding.id, { sdkSessionId: '' });
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/bridge-restart': {
      response = formatBridgeRestartStartedMessage();
      postResponseAction = async () => {
        persistPendingBridgeRestartNotice(msg.address);
        await new Promise((resolve) => setTimeout(resolve, 300));
        triggerBridgeRestart();
      };
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        ...getCommandHelpLines(),
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }

  if (postResponseAction) {
    await postResponseAction();
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = {
  handleMessage,
  computeTaskTimeoutMs,
  buildFeishuFinalDeliveryPayload,
  getCommandHelpLines,
  buildBridgeRestartPlan,
  getBridgeRestartNoticePath,
  persistPendingBridgeRestartNotice,
  readPendingBridgeRestartNotice,
  clearPendingBridgeRestartNotice,
  formatBridgeRestartCompletedMessage,
  formatBridgeRestartStartedMessage,
  formatStreamingCompletionMessage,
  isRestartStatusQuery,
};
