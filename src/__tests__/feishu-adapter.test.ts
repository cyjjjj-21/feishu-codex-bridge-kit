import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function createMockAdapter() {
  const adapterModulePath = new URL(
    '../../node_modules/claude-to-im/src/lib/bridge/adapters/feishu-adapter.ts',
    import.meta.url,
  ).href;
  const { FeishuAdapter } = await import(adapterModulePath);
  const adapter = new FeishuAdapter();
  const messageCreates: Array<Record<string, unknown>> = [];
  const messageUpdates: Array<Record<string, unknown>> = [];
  const fileCreates: Array<Record<string, unknown>> = [];

  (adapter as unknown as { restClient: unknown }).restClient = {
    im: {
      file: {
        create: async (payload: Record<string, unknown>) => {
          fileCreates.push(payload);
          const file = (payload.data as { file?: NodeJS.ReadableStream } | undefined)?.file;
          if (file && typeof file.on === 'function') {
            await new Promise<void>((resolve, reject) => {
              file.once('error', reject);
              file.once('open', () => {
                if ('destroy' in file && typeof file.destroy === 'function') {
                  file.destroy();
                }
                resolve();
              });
            });
          }
          return { file_key: 'file-key-1' };
        },
      },
      v1: {
        image: {
          create: async (payload: Record<string, unknown>) => {
            const image = (payload.data as { image?: NodeJS.ReadableStream } | undefined)?.image;
            if (image && typeof image.on === 'function') {
              await new Promise<void>((resolve, reject) => {
                image.once('error', reject);
                image.once('open', () => {
                  if ('destroy' in image && typeof image.destroy === 'function') {
                    image.destroy();
                  }
                  resolve();
                });
              });
            }
            return { image_key: 'image-key-1' };
          },
        },
      },
      message: {
        create: async (payload: Record<string, unknown>) => {
          messageCreates.push(payload);
          return { data: { message_id: `msg-${messageCreates.length}` } };
        },
        update: async (payload: Record<string, unknown>) => {
          messageUpdates.push(payload);
          return { data: { message_id: 'msg-1' } };
        },
      },
    },
  };

  return { adapter, messageCreates, messageUpdates, fileCreates };
}

const tempArtifacts: string[] = [];

afterEach(() => {
  for (const target of tempArtifacts.splice(0)) {
    try {
      fs.unlinkSync(target);
    } catch {
      // ignore cleanup failures
    }
  }
});

