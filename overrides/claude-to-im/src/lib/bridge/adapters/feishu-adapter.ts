/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 * Routes messages through an internal async queue (same pattern as Telegram).
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 * - Permission prompts → interactive card with action buttons
 *
 * card.action.trigger events are handled via EventDispatcher (Openclaw pattern):
 * button clicks are converted to synthetic text messages and routed through
 * the normal /perm command processing pipeline.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'crypto';
import { execFileSync } from 'node:child_process';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  ChannelType,
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
} from '../markdown/feishu.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;
/** Max image upload size for Feishu message images (10 MB). */
const MAX_IMAGE_UPLOAD_SIZE = 10 * 1024 * 1024;
/** Max file upload size for Feishu message files (100 MB). */
const MAX_FILE_UPLOAD_SIZE = 100 * 1024 * 1024;
/** Supported local image extensions for outbound upload. */
const SENDABLE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.bmp', '.ico']);
/** Heuristic labels that often precede a downloadable local path. */
const ATTACHMENT_LABEL_RE = /^(?:.*?[，,;；]\s*)?(?:文件(?:已)?生成|文件路径|文件在这里|当前文件是|路径|附件|下载|保存(?:到)?|输出|截图(?:路径)?|截图已经拿到了，保存在桌面|file(?:\s+path)?|path|saved(?:\s+to)?|created(?:\s+at)?|generated(?:\s+at)?)\s*[:：]\s*(.+?)\s*$/i;
/** MIME type hints for Feishu file uploads. Unknown types fall back to "stream". */
const FEISHU_FILE_TYPE_BY_EXT: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
  '.mp4': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
  '.opus': 'opus',
};

interface LocalAttachment {
  path: string;
  kind: 'image' | 'file';
}

interface MarkdownAttachmentMatch {
  fullMatch: string;
  target: string;
  isImageSyntax: boolean;
  index: number;
}

export interface FeishuExtractedAttachment {
  path: string;
  kind: 'image' | 'file';
}

/** Feishu emoji type for typing indicator (same as Openclaw). */
const TYPING_EMOJI = 'Typing';
const WS_STUCK_RECONNECT_MS = 5 * 60_000;
const WS_RECONNECT_BURST_WINDOW_MS = 10 * 60_000;
const WS_RECONNECT_BURST_THRESHOLD = 6;
const WS_RESTART_COOLDOWN_MS = 30 * 60_000;
const INBOUND_TEXT_REPLAY_WINDOW_MS = 2 * 60 * 60_000;
const RECONNECT_REPLAY_GUARD_WINDOW_MS = 15 * 60_000;
const FEISHU_HEALTH_FILE = path.join(
  process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im'),
  'runtime',
  'feishu-health.json',
);
const IMAGE_COMPRESSION_QUALITIES = [85, 70, 55, 40];
const IMAGE_MAX_DIMENSIONS = [null, 3072, 2560, 2048, 1600] as const;

interface FeishuHealthSnapshot {
  running: boolean;
  wsState: 'starting' | 'ready' | 'reconnecting' | 'rebuilding' | 'stopped';
  botOpenId: string | null;
  wsReadyAt: string | null;
  lastInboundAt: string | null;
  lastReconnectAt: string | null;
  reconnectsLast10Min: number;
  watchdogRestarts: number;
  lastWatchdogReason: string | null;
  updatedAt: string;
}

/** Shape of the SDK's im.message.receive_v1 event data. */
type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};


