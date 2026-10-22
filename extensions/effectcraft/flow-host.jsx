/**
 * JustAE Flow — EffectCraft host.
 *
 * The host script of JustAE Flow 2 for After Effects, run inside EffectCraft:
 * EffectCraft's scripting follows After Effects scripting, so the same
 * functions work there. The JustAE Flow server sends this file plus one call
 * through EffectCraft's control channel (script.run) and hands back the JSON
 * string each function answers (success / error envelope).
 */

/* ===================================================================== */
/* JSON polyfill — ExtendScript has no JSON object.                      */
/* Measured on After Effects 26.5: `typeof JSON === "undefined"`, and    */
/* the panel showed "No response from ExtendScript host" because every   */
/* host function below answers in JSON. Defined only when missing, so an */
/* engine that ships JSON keeps its own. ES3 only, and no \u escapes in  */
/* regex literals: ExtendScript rejects them as a syntax error.          */
/* ===================================================================== */
if (typeof JSON !== "object" || JSON === null) { JSON = {}; }
(function () {
    function hex4(c) { var h = c.toString(16); while (h.length < 4) { h = "0" + h; } return "\\u" + h; }
    function quote(s) {
        var out = "\"", i, c, ch;
        for (i = 0; i < s.length; i += 1) {
            ch = s.charAt(i);
            c = s.charCodeAt(i);
            if (ch === "\"") { out += "\\\""; }
            else if (ch === "\\") { out += "\\\\"; }
            else if (c === 8) { out += "\\b"; }
            else if (c === 9) { out += "\\t"; }
            else if (c === 10) { out += "\\n"; }
            else if (c === 12) { out += "\\f"; }
            else if (c === 13) { out += "\\r"; }
            else if (c < 32 || c === 0x2028 || c === 0x2029 || (c >= 0x7f && c <= 0x9f)) { out += hex4(c); }
            else { out += ch; }
        }
        return out + "\"";
    }
    function str(key, holder) {
        var i, k, v, partial, value = holder[key];
        if (value && typeof value === "object" && typeof value.toJSON === "function") { value = value.toJSON(key); }
        switch (typeof value) {
            case "string": return quote(value);
            case "number": return isFinite(value) ? String(value) : "null";
            case "boolean": return String(value);
            case "object":
                if (!value) { return "null"; }
                partial = [];
                if (value instanceof Array) {
                    for (i = 0; i < value.length; i += 1) { partial[i] = str(i, value) || "null"; }
                    return "[" + partial.join(",") + "]";
                }
                for (k in value) {
                    if (Object.prototype.hasOwnProperty.call(value, k)) {
                        v = str(k, value);
                        if (v) { partial.push(quote(k) + ":" + v); }
                    }
                }
                return "{" + partial.join(",") + "}";
        }
        return undefined;
    }
    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (value) { return str("", { "": value }); };
    }
    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text) {
            var t = String(text), safe = "", i, c;
            // U+2028/2029 are legal inside JSON strings but end a line for eval.
            for (i = 0; i < t.length; i += 1) {
                c = t.charCodeAt(i);
                safe += (c === 0x2028 || c === 0x2029) ? hex4(c) : t.charAt(i);
            }
            // json2's structural check: only JSON tokens may remain for eval.
            if (/^[\],:{}\s]*$/.test(safe
                    .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                    .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
                    .replace(/(?:^|:|,)(?:\s*\[)+/g, ""))) {
                return eval("(" + safe + ")");
            }
            throw new SyntaxError("JSON.parse: invalid JSON");
        };
    }
}());

/* ─── Composition / project info ─────────────────────────────────────── */

function checkAEReady() {
    try {
        var hasProject = app.project !== null && app.project !== undefined;
        var hasActiveComp = false;
        var compName = "";
        if (hasProject && app.project.activeItem && app.project.activeItem instanceof CompItem) {
            hasActiveComp = true;
            compName = app.project.activeItem.name;
        }
        return JSON.stringify({
            ready: true,
            hasProject: hasProject,
            hasActiveComp: hasActiveComp,
            activeCompName: compName
        });
    } catch (e) {
        return JSON.stringify({ ready: false, error: e.toString() });
    }
}

