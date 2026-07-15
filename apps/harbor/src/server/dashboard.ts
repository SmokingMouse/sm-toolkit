/**
 * 只读 Web 看板（P4）—— harbor-server GET / 直出的自包含单文件页面。
 * 决策：不引 Next.js（方案原文的标签），理由见 progress/decisions.md ——
 * P4 明确只读、写操作「按 dogfood 体感再加」，单文件已覆盖全部验收判据
 * （手机 Tailscale 打开，看 issue 看板 / run 事件回放 / 用量图），零新进程零构建。
 * 数据面全走 /api/*（Bearer token 浏览器本地存 localStorage）。
 *
 * 嵌入 JS 约定：只用字符串拼接不用模板字面量，避免与外层 TS 反引号转义纠缠。
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harbor</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #141a24; --panel2: #1a2230; --line: #232d3d;
    --text: #d7e0ea; --dim: #7d8a9c; --accent: #4cc2ff;
    --backlog: #8a97a8; --doing: #4cc2ff; --review: #ffb454; --done: #7fd88f; --canceled: #f07178;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .12em; }
  header h1 b { color: var(--accent); }
  nav { display: flex; gap: 4px; }
  nav button { background: none; border: 1px solid transparent; color: var(--dim); padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  nav button.on { color: var(--text); border-color: var(--line); background: var(--panel); }
  #conn { margin-left: auto; font-size: 12px; color: var(--dim); }
  #conn .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--canceled); margin-right: 6px; }
  #conn.ok .dot { background: var(--done); }
  #tokenBtn { background: var(--panel); border: 1px solid var(--line); color: var(--dim); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  main { padding: 16px; }
  .muted { color: var(--dim); }
  .mono { font-family: var(--mono); font-size: 12px; }

  /* kanban */
  #board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(240px, 1fr); gap: 12px; overflow-x: auto; align-items: start; padding-bottom: 8px; }
  .col { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; min-height: 120px; }
  .col h3 { margin: 0; padding: 10px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; display: flex; justify-content: space-between; border-bottom: 1px solid var(--line); }
  .col .cards { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .card { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 10px; cursor: pointer; }
  .card:hover { border-color: var(--accent); }
  .card .t { font-size: 13px; margin-bottom: 6px; word-break: break-all; }
  .card .m { font-size: 11px; color: var(--dim); display: flex; gap: 8px; flex-wrap: wrap; }
  .s-backlog { color: var(--backlog); } .s-doing { color: var(--doing); } .s-review { color: var(--review); }
  .s-done { color: var(--done); } .s-canceled { color: var(--canceled); }
  .s-open { color: var(--doing); }
  .s-queued { color: var(--backlog); } .s-running { color: var(--doing); } .s-succeeded { color: var(--done); } .s-failed { color: var(--canceled); }

  /* drawer */
  #drawer { position: fixed; inset: 0; background: rgba(4,6,10,.6); display: none; z-index: 10; }
  #drawer.on { display: block; }
  #drawer .panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(680px, 100%); background: var(--bg); border-left: 1px solid var(--line); overflow-y: auto; padding: 16px; }
  #drawer .close { float: right; background: none; border: none; color: var(--dim); font-size: 20px; cursor: pointer; }
  .runrow { display: flex; gap: 10px; align-items: baseline; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; margin-top: 8px; cursor: pointer; flex-wrap: wrap; }
  .runrow:hover { border-color: var(--accent); }
  #replay { background: #05070b; border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-top: 12px; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 50vh; overflow-y: auto; }
  #replay .tool { color: var(--dim); }
  #replay .think { color: #5b6a7d; font-style: italic; }
  #replay .err { color: var(--canceled); }
  #replay .meta { color: var(--review); }
  .timeline { font-size: 12px; color: var(--dim); margin-top: 10px; }

  /* usage */
  #usageChart { width: 100%; height: 180px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--dim); font-weight: 500; font-size: 12px; }
  td.num, th.num { text-align: right; font-family: var(--mono); font-size: 12px; }

  /* token modal */
  #tokenModal { position: fixed; inset: 0; background: rgba(4,6,10,.8); display: none; z-index: 20; align-items: center; justify-content: center; }
  #tokenModal.on { display: flex; }
  #tokenModal .box { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; width: min(420px, 90%); }
  #tokenModal input { width: 100%; margin: 12px 0; padding: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-family: var(--mono); }
  #tokenModal button { background: var(--accent); color: #04121c; border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-weight: 600; }
  .strip { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; font-size: 12px; }
  .chip { background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; color: var(--dim); }
  .chip b { color: var(--text); font-weight: 500; }
</style>
</head>
<body>
<header>
  <h1><b>⚓</b> HARBOR</h1>
  <nav>
    <button id="tabBoard" class="on">看板</button>
    <button id="tabUsage">用量</button>
  </nav>
  <span id="conn"><span class="dot"></span><span id="connText">未连接</span></span>
  <button id="tokenBtn">token</button>
</header>
<main>
  <div class="strip" id="strip"></div>
  <section id="viewBoard"><div id="board"></div></section>
  <section id="viewUsage" style="display:none">
    <svg id="usageChart" preserveAspectRatio="none"></svg>
    <div id="usageTable"></div>
  </section>
</main>

<div id="drawer"><div class="panel" id="drawerBody"></div></div>
<div id="tokenModal"><div class="box">
  <div>输入 <span class="mono">HARBOR_TOKEN</span>（仅存浏览器 localStorage）</div>
  <input id="tokenInput" type="password" placeholder="token">
  <button id="tokenSave">保存</button>
</div></div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var token = localStorage.getItem('harbor_token') || '';
  var ISSUE_COLS = ['backlog', 'doing', 'review', 'done', 'canceled'];

  function api(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) {
      if (r.status === 401) { showToken(); throw new Error('unauthorized'); }
      if (!r.ok) return r.json().then(function (b) { throw new Error(b.error || r.statusText); });
      return r.json();
    });
  }

  function showToken() { $('tokenModal').classList.add('on'); $('tokenInput').focus(); }
  $('tokenBtn').onclick = showToken;
  $('tokenSave').onclick = function () {
    token = $('tokenInput').value.trim();
    localStorage.setItem('harbor_token', token);
    $('tokenModal').classList.remove('on');
    refresh();
  };
  $('tokenInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('tokenSave').onclick(); });

  // tabs
  $('tabBoard').onclick = function () { setTab('Board'); };
  $('tabUsage').onclick = function () { setTab('Usage'); loadUsage(); };
  function setTab(t) {
    $('viewBoard').style.display = t === 'Board' ? '' : 'none';
    $('viewUsage').style.display = t === 'Usage' ? '' : 'none';
    $('tabBoard').classList.toggle('on', t === 'Board');
    $('tabUsage').classList.toggle('on', t === 'Usage');
  }

  function ago(ts) {
    if (!ts) return '-';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's前';
    if (s < 3600) return Math.round(s / 60) + 'm前';
    if (s < 86400) return Math.round(s / 3600) + 'h前';
    return Math.round(s / 86400) + 'd前';
  }

  // ── strip（设备/agent 概览） ──
  function loadStrip() {
    Promise.all([api('/api/devices'), api('/api/agents')]).then(function (rs) {
      var html = rs[0].map(function (d) {
        return '<span class="chip"><b>' + esc(d.name) + '</b> ' + (d.online ? '🟢' : '⚫️') + '</span>';
      }).join('') + rs[1].map(function (a) {
        return '<span class="chip">' + esc(a.name) + ' <span class="mono">' + esc(a.model || '默认') + '</span></span>';
      }).join('');
      $('strip').innerHTML = html;
      setConn(true);
    }).catch(function () { setConn(false); });
  }
  function setConn(ok) {
    $('conn').classList.toggle('ok', ok);
    $('connText').textContent = ok ? 'server 已连接' : '连接失败';
  }

  // ── kanban ──
  function loadBoard() {
    api('/api/conversations?kind=issue').then(function (convs) {
      var byStatus = {};
      ISSUE_COLS.forEach(function (s) { byStatus[s] = []; });
      convs.forEach(function (c) { (byStatus[c.status] = byStatus[c.status] || []).push(c); });
      $('board').innerHTML = ISSUE_COLS.map(function (s) {
        var cards = (byStatus[s] || []).map(function (c) {
          return '<div class="card" data-id="' + esc(c.id) + '">' +
            '<div class="t">' + esc(c.title || '(无标题)') + '</div>' +
            '<div class="m"><span>' + esc(c.agentName || '') + '</span><span>' + ago(c.updatedAt) + '</span><span class="mono">' + esc(c.id) + '</span></div></div>';
        }).join('');
        return '<div class="col"><h3><span class="s-' + s + '">' + s + '</span><span class="muted">' + (byStatus[s] || []).length + '</span></h3><div class="cards">' + (cards || '<div class="muted" style="padding:6px">—</div>') + '</div></div>';
      }).join('');
    }).catch(function () {});
  }
  // 事件委托：10s 自动刷新会重建卡片 DOM，逐卡绑定会在刷新瞬间丢点击
  $('board').addEventListener('click', function (e) {
    var card = e.target.closest('.card');
    if (card) openIssue(card.getAttribute('data-id'));
  });

  // ── issue drawer ──
  function openIssue(id) {
    api('/api/conversations/' + id).then(function (d) {
      var c = d.conversation;
      var runs = d.runs.map(function (r) {
        var cost = r.cost && r.cost.usd != null ? '$' + r.cost.usd.toFixed(4) : '';
        return '<div class="runrow" data-run="' + esc(r.id) + '">' +
          '<span class="mono">' + esc(r.id) + '</span>' +
          '<span class="s-' + esc(r.status) + '">' + esc(r.status) + '</span>' +
          '<span class="muted">' + ago(r.queuedAt) + '</span>' +
          '<span class="mono muted">' + esc(cost) + '</span>' +
          '<span class="muted" style="flex-basis:100%">' + esc((r.error || r.prompt || '').slice(0, 90)) + '</span></div>';
      }).join('');
      var timeline = (d.statusLog || []).map(function (l) {
        return (l.fromStatus || '·') + ' → ' + l.toStatus + ' <span class="muted">(' + l.actor + ', ' + ago(l.ts) + ')</span>';
      }).join('<br>');
      $('drawerBody').innerHTML =
        '<button class="close" id="drawerClose">×</button>' +
        '<h2 style="margin:4px 0 2px;font-size:16px">' + esc(c.title || '(无标题)') + '</h2>' +
        '<div class="muted mono">' + esc(c.id) + ' · ' + c.kind + ' · <span class="s-' + esc(c.status) + '">' + esc(c.status) + '</span>' +
        ' · agent ' + esc(d.agent ? d.agent.name : c.agentId) + (c.worktreePath ? ' · worktree' : '') + '</div>' +
        (timeline ? '<div class="timeline">' + timeline + '</div>' : '') +
        '<h3 style="margin:16px 0 4px;font-size:13px" class="muted">RUNS（点击回放事件流）</h3>' + (runs || '<div class="muted">无</div>') +
        '<div id="replay" style="display:none"></div>';
      $('drawer').classList.add('on');
      $('drawerClose').onclick = closeDrawer;
      $('drawerBody').querySelectorAll('.runrow').forEach(function (el) {
        el.onclick = function () { replayRun(el.getAttribute('data-run')); };
      });
    }).catch(function (e) { alert(e.message); });
  }
  function closeDrawer() { $('drawer').classList.remove('on'); if (replayAbort) replayAbort.abort(); }
  $('drawer').onclick = function (e) { if (e.target === $('drawer')) closeDrawer(); };

  // ── run 事件回放（fetch 流式读 SSE，支持进行中直播） ──
  var replayAbort = null;
  function replayRun(runId) {
    if (replayAbort) replayAbort.abort();
    replayAbort = new AbortController();
    var box = $('replay');
    box.style.display = '';
    box.innerHTML = '<span class="muted">回放 ' + esc(runId) + ' …</span>\\n';
    fetch('/api/runs/' + runId + '/events', {
      headers: { Authorization: 'Bearer ' + token },
      signal: replayAbort.signal,
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\\n\\n')) >= 0) {
            var chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            chunk.split('\\n').forEach(function (line) {
              if (line.indexOf('data: ') === 0) renderFrame(JSON.parse(line.slice(6)), box);
            });
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {});
  }
  function appendHtml(box, html) {
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.insertAdjacentHTML('beforeend', html);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  function renderFrame(f, box) {
    if (f.kind === 'done') {
      var r = f.run;
      appendHtml(box, '\\n<span class="meta">── ' + r.status + (r.cost && r.cost.usd != null ? ' · $' + r.cost.usd.toFixed(4) : '') + (r.error ? ' · ' + esc(r.error) : '') + '</span>');
      return;
    }
    if (f.kind === 'approval') {
      appendHtml(box, '\\n<span class="meta">⏸ 等待工具授权 ' + esc(f.approval.id) + '：' + esc(f.approval.toolName) + '</span>\\n');
      return;
    }
    if (f.kind === 'approval_decided') {
      appendHtml(box, '<span class="meta">▶ 审批 ' + esc(f.approvalId) + ' → ' + esc(f.status) + '</span>\\n');
      return;
    }
    var ev = f.event;
    if (ev.type === 'text_chunk') appendHtml(box, esc(ev.data.text));
    else if (ev.type === 'thinking') appendHtml(box, '<span class="think">' + esc(ev.data.text) + '</span>');
    else if (ev.type === 'tool_call') appendHtml(box, '\\n<span class="tool">⚙ ' + esc(ev.data.name) + ' ' + esc(JSON.stringify(ev.data.input || {}).slice(0, 120)) + '</span>\\n');
    else if (ev.type === 'error') appendHtml(box, '\\n<span class="err">✗ ' + esc(ev.data.message) + '</span>\\n');
    else if (ev.type === 'session_start') appendHtml(box, '<span class="muted">◈ session ' + esc((ev.sessionId || '').slice(0, 8)) + ' · ' + esc(ev.data.model || '') + '</span>\\n');
  }

  // ── usage ──
  function loadUsage() {
    api('/api/usage?days=14').then(function (rows) {
      var byDay = {};
      rows.forEach(function (r) { byDay[r.day] = (byDay[r.day] || 0) + r.usd; });
      var days = Object.keys(byDay).sort();
      drawChart(days, days.map(function (d) { return byDay[d]; }));
      var html = '<table><tr><th>日期</th><th>agent</th><th>model</th><th class="num">runs</th><th class="num">$</th><th class="num">in</th><th class="num">out</th><th class="num">cached</th></tr>' +
        rows.map(function (r) {
          return '<tr><td class="mono">' + esc(r.day) + '</td><td>' + esc(r.agentName) + '</td><td class="mono">' + esc(r.model) + '</td>' +
            '<td class="num">' + r.runs + '</td><td class="num">' + r.usd.toFixed(4) + '</td>' +
            '<td class="num">' + r.inputTokens + '</td><td class="num">' + r.outputTokens + '</td><td class="num">' + r.cachedTokens + '</td></tr>';
        }).join('') + '</table>';
      $('usageTable').innerHTML = rows.length ? html : '<div class="muted">近 14 天无 run</div>';
    }).catch(function () {});
  }
  function drawChart(labels, values) {
    var svg = $('usageChart');
    var W = svg.clientWidth || 800, H = 180, pad = 24;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var max = Math.max.apply(null, values.concat([0.0001]));
    var bw = Math.min(48, (W - pad * 2) / Math.max(labels.length, 1) * 0.7);
    var html = '';
    labels.forEach(function (d, i) {
      var x = pad + (W - pad * 2) * (i + 0.5) / labels.length;
      var h = Math.max(2, (H - pad * 2) * values[i] / max);
      html += '<rect x="' + (x - bw / 2) + '" y="' + (H - pad - h) + '" width="' + bw + '" height="' + h + '" rx="3" fill="#4cc2ff" opacity="0.85"><title>' + d + '  $' + values[i].toFixed(4) + '</title></rect>';
      html += '<text x="' + x + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="#7d8a9c">' + d.slice(5) + '</text>';
    });
    html += '<text x="' + pad + '" y="14" font-size="10" fill="#7d8a9c">近 14 天 $/日（max $' + max.toFixed(4) + '）</text>';
    svg.innerHTML = html;
  }

  function refresh() { loadStrip(); loadBoard(); }
  if (!token) showToken(); else refresh();
  setInterval(refresh, 10000);
})();
</script>
</body>
</html>`;