/** MIME type guesses by message_type. */
const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
  private botIds = new Set<string>();
  /** Track last incoming message ID per chat for typing indicator. */
  private lastIncomingMessageId = new Map<string, string>();
  /** Track active typing reaction IDs per chat for cleanup. */
  private typingReactions = new Map<string, string>();
  /** Last cumulative preview text emitted per chat for delta chunking. */
  private previewMessages = new Map<string, string>();
  /** Chats where preview should be permanently disabled after hard API failure. */
  private previewDegraded = new Set<string>();
  private wsReadyAt = 0;
  private lastInboundAt = 0;
  private lastReconnectAt = 0;
  private reconnectTimestamps: number[] = [];
  private reconnectWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private wsRestartInFlight = false;
  private watchdogRestartCount = 0;
  private lastWatchdogReason: string | null = null;
  private lastWatchdogRestartAt = 0;
  private wsState: FeishuHealthSnapshot['wsState'] = 'stopped';
  private recentInboundTexts = new Map<string, { at: number; messageId: string }>();

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret') || '';
    const domainSetting = getBridgeContext().store.getSetting('bridge_feishu_domain') || 'feishu';
    const domain = domainSetting === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    // Create REST client
    this.restClient = new lark.Client({
      appId,
      appSecret,
      domain,
    });

    // Resolve bot identity for @mention detection
    await this.resolveBotIdentity(appId, appSecret, domain);

    this.running = true;
    this.wsState = 'starting';
    this.persistHealth();

    // Create EventDispatcher and register event handlers.
    // NOTE: card.action.trigger requires HTTP webhook (not supported via WSClient).
    // Openclaw uses an HTTP server for card callbacks — CodePilot is a desktop app
    // without a public endpoint, so we rely on text-based /perm commands instead.
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
    });

    await this.startWsClient(appId, appSecret, domain, dispatcher);

    console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Close WebSocket connection (SDK exposes close())
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        console.warn('[feishu-adapter] WSClient close error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }
    this.restClient = null;

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Clear state
    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();
    this.typingReactions.clear();
    this.previewMessages.clear();
    this.previewDegraded.clear();
    this.lastInboundAt = 0;
    this.lastReconnectAt = 0;
    this.wsReadyAt = 0;
    this.reconnectTimestamps = [];
    this.watchdogRestartCount = 0;
    this.lastWatchdogReason = null;
    this.lastWatchdogRestartAt = 0;
    this.wsState = 'stopped';
    this.recentInboundTexts.clear();
    this.clearReconnectWatchdog();
    this.persistHealth();

    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Typing indicator (Openclaw-style reaction) ─────────────

  /**
   * Add a "Typing" emoji reaction to the user's message.
   * Called by bridge-manager via onMessageStart().
   */
  onMessageStart(chatId: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!messageId || !this.restClient) return;

    // Fire-and-forget — typing indicator is non-critical
    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((res) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reactionId = (res as any)?.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(chatId, reactionId);
      }
    }).catch((err) => {
      // Non-critical — don't log rate limit errors
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Typing indicator failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  /**
   * Remove the "Typing" emoji reaction from the user's message.
   * Called by bridge-manager via onMessageEnd().
   */
  onMessageEnd(chatId: string): void {
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId || !this.restClient) return;

    this.typingReactions.delete(chatId);

    // Fire-and-forget — failure is fine (reaction may already be gone)
    this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => { /* ignore */ });
  }

  // ── Streaming preview ──────────────────────────────────────

  getPreviewCapabilities(_chatId: string): PreviewCapabilities | null {
    try {
      const enabled = getBridgeContext().store.getSetting('bridge_feishu_stream_enabled');
      if (enabled === 'false') return null;
    } catch {
      // tests / isolated calls may not initialize bridge context; default on
    }

    if (this.previewDegraded.has(_chatId)) return null;

    return { supported: true, privateOnly: false };
  }

  async sendPreview(chatId: string, text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.restClient) return 'skip';
    if (this.previewDegraded.has(chatId)) return 'degrade';

    const normalizedText = preprocessFeishuMarkdown(text);
    const previousText = this.previewMessages.get(chatId) || '';
    const deltaText = normalizedText.startsWith(previousText)
      ? normalizedText.slice(previousText.length).trim()
      : normalizedText;
    if (!deltaText) return 'skip';
    const content = buildPostContent(deltaText);

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content,
        },
      });
      if (res?.data?.message_id) {
        this.previewMessages.set(chatId, normalizedText);
        return 'sent';
      }
      return 'skip';
    } catch (err) {
      const code = (err as { code?: number; response?: { status?: number } })?.code
        ?? (err as { response?: { status?: number } })?.response?.status;
      if (code === 400 || code === 403 || code === 404) {
        this.previewDegraded.add(chatId);
        this.previewMessages.delete(chatId);
        return 'degrade';
      }
      return 'skip';
    }
  }

  endPreview(chatId: string, _draftId: number): void {
    this.previewMessages.delete(chatId);
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    let text = message.text;

    // Convert HTML to markdown for Feishu rendering (e.g. command responses)
    if (message.parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }

    // Preprocess markdown for Claude responses
    if (message.parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    const parsed = this.extractLocalAttachments(text);
    const explicitAttachments = (message.attachments || [])
      .map((attachment) => this.normalizeAttachment(attachment))
      .filter((attachment): attachment is LocalAttachment => attachment !== null);
    const attachments = this.mergeAttachments(parsed.attachments, explicitAttachments);

    if (attachments.length > 0) {
      let lastResult: SendResult = { ok: true };

      if (parsed.textWithoutAttachmentPaths.trim()) {
        lastResult = await this.sendFormattedText(message.address.chatId, parsed.textWithoutAttachmentPaths, message.inlineButtons);
        if (!lastResult.ok) return lastResult;
      }

      for (const attachment of attachments) {
        lastResult = attachment.kind === 'image'
          ? await this.sendLocalImage(message.address.chatId, attachment.path)
          : await this.sendLocalFile(message.address.chatId, attachment.path);
        if (!lastResult.ok) return lastResult;
      }

      return lastResult;
    }

    // If there are inline buttons (permission prompts), send card with action buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    // Rendering strategy (aligned with Openclaw):
    // - Code blocks / tables → interactive card (schema 2.0 markdown)
    // - Other text → post (md tag)
    return this.sendFormattedText(message.address.chatId, text);
  }

  /**
   * Send text as an interactive card (schema 2.0 markdown).
   * Used for code blocks and tables — card renders them properly.
   */
  private async sendAsCard(chatId: string, text: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    // Fallback to post
    return this.sendAsPost(chatId, text);
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(chatId: string, text: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: postContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  private async sendFormattedText(
    chatId: string,
    text: string,
    inlineButtons?: OutboundMessage['inlineButtons'],
  ): Promise<SendResult> {
    if (inlineButtons && inlineButtons.length > 0) {
      return this.sendPermissionCard(chatId, text, inlineButtons);
    }
    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(chatId, text);
    }
    return this.sendAsPost(chatId, text);
  }

  /**
   * Extract absolute local attachment paths from message lines, leaving other text intact.
   */
  private extractLocalAttachments(text: string): { textWithoutAttachmentPaths: string; attachments: LocalAttachment[] } {
    const attachments: LocalAttachment[] = [];
    const seen = new Set<string>();
    const keptLines: string[] = [];

    for (const line of text.split('\n')) {
      let cleanedLine = line;
      const candidates = this.findMarkdownAttachmentMatches(line);

      for (const match of candidates) {
        const isStandaloneLink = line.trim() === match.fullMatch.trim();
        const isLabeledLink = this.isAttachmentCarrierLine(line, match);
        if (!match.isImageSyntax && !isStandaloneLink && !isLabeledLink) continue;
        const attachment = this.validateLocalAttachmentPath(match.target || '');
        if (attachment && !seen.has(attachment.path)) {
          attachments.push(attachment);
          seen.add(attachment.path);
          cleanedLine = isLabeledLink ? '' : cleanedLine.replace(match.fullMatch, '').trim();
        }
      }

      if (cleanedLine === line) {
        const labeledPath = line.match(ATTACHMENT_LABEL_RE)?.[1];
        if (labeledPath) {
          const attachment = this.validateLocalAttachmentPath(labeledPath);
          if (attachment && !seen.has(attachment.path)) {
            attachments.push(attachment);
            seen.add(attachment.path);
            cleanedLine = '';
          }
        }
      }

      if (cleanedLine === line) {
        const trimmed = line.trim();
        const attachment = this.validateLocalAttachmentPath(trimmed);
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

    return {
      textWithoutAttachmentPaths: keptLines.join('\n').trim(),
      attachments,
    };
  }

  private normalizeAttachment(attachment: OutboundAttachment): LocalAttachment | null {
    if (!attachment?.path) return null;
    const normalized = this.validateLocalAttachmentPath(attachment.path);
    if (!normalized) return null;
    if (attachment.kind) {
      return { ...normalized, kind: attachment.kind };
    }
    return normalized;
  }

  private mergeAttachments(...groups: LocalAttachment[][]): LocalAttachment[] {
    const merged: LocalAttachment[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const attachment of group) {
        if (seen.has(attachment.path)) continue;
        seen.add(attachment.path);
        merged.push(attachment);
      }
    }
    return merged;
  }

  private validateLocalAttachmentPath(candidate: string): LocalAttachment | null {
    if (!candidate) return null;

    const resolvedPath = this.resolveLocalAttachmentPath(candidate);
    if (!resolvedPath) return null;

    try {
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) return null;
      const kind: 'image' | 'file' = SENDABLE_IMAGE_EXTS.has(path.extname(resolvedPath).toLowerCase()) ? 'image' : 'file';
      const sizeLimit = MAX_FILE_UPLOAD_SIZE;
      if (stat.size <= 0 || stat.size > sizeLimit) return null;
      return { path: resolvedPath, kind };
    } catch {
      return null;
    }
  }

  private resolveLocalAttachmentPath(candidate: string): string | null {
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

  private findMarkdownAttachmentMatches(line: string): MarkdownAttachmentMatch[] {
    const matches: MarkdownAttachmentMatch[] = [];
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

  private isAttachmentCarrierLine(line: string, match: MarkdownAttachmentMatch): boolean {
    const before = line.slice(0, match.index).trim();
    const after = line.slice(match.index + match.fullMatch.length).trim();
    if (after.length > 0) return false;
    if (!before) return false;
    return ATTACHMENT_LABEL_RE.test(`${before} placeholder`);
  }

  /**
   * Upload a local image to Feishu and send it as an image message.
   */
  private async sendLocalImage(chatId: string, filePath: string): Promise<SendResult> {
    const uploadPath = this.prepareUploadableImagePath(filePath);
    try {
      const uploadRes = await this.restClient!.im.v1.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(uploadPath),
        },
      });

      const imageKey = extractUploadResourceKey(uploadRes, 'image');
      if (!imageKey) {
        console.warn('[feishu-adapter] Image upload did not return image_key:', uploadPath);
        return this.sendAsPost(chatId, filePath);
      }

      const sendRes = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      if (sendRes?.data?.message_id) {
        return { ok: true, messageId: sendRes.data.message_id };
      }

      console.warn('[feishu-adapter] Image send failed:', sendRes?.msg, sendRes?.code);
      return this.sendAsPost(chatId, filePath);
    } catch (err) {
      console.warn('[feishu-adapter] Local image send error:', err instanceof Error ? err.message : err);
      return this.sendAsPost(chatId, filePath);
    } finally {
      if (uploadPath !== filePath) {
        try {
          fs.unlinkSync(uploadPath);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  private prepareUploadableImagePath(filePath: string): string {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= MAX_IMAGE_UPLOAD_SIZE) {
        return filePath;
      }
    } catch {
      return filePath;
    }

    if (process.platform !== 'darwin') {
      return filePath;
    }

    const ext = path.extname(filePath).toLowerCase();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-image-'));

    try {
      for (const dimension of IMAGE_MAX_DIMENSIONS) {
        for (const quality of IMAGE_COMPRESSION_QUALITIES) {
          const candidatePath = path.join(
            tmpDir,
            `${path.basename(filePath, ext)}-${dimension ?? 'full'}-${quality}.jpg`,
          );
          const args = ['-s', 'format', 'jpeg', '--setProperty', 'formatOptions', String(quality), filePath];
          if (dimension) {
            args.unshift('-Z', String(dimension));
          }
          args.push('--out', candidatePath);

          try {
            execFileSync('sips', args, { stdio: 'ignore' });
            const candidateStat = fs.statSync(candidatePath);
            if (candidateStat.size > 0 && candidateStat.size <= MAX_IMAGE_UPLOAD_SIZE) {
              return candidatePath;
            }
          } catch {
            // try the next quality/size pair
          }
        }
      }
    } catch {
      return filePath;
    }

    return filePath;
  }

  /**
   * Upload a local file to Feishu and send it as a file message.
   */
  private async sendLocalFile(chatId: string, filePath: string): Promise<SendResult> {
    try {
      const fileName = path.basename(filePath);
      const fileType = FEISHU_FILE_TYPE_BY_EXT[path.extname(fileName).toLowerCase()] || 'stream';

      const uploadRes = await this.restClient!.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });

      const fileKey = extractUploadResourceKey(uploadRes, 'file');
      if (!fileKey) {
        console.warn('[feishu-adapter] File upload did not return file_key:', filePath);
        return this.sendAsPost(chatId, filePath);
      }

      const sendRes = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      if (sendRes?.data?.message_id) {
        return { ok: true, messageId: sendRes.data.message_id };
      }

      console.warn('[feishu-adapter] File send failed:', sendRes?.msg, sendRes?.code);
      return this.sendAsPost(chatId, filePath);
    } catch (err) {
      console.warn('[feishu-adapter] Local file send error:', err instanceof Error ? err.message : err);
      return this.sendAsPost(chatId, filePath);
    }
  }

  // ── Permission card (with real action buttons) ─────────────

  /**
   * Send a permission card with real Feishu card action buttons.
   * Button clicks trigger card.action.trigger events handled by handleCardActionEvent().
   * Feishu card action callbacks require HTTP webhook (not supported via WSClient).
   * CodePilot is a desktop app without a public endpoint, so we send a
   * well-formatted card with /perm text commands instead of clickable buttons.
   * The user replies with the /perm command to approve/deny.
   */
  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../types.js').InlineButton[][],
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    // Build /perm command lines from inline buttons
    const permCommands = inlineButtons.flat().map((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        const action = parts[1];
        const permId = parts.slice(2).join(':');
        return `\`/perm ${action} ${permId}\``;
      }
      return btn.text;
    });

    // Schema 2.0 card with markdown — permission info + shortcut/command options
    const cardContent = [
      text,
      '',
      '---',
      '**Reply:**',
      '`1` - Allow once',
      '`2` - Allow session',
      '`3` - Deny',
      '',
      'Or use full commands:',
      ...permCommands,
    ].join('\n');

    const cardJson = JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🔐 Permission Required' },
      },
      body: {
        elements: [
          { tag: 'markdown', content: cardContent },
        ],
      },
    });

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson,
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Permission card send failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu-adapter] Permission card error:', err instanceof Error ? err.message : err);
    }

    // Fallback: plain text
    const plainCommands = inlineButtons.flat().map((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        return `/perm ${parts[1]} ${parts.slice(2).join(':')}`;
      }
      return btn.text;
    });
    const fallbackText = text + '\n\nReply:\n1 - Allow once\n2 - Allow session\n3 - Deny\n\nOr use full command:\n' + plainCommands.join('\n');

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: fallbackText }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = getBridgeContext().store.getSetting('bridge_feishu_enabled');
    if (enabled !== 'true') return 'bridge_feishu_enabled is not true';

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id');
    if (!appId) return 'bridge_feishu_app_id not configured';

    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret');
    if (!appSecret) return 'bridge_feishu_app_secret not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_feishu_allowed_users') || '';
    if (!allowedUsers) {
      // No restriction configured — allow all
      return true;
    }

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ──────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    this.lastInboundAt = Date.now();
    this.persistHealth();
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      console.error(
        '[feishu-adapter] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async startWsClient(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
    dispatcher: lark.EventDispatcher,
  ): Promise<void> {
    const logger = this.createWsLogger();
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
      logger,
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  private createWsLogger(): {
    trace: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  } {
    return {
      trace: (...args: unknown[]) => console.debug(...args),
      debug: (...args: unknown[]) => console.debug(...args),
      info: (...args: unknown[]) => {
        this.observeWsLog(args);
        console.info(...args);
      },
      warn: (...args: unknown[]) => console.warn(...args),
      error: (...args: unknown[]) => {
        this.observeWsLog(args);
        console.error(...args);
      },
    };
  }

  private observeWsLog(args: unknown[]): void {
    const flattened = args
      .flatMap((arg) => Array.isArray(arg) ? arg : [arg])
      .map((arg) => typeof arg === 'string' ? arg : String(arg))
      .join(' ');

    if (flattened.includes('ws client ready')) {
      this.wsReadyAt = Date.now();
      this.reconnectTimestamps = [];
      this.clearReconnectWatchdog();
      this.wsState = 'ready';
      this.lastWatchdogReason = null;
      this.persistHealth();
      return;
    }

    if (flattened.includes('reconnect')) {
      const now = Date.now();
      this.lastReconnectAt = now;
      this.reconnectTimestamps.push(now);
      this.reconnectTimestamps = this.reconnectTimestamps.filter(
        (ts) => now - ts <= WS_RECONNECT_BURST_WINDOW_MS,
      );
      this.wsState = 'reconnecting';
      this.persistHealth();

      this.scheduleReconnectWatchdog();

      if (this.reconnectTimestamps.length >= WS_RECONNECT_BURST_THRESHOLD) {
        void this.restartWsClient('too_many_reconnects');
      }
      return;
    }

    if (flattened.includes('connect failed')) {
      this.wsState = 'reconnecting';
      this.persistHealth();
      this.scheduleReconnectWatchdog();
    }
  }

  private scheduleReconnectWatchdog(): void {
    this.clearReconnectWatchdog();
    this.reconnectWatchdogTimer = setTimeout(() => {
      if (!this.running) return;
      if (this.wsReadyAt >= this.lastReconnectAt) return;
      if (Date.now() - this.lastWatchdogRestartAt < WS_RESTART_COOLDOWN_MS) return;
      void this.restartWsClient('reconnect_stuck');
    }, WS_STUCK_RECONNECT_MS);
  }

  private clearReconnectWatchdog(): void {
    if (this.reconnectWatchdogTimer) {
      clearTimeout(this.reconnectWatchdogTimer);
      this.reconnectWatchdogTimer = null;
    }
  }

  private async restartWsClient(reason: string): Promise<void> {
    if (!this.running || this.wsRestartInFlight) return;
    if (Date.now() - this.lastWatchdogRestartAt < WS_RESTART_COOLDOWN_MS) return;
    this.wsRestartInFlight = true;

    try {
      const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
      const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret') || '';
      const domainSetting = getBridgeContext().store.getSetting('bridge_feishu_domain') || 'feishu';
      const domain = domainSetting === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

      console.warn(
        '[feishu-adapter] Rebuilding WS client:',
        reason,
        `(last ready=${this.wsReadyAt || 0}, last reconnect=${this.lastReconnectAt || 0}, last inbound=${this.lastInboundAt || 0})`,
      );

      this.clearReconnectWatchdog();
      this.watchdogRestartCount += 1;
      this.lastWatchdogRestartAt = Date.now();
      this.lastWatchdogReason = reason;
      this.wsState = 'rebuilding';
      this.persistHealth();

      if (this.wsClient) {
        try {
          this.wsClient.close({ force: true });
        } catch (err) {
          console.warn('[feishu-adapter] WSClient force-close error during rebuild:', err instanceof Error ? err.message : err);
        }
        this.wsClient = null;
      }

      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          await this.handleIncomingEvent(data as FeishuMessageEventData);
        },
      });

      await this.startWsClient(appId, appSecret, domain, dispatcher);
    } catch (err) {
      console.error('[feishu-adapter] Failed to rebuild WS client:', err instanceof Error ? err.stack || err.message : err);
      this.wsState = 'reconnecting';
      this.persistHealth();
      this.scheduleReconnectWatchdog();
    } finally {
      this.wsRestartInFlight = false;
    }
  }

  private persistHealth(): void {
    const health: FeishuHealthSnapshot = {
      running: this.running,
      wsState: this.wsState,
      botOpenId: this.botOpenId,
      wsReadyAt: this.wsReadyAt ? new Date(this.wsReadyAt).toISOString() : null,
      lastInboundAt: this.lastInboundAt ? new Date(this.lastInboundAt).toISOString() : null,
      lastReconnectAt: this.lastReconnectAt ? new Date(this.lastReconnectAt).toISOString() : null,
      reconnectsLast10Min: this.reconnectTimestamps.length,
      watchdogRestarts: this.watchdogRestartCount,
      lastWatchdogReason: this.lastWatchdogReason,
      updatedAt: new Date().toISOString(),
    };

    try {
      fs.mkdirSync(path.dirname(FEISHU_HEALTH_FILE), { recursive: true });
      const tmp = `${FEISHU_HEALTH_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(health, null, 2), 'utf-8');
      fs.renameSync(tmp, FEISHU_HEALTH_FILE);
    } catch (err) {
      console.warn('[feishu-adapter] Failed to persist health snapshot:', err instanceof Error ? err.message : err);
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // [P1] Filter out bot messages to prevent self-triggering loops
    if (sender.sender_type === 'bot') return;

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    // Group chat policy
    if (isGroup) {
      const policy = getBridgeContext().store.getSetting('bridge_feishu_group_policy') || 'open';

      if (policy === 'disabled') {
        console.log('[feishu-adapter] Group message ignored (policy=disabled), chatId:', chatId);
        return;
      }

      if (policy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_feishu_group_allow_from') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!allowedGroups.includes(chatId)) {
          console.log('[feishu-adapter] Group message ignored (not in allowlist), chatId:', chatId);
          return;
        }
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_feishu_require_mention') !== 'false';
      if (requireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
        try {
          getBridgeContext().store.insertAuditLog({
            channelType: 'feishu',
            chatId,
            direction: 'inbound',
            messageId: msg.message_id,
            summary: '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)',
          });
        } catch { /* best effort */ }
        return;
      }
    }

    // Track last message ID per chat for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      // [P1] Download image with failure fallback
      console.log('[feishu-adapter] Image message received, content:', msg.content);
      const fileKey = this.extractFileKey(msg.content);
      console.log('[feishu-adapter] Extracted fileKey:', fileKey);
      if (fileKey) {
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image');
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] Image download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      // [P2] Support file/audio/video/media downloads
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType);
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = `[${messageType} download failed]`;
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] ${messageType} download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'post') {
      // [P2] Extract text and image keys from rich text (post) messages
      const { extractedText, imageKeys } = this.parsePostContent(msg.content);
      text = extractedText;
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment) {
          attachments.push(attachment);
        }
        // Don't add fallback text for individual post images — the text already carries context
      }
    } else {
      // Unsupported type — log and skip
      console.log(`[feishu-adapter] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      return;
    }

    // Strip @mention markers from text
    text = this.stripMentionMarkers(text);

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();
    const address = {
      channelType: 'feishu' as const,
      chatId,
      userId,
    };

    // [P1] Check for /perm text command (permission approval fallback)
    const trimmedText = text.trim();
    if (
      messageType === 'text'
      && trimmedText
      && !trimmedText.startsWith('/')
      && this.isLikelyReplayText(chatId, trimmedText, msg.message_id)
    ) {
      console.warn('[feishu-adapter] Dropping suspected replayed text message:', chatId, msg.message_id, trimmedText.slice(0, 120));
      try {
        getBridgeContext().store.insertAuditLog({
          channelType: 'feishu',
          chatId,
          direction: 'inbound',
          messageId: msg.message_id,
          summary: `[FILTERED] Suspected replayed text after reconnect: ${trimmedText.slice(0, 180)}`,
        });
      } catch { /* best effort */ }
      return;
    }

    if (messageType === 'text' && trimmedText && !trimmedText.startsWith('/')) {
      this.rememberInboundText(chatId, trimmedText, msg.message_id);
    }

    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      // /perm <action> <permId>
      if (permParts.length >= 3) {
        const action = permParts[1]; // allow / allow_session / deny
        const permId = permParts.slice(2).join(' ');
        const callbackData = `perm:${action}:${permId}`;

        const inbound: InboundMessage = {
          messageId: msg.message_id,
          address,
          text: trimmedText,
          timestamp,
          callbackData,
        };
        this.enqueue(inbound);
        return;
      }
    }

    const inbound: InboundMessage = {
      messageId: msg.message_id,
      address,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'feishu',
        chatId,
        direction: 'inbound',
        messageId: msg.message_id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // ── Content parsing ─────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  /**
   * Extract file key from message content JSON.
   * Handles multiple key names: image_key, file_key, imageKey, fileKey.
   */
  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse rich text (post) content.
   * Extracts plain text from text elements and image keys from img elements.
   */
  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      // Post content structure: { title, content: [[{tag, text/image_key}]] }
      const title = parsed.title;
      if (title) textParts.push(title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'at' && element.user_id) {
              // Mention in post — handled by isBotMentioned for group policy
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch {
      // Failed to parse post content
    }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  // ── Bot identity ────────────────────────────────────────────

  /**
   * Resolve bot identity via the Feishu REST API /bot/v3/info/.
   * Collects all available bot IDs for comprehensive mention matching.
   */
  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu-adapter] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      // Also record app_id-based IDs if available
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu-adapter] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn(
        '[feishu-adapter] Failed to resolve bot identity:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── @Mention detection ──────────────────────────────────────

  /**
   * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
   */
  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    // Feishu uses @_user_N placeholders for mentions
    return text.replace(/@_user_\d+/g, '').trim();
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video) via SDK.
   * Returns null on failure (caller decides fallback behavior).
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      console.log(`[feishu-adapter] Downloading resource: type=${resourceType}, key=${fileKey}, msgId=${messageId}`);

      const res = await this.restClient.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType === 'image' ? 'image' : 'file',
        },
      });

      if (!res) {
        console.warn('[feishu-adapter] messageResource.get returned null/undefined');
        return null;
      }

      // SDK returns { writeFile, getReadableStream, headers }
      // Try stream approach first, fall back to writeFile + read if stream fails
      let buffer: Buffer;

      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;

        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        // Stream approach failed — fall back to writeFile + read
        console.warn('[feishu-adapter] Stream read failed, falling back to writeFile:', streamErr instanceof Error ? streamErr.message : streamErr);

        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        return null;
      }

      const base64 = buffer.toString('base64');
      const id = crypto.randomUUID();
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}`);

      return {
        id,
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu-adapter] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.stack || err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);

    // LRU eviction: remove oldest entries when exceeding limit
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }

  private normalizeReplayText(text: string): string {
    return text
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private rememberInboundText(chatId: string, text: string, messageId: string): void {
    const now = Date.now();
    const key = `${chatId}::${this.normalizeReplayText(text)}`;
    this.recentInboundTexts.set(key, { at: now, messageId });

    for (const [entryKey, entry] of this.recentInboundTexts.entries()) {
      if (now - entry.at > INBOUND_TEXT_REPLAY_WINDOW_MS) {
        this.recentInboundTexts.delete(entryKey);
      }
    }
  }

  private isLikelyReplayText(chatId: string, text: string, messageId: string): boolean {
    const now = Date.now();
    if (!this.lastReconnectAt || now - this.lastReconnectAt > RECONNECT_REPLAY_GUARD_WINDOW_MS) {
      return false;
    }

    const key = `${chatId}::${this.normalizeReplayText(text)}`;
    const prior = this.recentInboundTexts.get(key);
    if (!prior) return false;
    if (prior.messageId === messageId) return false;
    return now - prior.at <= INBOUND_TEXT_REPLAY_WINDOW_MS;
  }
}

function extractUploadResourceKey(response: unknown, kind: 'image' | 'file'): string | null {
  if (!response || typeof response !== 'object') return null;
  const keyName = kind === 'image' ? 'image_key' : 'file_key';
  const camelName = kind === 'image' ? 'imageKey' : 'fileKey';
  const topLevel = response as Record<string, unknown>;
  const nested = topLevel.data && typeof topLevel.data === 'object'
    ? topLevel.data as Record<string, unknown>
    : null;
  const raw = topLevel[keyName] ?? topLevel[camelName] ?? nested?.[keyName] ?? nested?.[camelName];
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

// Self-register so bridge-manager can create FeishuAdapter via the registry.
registerAdapterFactory('feishu', () => new FeishuAdapter());