function getActiveCompInfo() {
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) return JSON.stringify(null);
    return JSON.stringify({
        name: comp.name,
        width: comp.width,
        height: comp.height,
        duration: comp.duration,
        frameRate: comp.frameRate,
        time: comp.time,
        numLayers: comp.numLayers,
        workAreaStart: comp.workAreaStart,
        workAreaDuration: comp.workAreaDuration
    });
}

function getProjectDir() {
    try {
        if (!app.project || !app.project.file) return JSON.stringify({ path: null });
        return JSON.stringify({ path: app.project.file.parent.fsName });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

/**
 * Full project context — name (without extension), folder, isSaved flag.
 * Used by the plugin to decide where to save generated assets:
 *   isSaved=true  → assets go next to the .aep in <project>_JustAE/
 *   isSaved=false → assets go to OS temp until the project is saved.
 */
function getProjectInfo() {
    try {
        if (!app.project || !app.project.file) {
            return JSON.stringify({ isSaved: false, name: null, dir: null });
        }
        var f = app.project.file;
        // ExtendScript `File.name` is URI-ENCODED (e.g. "Mora-caff%C3%A8.aep").
        // If we send that to Node it writes the % literally into folder names,
        // then AE's File() constructor decodes them on import → file-not-found.
        // Use fsName (platform-native) and extract the basename ourselves so
        // the project name reaches Node already decoded.
        var fsName = f.fsName;
        var sep = (fsName.indexOf("\\") >= 0) ? "\\" : "/";
        var idx = fsName.lastIndexOf(sep);
        var baseName = (idx >= 0) ? fsName.substring(idx + 1) : fsName;
        var stem = baseName.replace(/\.(aep|aepx|ecproj)$/i, "");
        return JSON.stringify({
            isSaved: true,
            name: stem,
            dir: f.parent.fsName,
            fullPath: fsName
        });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

function getTempDir() {
    try {
        var f = new Folder(Folder.temp.fsName + "/JustAE");
        if (!f.exists) f.create();
        return JSON.stringify({ path: f.fsName });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

/* ─── Timeline insertion ─────────────────────────────────────────────── */

/* ─── Comp markers (segment definition) ─────────────────────────────── */

/**
 * Read comp markers, ordered by time. The plugin pairs them sequentially
 * to define generation segments (M1+M2 = segment A, M3+M4 = segment B…).
 * Returns { markers: [{ index, time, comment, duration }] } or { error }.
 */
function getCompMarkers() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition." });
        }
        var prop = comp.markerProperty;
        var out = [];
        if (prop) {
            var n = prop.numKeys;
            for (var i = 1; i <= n; i++) {
                var t = prop.keyTime(i);
                var mv = prop.keyValue(i);
                var comment = "";
                var duration = 0;
                try { if (mv && mv.comment) comment = String(mv.comment); } catch (_c) {}
                try { if (mv && mv.duration) duration = Number(mv.duration); } catch (_d) {}
                out.push({ index: i, time: t, comment: comment, duration: duration });
            }
            out.sort(function (a, b) { return a.time - b.time; });
        }
        return JSON.stringify({
            success: true,
            compName: comp.name,
            compDuration: comp.duration,
            frameRate: comp.frameRate,
            markers: out
        });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

/**
 * Import a file; a numbered still (name_00000.png / .tif / .exr) is imported
 * as an image SEQUENCE — the lossless masters the panel makes are PNG 16-bit
 * sequences — conformed to seqFps when given (> 0).
 */
function _jaeImport(file, seqFps) {
    var io = new ImportOptions(file);
    var isSeq = /_\d{4,6}\.(png|tif|tiff|exr)$/i.test(file.name);
    if (isSeq) {
        try { io.sequence = true; } catch (eS) {}
        try { io.forceAlphabetical = true; } catch (eA) {}
    }
    var item = app.project.importFile(io);
    if (item && isSeq && typeof seqFps === "number" && seqFps > 0) {
        try { item.mainSource.conformFrameRate = seqFps; } catch (eF) {}
    }
    return item;
}

/**
 * Like importAndAddToTimeline but anchors at an explicit time (in seconds)
 * instead of the current playhead. Used for batch insertion at segment.start.
 */
function insertVideoAtTime(filePath, atTime, layerName, fitMode, labelColor, seqFps) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition. Select a comp first." });
        }
        var file = new File(filePath);
        if (!file.exists) return JSON.stringify({ error: "Video file not found: " + filePath });

        var footage = _jaeImport(file, seqFps);
        if (!footage) return JSON.stringify({ error: "Failed to import file" });

        app.beginUndoGroup("JustAE Flow — Insert at time");
        var layer = comp.layers.add(footage);
        var t = (typeof atTime === "number" && atTime >= 0) ? atTime : comp.time;
        layer.startTime = t;
        if (layerName && layerName !== "") layer.name = layerName;
        // Storyboard: mirror the placeholder's AE label color (1-16; 0 = None).
        if (typeof labelColor === "number" && labelColor >= 1 && labelColor <= 16) {
            try { layer.label = labelColor; } catch (eLbl) {}
        }

        var fitted = applyFit(layer, footage.width, footage.height, comp.width, comp.height, fitMode);
        app.endUndoGroup();

        return JSON.stringify({
            success: true,
            layerName: layer.name,
            layerIndex: layer.index,
            startTime: layer.startTime,
            duration: footage.duration,
            compName: comp.name,
            sourceWidth: footage.width,
            sourceHeight: footage.height,
            compWidth: comp.width,
            compHeight: comp.height,
            fitApplied: fitted
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (ignore) {}
        return JSON.stringify({ error: e.toString() });
    }
}

function importAndAddToTimeline(filePath, layerName, fitMode, seqFps) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition. Select a comp first." });
        }
        var file = new File(filePath);
        if (!file.exists) return JSON.stringify({ error: "Video file not found: " + filePath });

        var footage = _jaeImport(file, seqFps);
        if (!footage) return JSON.stringify({ error: "Failed to import file" });

        app.beginUndoGroup("JustAE Flow — Add Video");
        var layer = comp.layers.add(footage);
        layer.startTime = comp.time;
        if (layerName && layerName !== "") layer.name = layerName;

        // Optional: scale layer uniformly so it fills the comp ("fill"),
        // or fits inside it ("fit"). Cancels the typical multiple-of-32
        // mismatch that ComfyUI workflows introduce.
        var fitted = applyFit(layer, footage.width, footage.height, comp.width, comp.height, fitMode);

        app.endUndoGroup();

        return JSON.stringify({
            success: true,
            layerName: layer.name,
            layerIndex: layer.index,
            startTime: layer.startTime,
            duration: footage.duration,
            compName: comp.name,
            sourceWidth: footage.width,
            sourceHeight: footage.height,
            compWidth: comp.width,
            compHeight: comp.height,
            fitApplied: fitted
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (ignore) {}
        return JSON.stringify({ error: e.toString() });
    }
}

/**
 * Scale a layer to fit / fill the composition. Returns null if no scaling
 * was needed or fitMode is "none" / undefined.
 *   "fill" — uniform scale = max(compW/srcW, compH/srcH). Covers comp,
 *            crops slightly if aspect differs. Best for generated clips
 *            that came back from Comfy a few pixels smaller than the comp.
 *   "fit"  — uniform scale = min(...). Letterboxes if aspect differs.
 */
function applyFit(layer, srcW, srcH, compW, compH, fitMode) {
    if (!fitMode || fitMode === "none") return null;
    if (!srcW || !srcH || !compW || !compH) return null;
    if (srcW === compW && srcH === compH) return null;

    var sx = compW / srcW;
    var sy = compH / srcH;
    var s = (fitMode === "fit") ? Math.min(sx, sy) : Math.max(sx, sy);
    var pct = s * 100;

    try {
        var scaleProp = layer.property("Transform").property("Scale");
        scaleProp.setValue([pct, pct]);
        return { mode: fitMode, scalePercent: pct };
    } catch (e) {
        return null;
    }
}

function importImageAndAddToTimeline(filePath, layerName, durationSec, fitMode) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition." });
        }
        var file = new File(filePath);
        if (!file.exists) return JSON.stringify({ error: "Image file not found: " + filePath });

        var importOptions = new ImportOptions(file);
        var item = app.project.importFile(importOptions);
        if (!item) return JSON.stringify({ error: "Failed to import image" });

        app.beginUndoGroup("JustAE Flow — Add Image");
        var layer = comp.layers.add(item);
        layer.startTime = comp.time;
        var dur = (typeof durationSec === "number" && durationSec > 0) ? durationSec : 5;
        try { layer.outPoint = layer.inPoint + dur; } catch (eD) {}
        if (layerName && layerName !== "") layer.name = layerName;

        var fitted = applyFit(layer, item.width, item.height, comp.width, comp.height, fitMode);

        app.endUndoGroup();

        return JSON.stringify({
            success: true,
            layerName: layer.name,
            layerIndex: layer.index,
            startTime: layer.startTime,
            duration: dur,
            compName: comp.name,
            sourceWidth: item.width,
            sourceHeight: item.height,
            compWidth: comp.width,
            compHeight: comp.height,
            fitApplied: fitted
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (ignore) {}
        return JSON.stringify({ error: e.toString() });
    }
}

/* ─── Frame capture (playhead → PNG) ─────────────────────────────────── */

function captureCurrentFrameToFile(targetPath) {
    var rqItem = null;
    var disabled = [];
    var diag = [];
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition." });
        }
        if (!targetPath) return JSON.stringify({ error: "No target path provided." });

        var outFile = new File(targetPath);
        try { var par = outFile.parent; if (!par.exists) par.create(); } catch (eFolder) {}
        if (!outFile.parent.exists) {
            return JSON.stringify({ error: "Could not create snapshot folder: " + outFile.parent.fsName });
        }
        try { if (outFile.exists) outFile.remove(); } catch (_) {}

        var t = comp.time;
        diag.push("time=" + t.toFixed(3) + "s");

        // Path A: CompItem.saveFrameToPng (AE 24.0+)
        if (typeof comp.saveFrameToPng === "function") {
            try { comp.saveFrameToPng(t, outFile); } catch (eDirect) { diag.push("errA=" + eDirect.toString()); }
            if (outFile.exists && outFile.length > 100) {
                return JSON.stringify({
                    success: true, path: outFile.fsName, bytes: outFile.length,
                    width: comp.width, height: comp.height, time: t,
                    compName: comp.name, format: "png", method: "saveFrameToPng"
                });
            }
            diag.push("A-failed");
        }

        // Path B: Render Queue with PNG / JPEG template
        rqItem = app.project.renderQueue.items.add(comp);
        rqItem.timeSpanStart = t;
        rqItem.timeSpanDuration = 1 / comp.frameRate;
        var om = rqItem.outputModule(1);
        var available = om.templates;

        var picked = null, pickedExt = "png";
        var patterns = [
            { re: /^PNG Sequence$/i, ext: "png" },
            { re: /^PNG$/i, ext: "png" },
            { re: /PNG/i, ext: "png" },
            { re: /^JPEG Sequence$/i, ext: "jpg" },
            { re: /JPEG|JPG/i, ext: "jpg" }
        ];
        for (var p = 0; p < patterns.length && !picked; p++) {
            for (var a = 0; a < available.length; a++) {
                if (patterns[p].re.test(available[a])) {
                    picked = available[a]; pickedExt = patterns[p].ext; break;
                }
            }
        }
        if (!picked) {
            try { rqItem.remove(); } catch (_) {}
            return JSON.stringify({
                error: "No PNG/JPEG output template available. Edit → Templates → Output Module to add one. Diag: " + diag.join(", ")
            });
        }
        try { om.applyTemplate(picked); } catch (eT) {}

        var stamp = new Date().getTime();
        var tempPrefix = "__snap_" + stamp + "_";
        om.file = new File(outFile.parent.fsName + "/" + tempPrefix + "[#####]." + pickedExt);

        for (var j = 1; j <= app.project.renderQueue.numItems; j++) {
            var it = app.project.renderQueue.item(j);
            if (it !== rqItem && it.status === RQItemStatus.QUEUED) { it.render = false; disabled.push(j); }
        }
        app.project.renderQueue.render();
        for (var k = 0; k < disabled.length; k++) {
            try { app.project.renderQueue.item(disabled[k]).render = true; } catch (eR) {}
        }
        try { rqItem.remove(); } catch (_) {}
        rqItem = null;

        var folder = outFile.parent;
        var fl = folder.getFiles(function (f) {
            return (f instanceof File) && f.name.indexOf(tempPrefix) === 0;
        });
        var produced = (fl && fl.length > 0) ? fl[0] : null;
        if (!produced || produced.length < 100) {
            return JSON.stringify({ error: "Render produced no/empty file. Diag: " + diag.join(", ") });
        }
        try {
            if (outFile.exists) outFile.remove();
            produced.rename(outFile.name);
        } catch (_) {}
        return JSON.stringify({
            success: true, path: outFile.fsName, bytes: outFile.length,
            width: comp.width, height: comp.height, time: t,
            compName: comp.name, format: pickedExt, method: "renderQueue", template: picked
        });
    } catch (e) {
        try {
            for (var kk = 0; kk < disabled.length; kk++) {
                try { app.project.renderQueue.item(disabled[kk]).render = true; } catch (eX) {}
            }
            if (rqItem) { try { rqItem.remove(); } catch (eY) {} }
        } catch (eZ) {}
        return JSON.stringify({ error: e.toString() + " | diag: " + diag.join(", ") });
    }
}

