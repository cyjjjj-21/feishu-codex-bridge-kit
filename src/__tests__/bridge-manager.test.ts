import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _testOnly } from '../../node_modules/claude-to-im/src/lib/bridge/bridge-manager.js';

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

describe('bridge-manager timeout policy', () => {
  it('keeps default timeout for ordinary text tasks', () => {
    const ms = _testOnly.computeTaskTimeoutMs({
      rawText: 'hello',
      effectiveText: 'hello',
      hasImageAttachments: false,
      defaultTimeoutMs: 600_000,
    });

    assert.equal(ms, 600_000);
  });

  it('extends timeout for render-heavy visual tasks', () => {
    const ms = _testOnly.computeTaskTimeoutMs({
      rawText: '你能不能直接搞个SVG,然后在网页里打开,直接截图发过来',
      effectiveText: '你能不能直接搞个SVG,然后在网页里打开,直接截图发过来',
      hasImageAttachments: false,
      defaultTimeoutMs: 600_000,
    });

    assert.equal(ms, 1_200_000);
  });

  it('extends timeout for image-edit tasks with attachments', () => {
    const ms = _testOnly.computeTaskTimeoutMs({
      rawText: '把照片左下角的水印去掉,再把去掉水印之后的照片发给我',
      effectiveText: '把照片左下角的水印去掉,再把去掉水印之后的照片发给我',
      hasImageAttachments: true,
      defaultTimeoutMs: 600_000,
    });

    assert.equal(ms, 1_200_000);
  });
});

describe('bridge-manager restart command helpers', () => {
  it('includes /bridge-restart in help output', () => {
    const lines = _testOnly.getCommandHelpLines();

    assert.ok(lines.some((line: string) => line.includes('/bridge-restart')));
  });

  it('builds a detached daemon restart plan that stops then starts the bridge', () => {
    const plan = _testOnly.buildBridgeRestartPlan({
      daemonScriptPath: '/tmp/daemon.sh',
      ctiHome: '/tmp/cti-home',
      platform: 'linux',
    });

    assert.equal(plan.command, '/bin/bash');
    assert.deepEqual(plan.args.slice(0, 1), ['-lc']);
    assert.match(plan.args[1], /sleep 1/);
    assert.match(plan.args[1], /CTI_HOME="\/tmp\/cti-home" bash "\/tmp\/daemon\.sh" stop/);
    assert.match(plan.args[1], /CTI_HOME="\/tmp\/cti-home" bash "\/tmp\/daemon\.sh" start/);
    assert.equal(plan.options.detached, true);
    assert.equal(plan.options.stdio, 'ignore');
  });

  it('uses launchctl kickstart on macOS so restart survives its own bootout', () => {
    const plan = _testOnly.buildBridgeRestartPlan({
      platform: 'darwin',
      launchdLabel: 'com.claude-to-im.bridge',
      uid: 501,
    });

    assert.equal(plan.command, '/bin/launchctl');
    assert.deepEqual(plan.args, ['kickstart', '-k', 'gui/501/com.claude-to-im.bridge']);
    assert.equal(plan.options.detached, true);
    assert.equal(plan.options.stdio, 'ignore');
  });

  it('persists and reloads a pending restart notice in runtime storage', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-restart-'));
    const target = _testOnly.getBridgeRestartNoticePath(tmpHome);

    _testOnly.persistPendingBridgeRestartNotice({
      channelType: 'feishu',
      chatId: 'oc_test_chat',
    }, tmpHome);

    assert.equal(fs.existsSync(target), true);
    const notice = _testOnly.readPendingBridgeRestartNotice(tmpHome);
    assert.deepEqual(notice && {
      channelType: notice.channelType,
      chatId: notice.chatId,
    }, {
      channelType: 'feishu',
      chatId: 'oc_test_chat',
    });

    _testOnly.clearPendingBridgeRestartNotice(tmpHome);
    assert.equal(fs.existsSync(target), false);
  });

  it('formats a fixed restart completion message with pid', () => {
    assert.equal(
      _testOnly.formatBridgeRestartCompletedMessage(84092),
      'bridge 已更新，新的 PID 是 84092，请继续和我交流。',
    );
  });

  it('formats a concise restart start message', () => {
    assert.equal(
      _testOnly.formatBridgeRestartStartedMessage(),
      '收到，正在重启 bridge。稍后我会主动告诉你新的 PID。',
    );
  });

  it('recognizes short restart status pings but not real follow-up tasks', () => {
    assert.equal(_testOnly.isRestartStatusQuery('你还在吗'), true);
    assert.equal(_testOnly.isRestartStatusQuery('在吗'), true);
    assert.equal(_testOnly.isRestartStatusQuery('hello'), true);
    assert.equal(_testOnly.isRestartStatusQuery('帮我继续改刚才那个图'), false);
  });
});

describe('bridge-manager Feishu final delivery shaping', () => {
  it('sends only the unsent tail plus extracted attachments after segmented preview', () => {
    const screenshotName = `bridge-preview-${Date.now()}.png`;
    const screenshotPath = path.join(os.homedir(), 'Desktop', screenshotName);
    tempArtifacts.push(screenshotPath);
    fs.writeFileSync(screenshotPath, 'fake png payload');

    const shaped = _testOnly.buildFeishuFinalDeliveryPayload(
      `第一段\n第二段\n截图已经拿到了，保存在桌面：\n${screenshotName}\n图里是一只猫。`,
      '第一段\n第二段',
    );

    assert.deepEqual(shaped.attachments, [{ path: screenshotPath, kind: 'image' }]);
    assert.equal(shaped.text, '截图已经拿到了，保存在桌面：\n图里是一只猫。');
  });

  it('extracts inline markdown screenshot links after common Chinese labels', () => {
    const screenshotName = `bridge-inline-${Date.now()}.png`;
    const screenshotPath = path.join(os.homedir(), 'Desktop', screenshotName);
    tempArtifacts.push(screenshotPath);
    fs.writeFileSync(screenshotPath, 'fake png payload');

    const shaped = _testOnly.buildFeishuFinalDeliveryPayload(
      `最新截图已经拿到，文件在这里：[${screenshotName}](${screenshotPath})\n\n图里是 FaceTime 的预览视图。`,
      '我会重新抓一张最新的 FaceTime 预览图。',
    );

    assert.deepEqual(shaped.attachments, [{ path: screenshotPath, kind: 'image' }]);
    assert.equal(shaped.text, '图里是 FaceTime 的预览视图。');
  });

  it('formats a fixed streaming completion marker', () => {
    assert.equal(
      _testOnly.formatStreamingCompletionMessage(),
      '本轮内容已全部生成，等待你的回复。',
    );
  });
});
