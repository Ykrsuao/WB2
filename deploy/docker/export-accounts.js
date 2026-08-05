'use strict';

/**
 * export-accounts.js — 从本机导出 Docker 可用的账号文件。
 *
 * Docker 容器里没有 WorkBuddy 桌面会话，因此所有账号必须转为 manual
 * （携带 refreshToken，服务自动经 CodeBuddy 认证 API 刷新 accessToken）。
 *
 * 用法（在装有 WorkBuddy / 已有 accounts.json 的机器上）：
 *   node deploy/docker/export-accounts.js > data/accounts.json
 *   或
 *   node deploy/docker/export-accounts.js --out data/accounts.json
 *
 * 逻辑：
 *   - source:"manual" 账号：原样保留（已有 refreshToken）
 *   - source:"desktop" 账号：从桌面会话文件提取 refreshToken，转 manual
 */

const fs = require('fs');
const path = require('path');

// ---- 会话文件（与 lib/auth.js 相同逻辑）----
function defaultSessionPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  const authId = process.env.WORKBUDDY_AUTH_ID || 'workbuddy-desktop';
  return path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', `${authId}.info`);
}

function loadDesktopAccount(sessionPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (!raw.auth || !raw.auth.refreshToken) {
      console.error(`[export] 会话文件 ${sessionPath} 无 refreshToken，跳过 desktop 账号`);
      return null;
    }
    const nickname = (raw.account && (raw.account.nickname || raw.account.uid)) || 'desktop';
    return {
      id: 'main',
      name: nickname,
      source: 'manual',
      refreshToken: raw.auth.refreshToken,
      enabled: true,
    };
  } catch (e) {
    console.error(`[export] 读取桌面会话失败: ${e.message}`);
    return null;
  }
}

// ---- 主流程 ----
function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : null;

  const accountsFile = path.join(__dirname, '..', '..', 'accounts.json');
  const existing = [];
  if (fs.existsSync(accountsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
      if (Array.isArray(data.accounts)) existing.push(...data.accounts);
    } catch (e) {
      console.error(`[export] 解析 ${accountsFile} 失败: ${e.message}`);
    }
  }

  const out = [];
  let desktopExported = false;
  for (const acc of existing) {
    if (!acc) continue;
    if (acc.source === 'manual' && acc.refreshToken) {
      out.push({ id: acc.id, name: acc.name || acc.id, source: 'manual', refreshToken: acc.refreshToken, enabled: acc.enabled !== false });
    } else if (acc.source === 'desktop' || acc.id === 'main') {
      const conv = loadDesktopAccount(defaultSessionPath());
      if (conv) {
        // 保留原 id（main 用会话里的昵称）
        conv.id = acc.id || 'main';
        if (acc.name) conv.name = acc.name;
        out.push(conv);
        desktopExported = true;
      }
    } else {
      console.error(`[export] 跳过无法导出的账号: ${acc.id} (source=${acc.source})`);
    }
  }

  // 没有 accounts.json 时，尝试直接导出桌面账号
  if (out.length === 0) {
    const conv = loadDesktopAccount(defaultSessionPath());
    if (conv) {
      out.push(conv);
      desktopExported = true;
    }
  }

  if (out.length === 0) {
    console.error('[export] 没有可导出的账号。请先在服务里添加 manual 账号，或确认本机有 WorkBuddy 桌面登录。');
    process.exit(1);
  }

  const json = JSON.stringify({ accounts: out }, null, 2) + '\n';
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, json, 'utf8');
    console.error(`[export] 已写入 ${outFile}（${out.length} 个账号）`);
  } else {
    process.stdout.write(json);
    console.error(`[export] 共导出 ${out.length} 个 manual 账号${desktopExported ? '（含桌面账号转换）' : ''}`);
  }
}

main();