/* ─── Work area render (for V2V reference) ───────────────────────────── */

function renderWorkAreaToFile(maxDurationSec) {
    var rqItem = null;
    var disabled = [];
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition." });
        }
        var maxDur = (typeof maxDurationSec === "number" && maxDurationSec > 0) ? maxDurationSec : 15;
        var wStart = comp.workAreaStart;
        var wDur = Math.min(comp.workAreaDuration, maxDur);
        if (wDur <= 0) {
            return JSON.stringify({
                error: "Work area has zero duration. Press B at start, N at end."
            });
        }

        var tempFolder = new Folder(Folder.temp.fsName + "/JustAE");
        if (!tempFolder.exists) tempFolder.create();
        var stamp = new Date().getTime();

        rqItem = app.project.renderQueue.items.add(comp);
        rqItem.timeSpanStart = wStart;
        rqItem.timeSpanDuration = wDur;
        var om = rqItem.outputModule(1);
        var available = om.templates;
        var preferred = [
            "H.264 - Match Render Settings - 5 Mbps",
            "H.264 - Match Render Settings - 15 Mbps",
            "H.264", "High Quality", "Lossless"
        ];
        var picked = null;
        for (var p = 0; p < preferred.length && !picked; p++) {
            for (var a = 0; a < available.length; a++) {
                if (available[a] === preferred[p]) { picked = preferred[p]; break; }
            }
        }
        if (!picked && available.length > 0) picked = available[0];
        if (!picked) picked = "Lossless";
        try { om.applyTemplate(picked); } catch (e1) {
            try { om.applyTemplate("Lossless"); picked = "Lossless"; } catch (e2) {}
        }
        var ext = (picked.indexOf("H.264") >= 0) ? "mp4" : "mov";
        var outFile = new File(tempFolder.fsName + "/justae_ref_" + stamp + "." + ext);
        om.file = outFile;

        for (var j = 1; j <= app.project.renderQueue.numItems; j++) {
            var it = app.project.renderQueue.item(j);
            if (it !== rqItem && it.status === RQItemStatus.QUEUED) { it.render = false; disabled.push(j); }
        }
        app.project.renderQueue.render();
        for (var k = 0; k < disabled.length; k++) {
            try { app.project.renderQueue.item(disabled[k]).render = true; } catch (eR) {}
        }
        try { rqItem.remove(); } catch (_) {}
        rqItem = null;

        if (!outFile.exists) {
            return JSON.stringify({ error: "Render finished but output not found at " + outFile.fsName });
        }
        return JSON.stringify({
            success: true, path: outFile.fsName, duration: wDur,
            workAreaStart: wStart, compName: comp.name, template: picked
        });
    } catch (e) {
        try {
            for (var kk = 0; kk < disabled.length; kk++) {
                try { app.project.renderQueue.item(disabled[kk]).render = true; } catch (eX) {}
            }
            if (rqItem) { try { rqItem.remove(); } catch (eY) {} }
        } catch (eZ) {}
        return JSON.stringify({ error: e.toString() });
    }
}

