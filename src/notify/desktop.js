// 通知渠道：Windows 桌面 Toast 通知（PowerShell WinRT，无额外依赖）
import { spawn } from 'node:child_process';

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildScript(title, body) {
  const template = `<toast><visual><binding template="ToastText02"><text id="1">${escapeXml(title)}</text><text id="2">${escapeXml(body)}</text></binding></visual></toast>`;
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('${template.replace(/'/g, "''")}')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\powershell.exe').Show($toast)",
  ].join('; ');
}

export async function notify(payload) {
  if (process.platform !== 'win32') return; // 非 Windows 环境跳过桌面通知
  const script = buildScript(payload.title, payload.body);
  await new Promise((resolve, reject) => {
    // -EncodedCommand 规避命令行引号转义问题（UTF-16LE base64）
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`桌面通知失败（exit ${code}）：${stderr.slice(0, 200)}`));
    });
  });
}