describe('FeishuAdapter outbound attachments', () => {
  it('uploads a standalone labeled local file path as a file attachment', async () => {
    const tempFile = path.join(os.tmpdir(), `cti-feishu-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, 'bridge attachment test', 'utf-8');

    try {
      const { adapter, messageCreates, fileCreates } = await createMockAdapter();
      const result = await adapter.send({
        address: { channelType: 'feishu', chatId: 'chat-1' },
        text: `Bridge self-test\n\n文件路径: ${tempFile}`,
        parseMode: 'Markdown',
      });

      assert.equal(result.ok, true);
      assert.equal(fileCreates.length, 1, 'Should upload one file');
      assert.equal(messageCreates.length, 2, 'Should send one text message and one file message');

      const fileMessage = messageCreates[1] as { data?: { msg_type?: string; content?: string } };
      assert.equal(fileMessage.data?.msg_type, 'file');
      assert.equal(fileMessage.data?.content, JSON.stringify({ file_key: 'file-key-1' }));
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  it('does not treat inline markdown local links as downloadable attachments', async () => {
    const tempFile = path.join(os.tmpdir(), `cti-inline-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, 'inline link should stay text only', 'utf-8');

    try {
      const { adapter, messageCreates, fileCreates } = await createMockAdapter();
      const result = await adapter.send({
        address: { channelType: 'feishu', chatId: 'chat-2' },
        text: `See [source](${tempFile}) for details.`,
        parseMode: 'Markdown',
      });

      assert.equal(result.ok, true);
      assert.equal(fileCreates.length, 0, 'Inline links should not auto-upload files');
      assert.equal(messageCreates.length, 1, 'Should send only the formatted text message');

      const textMessage = messageCreates[0] as { data?: { msg_type?: string } };
      assert.notEqual(textMessage.data?.msg_type, 'file');
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  it('uploads a labeled inline markdown local link as a file attachment', async () => {
    const tempFile = path.join(os.tmpdir(), `cti-labeled-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, 'labeled markdown link should upload', 'utf-8');

    try {
      const { adapter, messageCreates, fileCreates } = await createMockAdapter();
      const result = await adapter.send({
        address: { channelType: 'feishu', chatId: 'chat-3' },
        text: `我先创建文件。\n文件已生成：[${tempFile}](${tempFile})`,
        parseMode: 'Markdown',
      });

      assert.equal(result.ok, true);
      assert.equal(fileCreates.length, 1, 'Should upload the linked file');
      assert.equal(messageCreates.length, 2, 'Should send one text message and one file message');

      const fileMessage = messageCreates[1] as { data?: { msg_type?: string; content?: string } };
      assert.equal(fileMessage.data?.msg_type, 'file');
      assert.equal(fileMessage.data?.content, JSON.stringify({ file_key: 'file-key-1' }));
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  it('uploads a desktop screenshot when the response only mentions the basename on its own line', async () => {
    const screenshotName = `screenshot-${Date.now()}.png`;
    const screenshotPath = path.join(os.homedir(), 'Desktop', screenshotName);
    tempArtifacts.push(screenshotPath);
    fs.writeFileSync(screenshotPath, 'fake png payload');

    const { adapter, messageCreates, fileCreates } = await createMockAdapter();
    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-screenshot' },
      text: `截图已经拿到了，保存在桌面：\n${screenshotName}\n图里是 FaceTime 的预览窗口。`,
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, true);
    assert.equal(fileCreates.length, 0, 'Image uploads should use the image endpoint, not file uploads');
    assert.equal(messageCreates.length, 2, 'Should send one text message and one image message');

    const imageMessage = messageCreates[1] as { data?: { msg_type?: string; content?: string } };
    assert.equal(imageMessage.data?.msg_type, 'image');
    assert.equal(imageMessage.data?.content, JSON.stringify({ image_key: 'image-key-1' }));
  });

  it('uploads an inline markdown screenshot link after a prose label', async () => {
    const screenshotName = `face-time-inline-${Date.now()}.png`;
    const screenshotPath = path.join(os.homedir(), 'Desktop', screenshotName);
    tempArtifacts.push(screenshotPath);
    fs.writeFileSync(screenshotPath, 'fake png payload');

    const { adapter, messageCreates, fileCreates } = await createMockAdapter();
    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-inline-screenshot' },
      text: `最新截图已经拿到，文件在这里：[${screenshotName}](${screenshotPath})\n\n图里是 FaceTime 的预览窗口。`,
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, true);
    assert.equal(fileCreates.length, 0, 'Screenshot should use image upload');
    assert.equal(messageCreates.length, 2, 'Should send one text message and one image message');

    const imageMessage = messageCreates[1] as { data?: { msg_type?: string; content?: string } };
    assert.equal(imageMessage.data?.msg_type, 'image');
    assert.equal(imageMessage.data?.content, JSON.stringify({ image_key: 'image-key-1' }));
  });

  it('accepts nested Feishu image upload responses when image_key lives under data', async () => {
    const screenshotName = `nested-image-${Date.now()}.png`;
    const screenshotPath = path.join(os.homedir(), 'Desktop', screenshotName);
    tempArtifacts.push(screenshotPath);
    fs.writeFileSync(screenshotPath, 'fake png payload');

    const { adapter, messageCreates } = await createMockAdapter();
    (adapter as unknown as { restClient: { im: { v1: { image: { create: (payload: Record<string, unknown>) => Promise<{ data: { image_key: string } }> } } } } }).restClient.im.v1.image.create = async (payload: Record<string, unknown>) => {
      const image = (payload.data as { image?: NodeJS.ReadableStream } | undefined)?.image;
      if (image && typeof image.on === 'function') {
        await new Promise<void>((resolve, reject) => {
          image.once('error', reject);
          image.once('open', () => {
            if ('destroy' in image && typeof image.destroy === 'function') {
              image.destroy();
            }
            resolve();
          });
        });
      }
      return { data: { image_key: 'image-key-2' } };
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-nested-image' },
      text: `${screenshotName}`,
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, true);
    assert.equal(messageCreates.length, 1, 'Nested image upload should still end in one image message');
    const imageMessage = messageCreates[0] as { data?: { msg_type?: string; content?: string } };
    assert.equal(imageMessage.data?.msg_type, 'image');
    assert.equal(imageMessage.data?.content, JSON.stringify({ image_key: 'image-key-2' }));
  });
});

describe('FeishuAdapter streaming preview', () => {
  it('emits segmented preview chunks as separate messages instead of updating one growing message', async () => {
    const { adapter, messageCreates, messageUpdates } = await createMockAdapter();

    const caps = adapter.getPreviewCapabilities?.('chat-preview');
    assert.deepEqual(caps, { supported: true, privateOnly: false });

    const first = await adapter.sendPreview?.('chat-preview', '第一段预览', 123);
    const second = await adapter.sendPreview?.('chat-preview', '第一段预览\n第二段预览', 123);
    const third = await adapter.sendPreview?.('chat-preview', '第一段预览\n第二段预览\n第三段预览', 123);

    assert.equal(first, 'sent');
    assert.equal(second, 'sent');
    assert.equal(third, 'sent');
    assert.equal(messageCreates.length, 3, 'Each preview delta should create a new chunk message');
    assert.equal(messageUpdates.length, 0, 'Segmented preview should not update a previously sent message');

    const [firstPayload, secondPayload, thirdPayload] = messageCreates as Array<{ data?: { msg_type?: string; content?: string } }>;
    assert.equal(firstPayload.data?.msg_type, 'post');
    assert.match(firstPayload.data?.content || '', /第一段预览/);
    assert.doesNotMatch(firstPayload.data?.content || '', /第二段预览/);
    assert.match(secondPayload.data?.content || '', /第二段预览/);
    assert.doesNotMatch(secondPayload.data?.content || '', /第一段预览/);
    assert.match(thirdPayload.data?.content || '', /第三段预览/);
  });
});