/* ─── Storyboard: adjustment-layer placeholders ──────────────────────── */

/**
 * Trim a layer's out point to (inPoint + durationSec). Used after a storyboard
 * clip is placed so a clip generated slightly longer than its slot lines up
 * with the placeholder's end. This is a lossless cut (outPoint), not a scale.
 */
function trimLayerDuration(layerIndex, durationSec) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition." });
        }
        if (typeof layerIndex !== "number" || layerIndex < 1 || layerIndex > comp.numLayers) {
            return JSON.stringify({ error: "Invalid layerIndex: " + layerIndex });
        }
        if (typeof durationSec !== "number" || durationSec <= 0) {
            return JSON.stringify({ error: "Invalid durationSec: " + durationSec });
        }
        app.beginUndoGroup("JustAE Flow — Trim layer");
        var layer = comp.layer(layerIndex);
        layer.outPoint = layer.inPoint + durationSec;
        app.endUndoGroup();
        return JSON.stringify({
            success: true, layerName: layer.name,
            inPoint: layer.inPoint, outPoint: layer.outPoint
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (ignore) {}
        return JSON.stringify({ error: e.toString() });
    }
}

/**
 * Read the VISIBLE adjustment layers of the active comp as shot placeholders,
 * sorted by inPoint. A layer qualifies when adjustmentLayer === true AND it is
 * enabled (the eye toggle is ON). This is what the Storyboard panel polls, so
 * shots are detected automatically — no button — and a placeholder leaves the
 * list the moment its eye is switched off (e.g. after its clip is placed).
 */
