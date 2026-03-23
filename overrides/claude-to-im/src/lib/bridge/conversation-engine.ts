/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding } from './types.js';
import type {
  FileAttachment,
  SSEEvent,
  TokenUsage,
  MessageContentBlock,
} from './host.js';
import { getBridgeContext } from './context.js';
import crypto from 'crypto';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

export interface ProgressUpdateInfo {
  kind: 'status' | 'task';
  text: string;
  raw?: unknown;
}

/** Callback invoked on non-text progress updates during streaming. */
export type OnProgressUpdate = (update: ProgressUpdateInfo) => void;

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
}

function sanitizeAttachmentName(name: string): string {
  const base = path.basename(name || 'attachment');
  return base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
}

function prepareFileAttachments(
  files: FileAttachment[] | undefined,
  workDir: string,
): {
  preparedFiles: FileAttachment[];
  fileMeta: Array<{ id: string; name: string; type: string; size: number; filePath: string }>;
} {
  if (!files || files.length === 0 || !workDir) {
    return { preparedFiles: files || [], fileMeta: [] };
  }

  const uploadDir = path.join(workDir, '.codepilot-uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const preparedFiles: FileAttachment[] = [];
  const fileMeta: Array<{ id: string; name: string; type: string; size: number; filePath: string }> = [];

  for (const file of files) {
    let filePath = file.filePath;
    let size = file.size;

    if (!filePath || !fs.existsSync(filePath)) {
      const safeName = sanitizeAttachmentName(file.name);
      filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
      const buffer = Buffer.from(file.data, 'base64');
      fs.writeFileSync(filePath, buffer);
      size = buffer.length;
    } else if (!size || size <= 0) {
      try {
        size = fs.statSync(filePath).size;
      } catch {
        size = file.size;
      }
    }

    preparedFiles.push({ ...file, filePath, size });
    fileMeta.push({
      id: file.id,
      name: file.name,
      type: file.type,
      size,
      filePath,
    });
  }

  return { preparedFiles, fileMeta };
}

function buildPromptWithLocalFileHints(text: string, files: FileAttachment[]): string {
  const localPaths = files
    .filter((file) => file.type.startsWith('image/') && file.filePath)
    .map((file) => file.filePath as string);

  if (localPaths.length === 0) {
    return text;
  }

  const pathList = localPaths.map((filePath) => `- ${filePath}`).join('\n');
  const prefix = text.trim() ? `${text.trim()}\n\n` : '';
  return `${prefix}Attached local image file path(s):\n${pathList}\nYou can open or edit these local files directly if needed, and reply with the modified image path when sending the result back.`;
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onProgressUpdate?: OnProgressUpdate,
): Promise<ConversationResult> {
  const { store, llm } = getBridgeContext();
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = store.getSession(sessionId);

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    let savedContent = text;
    let promptText = text;
    let preparedFiles = files;
    if (files && files.length > 0) {
      const workDir = binding.workingDirectory || session?.working_directory || '';
      if (workDir) {
        try {
          const persisted = prepareFileAttachments(files, workDir);
          preparedFiles = persisted.preparedFiles;
          savedContent = `<!--files:${JSON.stringify(persisted.fileMeta)}-->${text}`;
          promptText = buildPromptWithLocalFileHints(text, persisted.preparedFiles);
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${text}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${text}`;
      }
    }
    store.addMessage(sessionId, 'user', savedContent);

    // Resolve provider
    let resolvedProvider: import('./host.js').BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = store.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = store.getDefaultProviderId();
      if (defaultId) resolvedProvider = store.getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = binding.model || session?.model || store.getSetting('default_model') || undefined;

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Load conversation history for context
    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const stream = llm.streamChat({
      prompt: promptText,
      sessionId,
      sdkSessionId: binding.sdkSessionId || undefined,
      model: effectiveModel,
      systemPrompt: session?.system_prompt || undefined,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      conversationHistory: historyMsgs,
      files: preparedFiles,
      onRuntimeStatusChange: (status: string) => {
        try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText, onProgressUpdate);
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

function extractStatusProgress(statusData: Record<string, unknown>): string | null {
  if (typeof statusData.progress === 'string' && statusData.progress.trim()) {
    return statusData.progress.trim();
  }
  return null;
}

function summarizeTodos(todos: unknown): string | null {
  if (!Array.isArray(todos)) return null;

  const items = todos
    .map((todo) => {
      if (!todo || typeof todo !== 'object') return null;
      const record = todo as Record<string, unknown>;
      const title = [record.content, record.title, record.text]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
      if (!title) return null;
      return { title: title.trim(), status };
    })
    .filter((item): item is { title: string; status: string } => item !== null);

  if (items.length === 0) return null;

  const active = items.find((item) =>
    item.status.includes('progress') || item.status.includes('doing') || item.status.includes('active')
  );
  if (active) {
    return `Task update: working on "${active.title}"`;
  }

  const completed = items.filter((item) => item.status.includes('complete') || item.status.includes('done')).length;
  const pending = items.filter((item) => item.status.includes('pending') || item.status.includes('todo')).length;
  if (completed > 0 || pending > 0) {
    return `Task update: ${completed} done, ${pending} pending`;
  }

  return `Task update: ${items[0].title}`;
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onProgressUpdate?: OnProgressUpdate,
): Promise<ConversationResult> {
  const { store } = getBridgeContext();
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              const toolData = JSON.parse(event.data);
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
                store.updateSdkSessionId(sessionId, statusData.session_id);
              }
              if (statusData.model) {
                store.updateSessionModel(sessionId, statusData.model);
              }
              const progressText = extractStatusProgress(statusData);
              if (progressText && onProgressUpdate) {
                try {
                  onProgressUpdate({ kind: 'status', text: progressText, raw: statusData });
                } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                store.syncSdkTasks(taskData.session_id, taskData.todos);
              }
              const taskText = summarizeTodos(taskData.todos);
              if (taskText && onProgressUpdate) {
                try {
                  onProgressUpdate({ kind: 'task', text: taskText, raw: taskData.todos });
                } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = event.data || 'Unknown error';
            break;

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error) hasError = true;
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                store.updateSdkSessionId(sessionId, resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }

          // tool_output, tool_timeout, mode_changed, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        store.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}
