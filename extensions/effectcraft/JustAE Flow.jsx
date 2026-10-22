/*
 * JustAE Flow — the panel inside EffectCraft.
 *
 * The full Flow interface (Workflow, Marker, Storyboard) opens in its own app
 * window from here; this panel shows what that window will work on, sets up
 * shots the way it reads them — a pair of comp markers, or an adjustment layer
 * as a placeholder — and runs the layer tools on the selected clip.
 *
 * Install: File ▸ Scripts ▸ Install ScriptUI Panel… and pick this file, then open it from the
 * Window menu. It talks to the JustAE Flow server (npm start, http://127.0.0.1:5199) over a
 * socket, so EffectCraft needs Preferences ▸ Scripting & Expressions ▸ Allow Scripts to Write
 * Files and Access Network turned on.
 *
 * Part of JustAE Flow, GPL-3.0.
 */

var JustAEFlowPanel = (function (thisObj) {
  var HOST = '127.0.0.1:5199';
  var CRLF = String.fromCharCode(13, 10);
  var STATUS = { idle: 'Ready', queued: 'Queued', running: 'Running', done: 'Done', error: 'Error', canceled: 'Canceled' };
  var SHOT_SECONDS = 3;

  /* The layer tools: the workflow each runs, what its text box is for, and whether it takes an aspect. */
  var TOOLS = [
    { label: 'Cut out a subject (SAM 3)', workflow: 'sam3-matte', text: 'Subject, in a word: woman, dog, car', aspect: false },
    { label: 'Reframe, generate the new space (Wan VACE 14B)', workflow: 'vace-reframe', text: 'Describe the whole scene, with what the new space shows', aspect: true },
    { label: 'Reframe, draft (Wan VACE 1.3B)', workflow: 'vace-reframe-draft', text: 'Describe the whole scene, with what the new space shows', aspect: true },
    { label: 'Auto crop, follow a subject (SAM 3)', workflow: 'sam3-reframe', text: 'Subject the frame follows: woman, surfer, car', aspect: true },
    { label: 'Upscale x2 (SeedVR2)', workflow: 'seedvr2-upscale', text: '', aspect: false }
  ];
  var ASPECTS = ['9:16', '4:5', '1:1', '16:9'];

  function byteLength(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /** One HTTP/1.0 request to the JustAE Flow server; the server closes the connection when done. */
  function request(method, path, body) {
    var s;
    try { s = new Socket(); } catch (e) {
      return { error: 'Turn on Preferences ▸ Scripting & Expressions ▸ Allow Scripts to Write Files and Access Network.' };
    }
    s.timeout = 5;
    if (!s.open(HOST, 'UTF-8')) return { error: 'JustAE Flow is not running — start it with “npm start”.' };
    var payload = body === undefined ? '' : JSON.stringify(body);
    s.write(method + ' ' + path + ' HTTP/1.0' + CRLF + 'Host: 127.0.0.1' + CRLF + 'Content-Type: application/json' + CRLF
      + 'Content-Length: ' + byteLength(payload) + CRLF + CRLF + payload);
    var raw = s.read();
    s.close();
    var cut = raw.indexOf(CRLF + CRLF);
    var code = parseInt(raw.split(' ')[1], 10);
    var data = {};
    try { data = cut >= 0 && raw.length > cut + 4 ? JSON.parse(raw.slice(cut + 4)) : {}; } catch (e) { return { error: 'Unreadable answer from JustAE Flow.' }; }
    if (!(code >= 200 && code < 300)) return { error: (data && data.error) || ('HTTP ' + code) };
    return { data: data };
  }

  function activeComp() {
    var c = app.project ? app.project.activeItem : null;
    return (c && c instanceof CompItem) ? c : null;
  }

  /* ─── Layout ─────────────────────────────────────────────────────── */

  var win = (thisObj instanceof Panel) ? thisObj : new Window('palette', 'JustAE Flow', undefined, { resizeable: true });
  win.orientation = 'column';
  win.alignChildren = ['fill', 'top'];
  win.spacing = 7;
  win.margins = 9;

  var head = win.add('group');
  head.orientation = 'row';
  head.alignChildren = ['left', 'center'];
  var mark = head.add('group');
  mark.preferredSize = [30, 20];
  mark.onDraw = function () {
    // The three bars of the JustAE "E".
    var g = this.graphics;
    var bars = [[0.161, 0.722, 0.808], [1, 0.867, 0], [0.871, 0.02, 0.298]];
    for (var i = 0; i < 3; i++) {
      var y = 2 + i * 6;
      var x = 2 + i * 2;
      g.newPath();
      g.moveTo(x, y); g.lineTo(x + 22, y); g.lineTo(x + 24, y + 4); g.lineTo(x + 2, y + 4); g.closePath();
      g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, [bars[i][0], bars[i][1], bars[i][2], 1]));
    }
  };
  head.add('statictext', undefined, 'JustAE Flow');

  var serverLine = win.add('statictext', undefined, 'Connecting…');
  serverLine.alignment = ['fill', 'top'];
  var compLine = win.add('statictext', undefined, '');
  compLine.alignment = ['fill', 'top'];

  var bOpen = win.add('button', undefined, 'Open JustAE Flow');
  bOpen.preferredSize = [-1, 34];
  bOpen.helpTip = 'Workflow, Marker and Storyboard: the full Flow window, beside EffectCraft';

  var shots = win.add('panel', undefined, 'Shots');
  shots.alignChildren = ['fill', 'top'];
  shots.spacing = 5;
  var shotRow = shots.add('group');
  shotRow.alignChildren = ['fill', 'center'];
  var bPair = shotRow.add('button', undefined, '+ Marker pair');
  bPair.helpTip = 'Two comp markers from the playhead, ' + SHOT_SECONDS + ' s apart: the Marker tab fills the gap between them';
  var bPlace = shotRow.add('button', undefined, '+ Placeholder');
  bPlace.helpTip = 'An adjustment layer from the playhead: the Storyboard tab fills it, in its in and out points, with its label colour';
  var shotHint = shots.add('statictext', undefined, 'Move and trim them here; the Flow window follows.', { multiline: true });
  shotHint.preferredSize = [250, 28];

  var tools = win.add('panel', undefined, 'Selected layer');
  tools.alignChildren = ['fill', 'top'];
  tools.spacing = 5;
  var tool = tools.add('dropdownlist', undefined, []);
  for (var t = 0; t < TOOLS.length; t++) tool.add('item', TOOLS[t].label);
  tool.selection = 0;
  var aspectRow = tools.add('group');
  aspectRow.add('statictext', undefined, 'Aspect');
  var aspect = aspectRow.add('dropdownlist', undefined, ASPECTS);
  aspect.selection = 0;
  var text = tools.add('edittext', undefined, '', { multiline: true });
  text.preferredSize = [250, 44];
  var bRun = tools.add('button', undefined, 'Run on the selected layer');
  var bar = tools.add('progressbar', undefined, 0, 100);
  bar.preferredSize = [250, 6];
  var toolInfo = tools.add('statictext', undefined, '', { multiline: true });
  toolInfo.preferredSize = [250, 30];

  /* ─── State ──────────────────────────────────────────────────────── */

  var running = null;   // the card a layer tool is running on

  function showTool() {
    var tl = TOOLS[tool.selection ? tool.selection.index : 0];
    aspectRow.visible = tl.aspect;
    text.visible = tl.text !== '';
    text.helpTip = tl.text;
    if (!text.text && tl.text) toolInfo.text = tl.text + '.';
  }

  function compSummary() {
    var comp = activeComp();
    if (!comp) return 'No composition open.';
    var markers = comp.markerProperty ? comp.markerProperty.numKeys : 0;
    var placeholders = 0;
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      if (l.adjustmentLayer === true && l.enabled) placeholders++;
    }
    var pairs = Math.floor(markers / 2);
    return comp.name + ' · ' + pairs + ' marker shot' + (pairs === 1 ? '' : 's') + ' · ' + placeholders + ' placeholder' + (placeholders === 1 ? '' : 's');
  }

  function refresh() {
    compLine.text = compSummary();
    var r = request('GET', '/api/panel');
    if (r.error) { serverLine.text = '✖ ' + r.error; return; }
    var s = r.data;
    serverLine.text = (s.comfy.online ? '● ComfyUI ' + (s.comfy.version || '') : '✖ ComfyUI offline') + (s.queue.running ? '   · running' : '');
    if (running) {
      var c = null;
      for (var i = 0; i < s.cards.length; i++) if (s.cards[i].id === running) c = s.cards[i];
      if (!c) return;
      var busy = c.status === 'running' || c.status === 'queued';
      bar.value = busy && c.progress && c.progress.max > 0 ? Math.round(100 * c.progress.value / c.progress.max) : (c.status === 'done' ? 100 : 0);
      toolInfo.text = c.status === 'error' ? ('✖ ' + (c.error || '').slice(0, 160))
        : busy ? (c.progress ? c.progress.phase : STATUS[c.status]) : STATUS[c.status];
      bRun.enabled = !busy;
      if (!busy) running = null;
    }
  }

  /* ─── Events ─────────────────────────────────────────────────────── */

  bOpen.onClick = function () {
    var r = request('POST', '/api/window/open', {});
    if (r.error) serverLine.text = '✖ ' + r.error;
  };

  bPair.onClick = function () {
    var comp = activeComp();
    if (!comp) { compLine.text = 'Open a composition first.'; return; }
    app.beginUndoGroup('JustAE Flow — Marker pair');
    var t0 = comp.time;
    var t1 = Math.min(comp.duration, t0 + SHOT_SECONDS);
    comp.markerProperty.setValueAtTime(t0, new MarkerValue(''));
    comp.markerProperty.setValueAtTime(t1, new MarkerValue(''));
    app.endUndoGroup();
    refresh();
  };

  bPlace.onClick = function () {
    var comp = activeComp();
    if (!comp) { compLine.text = 'Open a composition first.'; return; }
    var n = 1;
    for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).adjustmentLayer === true) n++;
    app.beginUndoGroup('JustAE Flow — Placeholder');
    var layer = comp.layers.addSolid([1, 1, 1], 'Shot ' + (n < 10 ? '0' + n : n), comp.width, comp.height, 1, SHOT_SECONDS);
    layer.adjustmentLayer = true;
    layer.startTime = comp.time;
    layer.label = 1 + ((n - 1) % 16);
    app.endUndoGroup();
    refresh();
  };

  tool.onChange = showTool;

  bRun.onClick = function () {
    var tl = TOOLS[tool.selection ? tool.selection.index : 0];
    if (tl.text && !text.text) { toolInfo.text = 'First: ' + tl.text.charAt(0).toLowerCase() + tl.text.slice(1) + '.'; return; }
    var c = request('POST', '/api/layer-card', {});
    if (c.error) { toolInfo.text = '✖ ' + c.error; return; }
    var patch = { workflowId: tl.workflow, prompt: text.text };
    if (tl.aspect) patch.params = { '@aspect': ASPECTS[aspect.selection ? aspect.selection.index : 0] };
    var u = request('POST', '/api/cards/' + c.data.id, patch);
    if (u.error) { toolInfo.text = '✖ ' + u.error; return; }
    var g = request('POST', '/api/generate', { ids: [c.data.id] });
    if (g.error) { toolInfo.text = '✖ ' + g.error; return; }
    running = c.data.id;
    toolInfo.text = 'Queued.';
    bRun.enabled = false;
  };

  win.onResizing = win.onResize = function () { this.layout.resize(); };
  showTool();
  if (win instanceof Window) { win.center(); win.show(); } else { win.layout.layout(true); }

  refresh();
  var task = app.scheduleTask('JustAEFlowPanel.tick()', 1500, true);
  win.onClose = function () { app.cancelTask(task); };

  return { tick: function () { refresh(); } };
})(this);