function getVisibleAdjustmentLayers() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition." });
        }
        var out = [];
        var adjTotal = 0; // all adjustment layers, visible or hidden
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            var isAdj = false;
            try { isAdj = (layer.adjustmentLayer === true); } catch (_a) {}
            if (!isAdj) continue;
            adjTotal++;
            if (!layer.enabled) continue; // eye toggle OFF → not a pending shot
            var label = 0;
            try { label = Number(layer.label) || 0; } catch (_l) {}
            out.push({
                index: layer.index,
                name: String(layer.name),
                inPoint: layer.inPoint,
                outPoint: layer.outPoint,
                duration: Math.max(0, layer.outPoint - layer.inPoint),
                label: label,
                enabled: true
            });
        }
        out.sort(function (a, b) { return a.inPoint - b.inPoint; });
        return JSON.stringify({
            success: true,
            compName: comp.name,
            frameRate: comp.frameRate,
            adjustmentCount: adjTotal,
            visibleCount: out.length,
            layers: out
        });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

/**
 * Disable (eye off) the adjustment-layer placeholder matching a name + in-point
 * after its generated clip was placed. Matching by name + time survives the
 * index shifts that adding new layers causes. Non-fatal if no match.
 */
function disableAdjustmentLayer(name, inPointSec) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ error: "No active composition." });
        }
        app.beginUndoGroup("JustAE Flow — Disable placeholder");
        var matched = null;
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            var isAdj = false;
            try { isAdj = (layer.adjustmentLayer === true); } catch (_a) {}
            if (!isAdj || !layer.enabled) continue;
            var sameName = (name && String(layer.name) === String(name));
            var sameTime = (typeof inPointSec === "number") && (Math.abs(layer.inPoint - inPointSec) < 0.02);
            if (sameName && sameTime) { matched = layer; break; }
            if (!matched && sameTime) matched = layer; // fallback by time only
        }
        if (matched) {
            matched.enabled = false;
            app.endUndoGroup();
            return JSON.stringify({ success: true, layerName: matched.name });
        }
        app.endUndoGroup();
        return JSON.stringify({ success: false, error: "Placeholder not found." });
    } catch (e) {
        try { app.endUndoGroup(); } catch (ignore) {}
        return JSON.stringify({ error: e.toString() });
    }
}

