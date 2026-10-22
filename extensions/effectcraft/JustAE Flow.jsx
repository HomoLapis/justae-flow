/*
 * JustAE Flow — the storyboard as a dockable panel inside EffectCraft.
 *
 * Install: File ▸ Scripts ▸ Install ScriptUI Panel… and pick this file, then open it from the
 * Window menu. It talks to the JustAE Flow server (npm start, http://127.0.0.1:5199) over a
 * socket, so EffectCraft needs Preferences ▸ Scripting & Expressions ▸ Allow Scripts to Write
 * Files and Access Network turned on.
 *
 * Part of JustAE Flow, GPL-3.0. Original work, not derived from any Adobe sample or third-party panel.
 */

var JustAEFlowPanel = (function (thisObj) {
  var HOST = '127.0.0.1:5199';
  var CRLF = String.fromCharCode(13, 10);
  var STATUS = { idle: '○ Draft', queued: '◔ Queued', running: '▶ Running', done: '● Done', error: '✖ Error', canceled: '○ Canceled' };

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

  function fmtTime(t) {
    var m = Math.floor(t / 60);
    var s = (t - m * 60).toFixed(2);
    return m + ':' + (s.length < 5 ? '0' + s : s);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /* ─── Layout ─────────────────────────────────────────────────────── */

  var win = (thisObj instanceof Panel) ? thisObj : new Window('palette', 'JustAE Flow', undefined, { resizeable: true });
  win.orientation = 'column';
  win.alignChildren = ['fill', 'top'];
  win.spacing = 6;
  win.margins = 8;

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
  var bOpen = head.add('button', undefined, '↗');
  bOpen.preferredSize = [28, 22];
  bOpen.helpTip = 'Open the full storyboard in the browser';
  var status = win.add('statictext', undefined, 'Connecting…');
  status.alignment = ['fill', 'top'];

  var row1 = win.add('group');
  row1.alignChildren = ['fill', 'center'];
  var bAll = row1.add('button', undefined, '▶ Generate all');
  bAll.alignment = ['fill', 'center'];
  var bStop = row1.add('button', undefined, '■ Stop');

  var row2 = win.add('group');
  row2.alignChildren = ['fill', 'center'];
  var bMarker = row2.add('button', undefined, '+ Marker');
  bMarker.helpTip = 'A marker at the playhead; type the shot as its comment, or below';
  var bPlace = row2.add('button', undefined, '+ Box');
  bPlace.helpTip = 'A placeholder layer at the playhead: move and scale it, its size and length are the shot';
  var bAdopt = row2.add('button', undefined, 'Layers');
  bAdopt.helpTip = 'Turn the selected footage layers into cards: upscale, remove the background, cut out a subject, reframe';

  var list = win.add('listbox', undefined, []);
  list.alignment = ['fill', 'fill'];
  list.preferredSize = [260, 150];

  var card = win.add('panel', undefined, 'Card');
  card.orientation = 'column';
  card.alignChildren = ['fill', 'top'];
  card.spacing = 5;
  var prompt = card.add('edittext', undefined, '', { multiline: true });
  prompt.preferredSize = [250, 52];
  prompt.helpTip = 'The prompt. For a marker it is also the marker text. To cut out or reframe: the subject, in a word (woman, dog, car).';
  var wfRow = card.add('group');
  wfRow.add('statictext', undefined, 'Workflow');
  var wf = wfRow.add('dropdownlist', undefined, []);
  wf.alignment = ['fill', 'center'];
  // A workflow's choices (Reframe: aspect and smoothing), shown only when it has some.
  var optRow = card.add('group');
  var optName = [optRow.add('statictext', undefined, 'Aspect'), null];
  var opt = [optRow.add('dropdownlist', undefined, []), null];
  optName[1] = optRow.add('statictext', undefined, 'Smoothing');
  opt[1] = optRow.add('dropdownlist', undefined, []);
  opt[0].preferredSize = [62, -1];
  opt[1].preferredSize = [72, -1];
  var optSig = '';
  optRow.visible = false;
  var verRow = card.add('group');
  verRow.add('statictext', undefined, 'Version');
  var ver = verRow.add('dropdownlist', undefined, []);
  ver.preferredSize = [90, -1];
  var info = verRow.add('statictext', undefined, '');
  info.alignment = ['fill', 'center'];
  var bar = card.add('progressbar', undefined, 0, 100);
  bar.preferredSize = [250, 6];
  var errText = card.add('statictext', undefined, '', { multiline: true });
  errText.preferredSize = [250, 28];
  var actions = card.add('group');
  var bGen = actions.add('button', undefined, '▶ Generate');
  var bCancel = actions.add('button', undefined, 'Cancel');

  /* ─── State ──────────────────────────────────────────────────────── */

  var cards = [];
  var workflows = [];
  var openPage = '';
  var selectedId = null;
  var promptDirty = false;
  var listSig = '';
  var wfSig = '';
  var quiet = false;

  function current() {
    for (var i = 0; i < cards.length; i++) if (cards[i].id === selectedId) return cards[i];
    return null;
  }

  function rowText(c) {
    var where = c.box ? c.box[0] + '×' + c.box[1] : fmtTime(c.at);
    var st = STATUS[c.status] || c.status;
    if (c.status === 'running' && c.progress && c.progress.max > 1) st += ' ' + c.progress.value + '/' + c.progress.max;
    if (c.versions.length) st += ' v' + c.active;
    var text = c.prompt ? c.prompt.replace(/\s+/g, ' ') : (c.promptless ? '(no prompt needed)' : '(write the shot)');
    if (text.length > 48) text = text.slice(0, 47) + '…';
    return pad2(c.n) + '  ' + st + '  ' + where + '  ' + text + (c.orphan ? '  (gone)' : '');
  }

  function render(s) {
    quiet = true;
    try {
      var host = s.host;
      if (host.app !== 'EffectCraft') {
        status.text = '✖ JustAE Flow is set to ' + host.app + ' — switch it in Settings ▸ App (Storyboard ↗)';
        openPage = s.openPage || openPage;
        list.removeAll(); listSig = ''; cards = []; showCard();
        return;
      }
      status.text = (host.ok ? '● ' + (host.comp || host.app) : '✖ ' + host.app + ' offline')
        + '   ' + (s.comfy.online ? '● ComfyUI' : '✖ ComfyUI offline')
        + (s.queue.waiting ? '   · ' + s.queue.waiting + ' waiting' : '');
      cards = s.cards;
      workflows = s.workflows;
      openPage = s.openPage || '';
      bAll.text = s.queue.ready > 0 ? '▶ Generate all · ' + s.queue.ready : '▶ All generated';
      bAll.enabled = s.queue.ready > 0;
      bStop.enabled = !!s.queue.running || s.queue.waiting > 0;
      bAdopt.enabled = host.selectedLayers > 0;

      var w = [];
      for (var k = 0; k < workflows.length; k++) w.push(workflows[k].title);
      if (w.join('|') !== wfSig) {
        wfSig = w.join('|');
        wf.removeAll();
        for (var j = 0; j < w.length; j++) wf.add('item', w[j]);
      }

      var rows = [];
      for (var i = 0; i < cards.length; i++) rows.push(rowText(cards[i]));
      var sig = rows.join('\n');
      if (sig !== listSig) {
        listSig = sig;
        list.removeAll();
        var keep = -1;
        for (var r = 0; r < rows.length; r++) {
          list.add('item', rows[r]);
          if (cards[r].id === selectedId) keep = r;
        }
        if (keep < 0 && cards.length) { keep = 0; selectedId = cards[0].id; promptDirty = false; }
        if (keep >= 0) list.selection = keep;
      }
      showCard();
    } finally {
      quiet = false;
    }
  }

  function showCard() {
    var c = current();
    card.enabled = !!c;
    if (!c) { card.text = 'Card'; prompt.text = ''; info.text = ''; errText.text = ''; bar.value = 0; return; }
    card.text = 'Card ' + pad2(c.n) + ' · ' + c.kind + (c.kind === 'marker' ? ' @ ' + fmtTime(c.at) : '');
    if (!promptDirty && prompt.text !== c.prompt) prompt.text = c.prompt;
    for (var i = 0; i < workflows.length; i++) if (workflows[i].id === c.workflowId && (!wf.selection || wf.selection.index !== i)) wf.selection = i;
    showOptions(c);
    var vs = [];
    for (var v = 0; v < c.versions.length; v++) vs.push('v' + c.versions[v]);
    if (ver.items.length !== vs.length) {
      ver.removeAll();
      for (var x = 0; x < vs.length; x++) ver.add('item', vs[x]);
    }
    for (var y = 0; y < c.versions.length; y++) if (c.versions[y] === c.active && (!ver.selection || ver.selection.index !== y)) ver.selection = y;
    ver.enabled = c.versions.length > 1;
    var busy = c.status === 'running' || c.status === 'queued';
    info.text = c.status === 'running' && c.progress ? c.progress.phase : (STATUS[c.status] || c.status);
    bar.value = c.status === 'running' && c.progress && c.progress.max > 0 ? Math.round(100 * c.progress.value / c.progress.max) : (c.status === 'done' ? 100 : 0);
    errText.text = c.error ? c.error.slice(0, 200) : '';
    bGen.text = c.versions.length ? '▶ New version' : '▶ Generate';
    bGen.enabled = !busy && !c.orphan;
    bCancel.enabled = busy;
  }

  function optionsOf(c) {
    for (var i = 0; i < workflows.length; i++) if (workflows[i].id === c.workflowId) return workflows[i].options || [];
    return [];
  }

  function showOptions(c) {
    var opts = optionsOf(c);
    var sig = c.workflowId + ':' + opts.length;
    if (sig !== optSig) {
      optSig = sig;
      for (var k = 0; k < 2; k++) {
        opt[k].removeAll();
        if (opts[k]) for (var j = 0; j < opts[k].options.length; j++) opt[k].add('item', opts[k].options[j]);
        optName[k].text = opts[k] ? opts[k].label : '';
        optName[k].visible = opt[k].visible = !!opts[k];
      }
      optRow.visible = opts.length > 0;
      win.layout.layout(true);
    }
    for (var n = 0; n < Math.min(2, opts.length); n++) {
      var value = c.params && c.params[opts[n].ref] !== undefined ? String(c.params[opts[n].ref]) : opts[n].options[0];
      for (var x = 0; x < opts[n].options.length; x++) {
        if (opts[n].options[x] === value && (!opt[n].selection || opt[n].selection.index !== x)) opt[n].selection = x;
      }
    }
  }

  function refresh() {
    var r = request('GET', '/api/panel');
    if (r.error) { status.text = '✖ ' + r.error; return; }
    render(r.data);
  }

  function act(method, path, body) {
    var r = request(method, path, body);
    if (r.error) status.text = '✖ ' + r.error;
    refresh();
    return r;
  }

  function savePrompt() {
    var c = current();
    if (!c || !promptDirty) return;
    promptDirty = false;
    if (prompt.text !== c.prompt) act('POST', '/api/cards/' + c.id, { prompt: prompt.text });
  }

  /* ─── Events ─────────────────────────────────────────────────────── */

  list.onChange = function () {
    if (quiet || !list.selection) return;
    savePrompt();
    var c = cards[list.selection.index];
    if (c) { selectedId = c.id; promptDirty = false; showCard(); }
  };
  prompt.onChanging = function () { promptDirty = true; };
  prompt.onChange = savePrompt;
  wf.onChange = function () {
    var c = current();
    if (quiet || !c || !wf.selection) return;
    var w = workflows[wf.selection.index];
    if (w && w.id !== c.workflowId) act('POST', '/api/cards/' + c.id, { workflowId: w.id });
  };
  function optionChanged(k) {
    return function () {
      var c = current();
      if (quiet || !c || !opt[k].selection) return;
      var o = optionsOf(c)[k];
      if (!o) return;
      var params = {};
      params[o.ref] = o.options[opt[k].selection.index];
      act('POST', '/api/cards/' + c.id, { params: params });
    };
  }
  opt[0].onChange = optionChanged(0);
  opt[1].onChange = optionChanged(1);
  ver.onChange = function () {
    var c = current();
    if (quiet || !c || !ver.selection) return;
    var n = c.versions[ver.selection.index];
    if (n !== c.active) act('POST', '/api/cards/' + c.id + '/version', { n: n });
  };
  bGen.onClick = function () {
    savePrompt();
    var c = current();
    if (c) act('POST', '/api/generate', { ids: [c.id] });
  };
  bCancel.onClick = function () { var c = current(); if (c) act('POST', '/api/cancel', { id: c.id }); };
  bAll.onClick = function () { savePrompt(); act('POST', '/api/generate', {}); };
  bStop.onClick = function () { act('POST', '/api/cancel', {}); };
  bMarker.onClick = function () { act('POST', '/api/marker', { comment: '' }); };
  bPlace.onClick = function () { act('POST', '/api/placeholder', {}); };
  bAdopt.onClick = function () { act('POST', '/api/adopt', {}); };
  bOpen.onClick = function () {
    if (!openPage) refresh();
    if (openPage) new File(openPage).execute();
  };

  win.onResizing = win.onResize = function () { this.layout.resize(); };
  if (win instanceof Window) { win.center(); win.show(); } else { win.layout.layout(true); }

  refresh();
  var task = app.scheduleTask('JustAEFlowPanel.tick()', 1500, true);
  win.onClose = function () { app.cancelTask(task); };

  return { tick: function () { if (!promptDirty) refresh(); else { var c = current(); if (!c) refresh(); } } };
})(this);