/* ─── Setup files: the native Save / Open dialogs ────────────────────── */

/**
 * Where to write a shot setup, asked of the user.
 *
 * The dialog lives here rather than in the panel because CEP's own
 * `cep.fs.showSaveDialogEx` is a different call on every host version, while
 * ExtendScript's `File.saveDlg` is the same one After Effects itself uses —
 * and everything else in this panel already crosses the bridge as a JSON
 * envelope, so this stays one road rather than two.
 *
 * `defaultDir` is a hint, not a rule: when the project has never been saved
 * there is no folder to suggest and the dialog opens wherever it likes.
 * Returns `{ path: null }` when the user cancels, which is not an error.
 */
function pickSetupSavePath(defaultName, defaultDir) {
    try {
        var suggestion = String(defaultName || "shot-setup.json");
        if (suggestion.length < 5 || suggestion.substr(suggestion.length - 5).toLowerCase() !== ".json") {
            suggestion += ".json";
        }
        var start = null;
        if (defaultDir) {
            var dir = new Folder(String(defaultDir));
            if (dir.exists) start = new File(dir.fsName + "/" + suggestion);
        }
        if (!start) start = new File(suggestion);
        var chosen = start.saveDlg("Save the shot setup", "JSON files:*.json");
        if (!chosen) return JSON.stringify({ path: null });
        var full = chosen.fsName;
        // A user who types "my-setup" means "my-setup.json"; the dialog does
        // not add the extension on every platform.
        if (full.length < 5 || full.substr(full.length - 5).toLowerCase() !== ".json") full += ".json";
        return JSON.stringify({ path: full });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

/**
 * Which setup file to read back. `{ path: null }` when the user cancels.
 *
 * `openDlg` here is the FILE instance method: it takes the object's own path as
 * the dialog's starting location, which is how the project folder gets
 * suggested. Folder has no `openDlg` — `Folder.selectDlg` picks a folder, not a
 * file in one — so the seed is a File inside the folder rather than the folder
 * itself. With no project folder to start from, the static `File.openDialog`
 * opens wherever the OS was last.
 */
function pickSetupOpenPath(defaultDir) {
    try {
        var chosen = null;
        if (defaultDir) {
            var dir = new Folder(String(defaultDir));
            if (dir.exists) {
                var seed = new File(dir.fsName + "/setup.json");
                chosen = seed.openDlg("Load a shot setup", "JSON files:*.json", false);
            }
        }
        if (!chosen) chosen = File.openDialog("Load a shot setup", "JSON files:*.json", false);
        if (!chosen) return JSON.stringify({ path: null });
        // With multi-select off this is a File, but be safe about an array.
        if (chosen instanceof Array) {
            if (chosen.length === 0) return JSON.stringify({ path: null });
            chosen = chosen[0];
        }
        return JSON.stringify({ path: chosen.fsName });
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}
