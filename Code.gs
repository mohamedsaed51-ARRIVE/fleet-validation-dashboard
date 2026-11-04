/**
 * ARRIVE — Fleet Validation Dashboard API (Google Apps Script)
 * الشيت: "Validation Monthly Report - Fleet 8-9"
 *
 * التصميم: التجميع يتم هنا (74 ألف صف + 5 آلاف) وليس في المتصفح.
 *   buildSnapshot()  -> يقرأ الأوراق الخام (قراءة فقط) ويكتب JSON مجمّع في ورقة DASH_SNAPSHOT
 *   doGet()          -> يرجّع آخر Snapshot فورًا (سريع) كـ JSON
 * الأوراق الخام لا يتم تعديلها نهائيًا. الورقة الوحيدة المضافة: DASH_SNAPSHOT.
 *
 * التشغيل لأول مرة:
 *   1) الصق الملف في Extensions > Apps Script.
 *   2) شغّل setupAll() مرة واحدة ووافق على الصلاحيات (تبني Snapshot وتنشئ تحديث تلقائي كل ساعة).
 *   3) Deploy > New deployment > Web app (Execute as: Me, Access: Anyone with the link) وانسخ الرابط للداشبورد.
 */

var CFG = {
  SHEETS: { delivery: 'مشاكل التسليم', unconfirmed: 'لم يتم التاكيد', rounds: 'round' },
  SNAPSHOT_SHEET: 'DASH_SNAPSHOT',
  CHUNK: 40000,              // حد الخلية 50,000 حرف
  VERSION: 1,
  // أسماء الأعمدة (تُقارن بعد تنظيف المسافات وتوحيد الألف/الياء/التاء المربوطة)
  DELIVERY_COLS: {
    date: ['تاريخ السحب'], awb: ['كود البوليصه'], courier: ['اسم المندوب'], branch: ['الفرع'],
    status: ['حاله الشحنه'], final: ['الحالة النهائية'], solve: ['نوع الحل'], emp: ['اسم الموظف'],
    round: ['Round'], cls: ['تصنيف'], note: ['ملاحظات'], inv: ['نتيجة التحقيق'], month: ['month']
  },
  UNCONF_COLS: {
    date: ['تاريخ السحب'], awb: ['رقم البوليصة'], branch: ['فرع'], emp: ['اسم الموظف'],
    status: ['حالة الشحنة سيستم'], review: ['المراجعه'], group: ['ابلاغ على جروب'], month: ['month']
  },
  // ---------- افتراضات غير مؤكدة (راجعها) ----------
  // A1: الإلغاءات = تصنيف يحتوي "الغاء"، مشاكل التسليم = تصنيف يحتوي "تسليم"
  CANCEL_CLASS_RE: /الغاء/, DELIVERY_CLASS_RE: /تسليم/,
  // A2: FAKE في الإلغاءات = ظهور الكلمة في (نتيجة التحقيق / نوع الحل / ملاحظات / حاله الشحنه)
  FAKE_RE: /fake|فيك|فايك/
};

/* ======================= دوال نقية (قابلة للاختبار خارج Apps Script) ======================= */

function normText_(s) {
  return String(s == null ? '' : s).replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
function clean_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function findCols_(headerRow, spec) {
  var norm = headerRow.map(normText_), idx = {}, missing = [];
  Object.keys(spec).forEach(function (k) {
    var found = -1;
    spec[k].forEach(function (a) { if (found < 0) found = norm.indexOf(normText_(a)); });
    if (found < 0) missing.push(k + ' (' + spec[k][0] + ')'); else idx[k] = found;
  });
  return { idx: idx, missing: missing };
}
function pad2_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

/** يرجّع yyyy-mm-dd أو '' — يقبل Date أو "2026/08/01" أو "7/29/2026" (M/D/Y) */
function dateKey_(v, fmtDate) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : fmtDate(v);
  var s = String(v).trim(), m;
  if ((m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/))) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return m[3] + '-' + pad2_(m[1]) + '-' + pad2_(m[2]);
  return '';
}
function truthy_(v) {
  if (v === true) return 1;
  var s = normText_(v);
  return (s && s !== 'false' && s !== '0' && s !== 'no' && s !== 'لا') ? 1 : 0;
}
function bump_(map, key, n) { map[key] = (map[key] || 0) + (n || 1); }
function addSet_(map, key, val) { (map[key] || (map[key] = {}))[val] = 1; }
function trackMonth_(mr, m, d) {
  if (!d) return;
  var o = mr[m] || (mr[m] = { from: d, to: d });
  if (d < o.from) o.from = d; if (d > o.to) o.to = d;
}

/** ورقة مشاكل التسليم + الإلغاءات (نفس الورقة، التمييز بعمود تصنيف) */
function aggregateOps_(values, fmtDate) {
  var f = findCols_(values[0] || [], CFG.DELIVERY_COLS);
  var need = ['branch', 'emp', 'final', 'cls'].filter(function (k) { return f.idx[k] == null; });
  if (need.length || (f.idx.month == null && f.idx.date == null))
    throw new Error('Delivery sheet: missing columns -> ' + f.missing.join(', '));
  var c = f.idx, facts = {}, days = {}, uniq = {}, monthRange = {}, otherCls = {};
  var q = { rows: 0, blankRows: 0, unclassified: 0, otherClass: 0, finalOther: 0, noDate: 0, roundFilled: 0, noBranch: 0, noEmp: 0 };
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var branch = clean_(row[c.branch]), emp = clean_(row[c.emp]), clsRaw = clean_(row[c.cls]);
    var awb = c.awb != null ? clean_(row[c.awb]) : '';
    var date = c.date != null ? dateKey_(row[c.date], fmtDate) : '';
    if (!branch && !emp && !clsRaw && !awb && !date) { q.blankRows++; continue; }
    q.rows++;
    var m = (c.month != null ? clean_(row[c.month]).toUpperCase() : '') || (date ? date.slice(0, 7) : 'غير محدد');
    if (!date) q.noDate++;
    var cls = normText_(clsRaw), sec;
    if (CFG.CANCEL_CLASS_RE.test(cls)) sec = 'cancel';
    else if (CFG.DELIVERY_CLASS_RE.test(cls)) sec = 'delivery';
    else if (!cls) { sec = 'other'; q.unclassified++; }
    else { sec = 'other'; q.otherClass++; bump_(otherCls, clsRaw, 1); }
    if (!branch) q.noBranch++; if (!emp) q.noEmp++;
    var fin = normText_(row[c.final]), fcode;
    if (/^لم يتم/.test(fin)) fcode = 'noresp'; else if (fin === 'تم الرد') fcode = 'responded'; else { fcode = 'other'; q.finalOther++; }
    var sol = c.solve != null ? clean_(row[c.solve]) : '';
    var ready = /جاهز للاستلام/.test(normText_(sol)) ? 1 : 0;
    var rnd = c.round != null ? clean_(row[c.round]) : '';
    if (rnd) q.roundFilled++;
    var hay = [c.inv, c.solve, c.note, c.status].map(function (i) { return i != null ? normText_(row[i]) : ''; }).join(' | ');
    var fake = CFG.FAKE_RE.test(hay) ? 1 : 0;
    var cr = (fake && c.courier != null) ? clean_(row[c.courier]) : '';
    var key = [m, sec, branch || 'غير محدد بالمصدر', emp || 'غير محدد بالمصدر', rnd, fcode, sol, ready, fake, cr].join('\u0001');
    bump_(facts, key, 1);
    var sk = sec + '|' + m;
    if (date) addSet_(days, sk, date);
    if (awb) addSet_(uniq, sk, awb);
    trackMonth_(monthRange, m, date);
  }
  var out = Object.keys(facts).map(function (k) { var p = k.split('\u0001'); return [p[0], p[1], p[2], p[3], p[4], p[5], p[6], +p[7], +p[8], p[9], facts[k]]; });
  var dayCnt = {}, uniqCnt = {};
  Object.keys(days).forEach(function (k) { dayCnt[k] = Object.keys(days[k]).length; });
  Object.keys(uniq).forEach(function (k) { uniqCnt[k] = Object.keys(uniq[k]).length; });
  return { facts: out, days: dayCnt, uniq: uniqCnt, monthRange: monthRange, otherClasses: otherCls, quality: q };
}

/** ورقة لم يتم التأكيد */
function aggregateUnconfirmed_(values, fmtDate) {
  var f = findCols_(values[0] || [], CFG.UNCONF_COLS);
  var need = ['branch', 'status', 'review'].filter(function (k) { return f.idx[k] == null; });
  if (need.length || (f.idx.month == null && f.idx.date == null))
    throw new Error('Unconfirmed sheet: missing columns -> ' + f.missing.join(', '));
  var c = f.idx, facts = {}, days = {}, uniq = {}, monthRange = {};
  var q = { rows: 0, blankRows: 0, reviewOther: 0, reviewBlank: 0, noDate: 0 };
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var branch = clean_(row[c.branch]), st = clean_(row[c.status]);
    var awb = c.awb != null ? clean_(row[c.awb]) : '';
    var date = c.date != null ? dateKey_(row[c.date], fmtDate) : '';
    if (!branch && !st && !awb && !date) { q.blankRows++; continue; }
    q.rows++;
    var m = (c.month != null ? clean_(row[c.month]).toUpperCase() : '') || (date ? date.slice(0, 7) : 'غير محدد');
    if (!date) q.noDate++;
    var rv = row[c.review], rev;
    if (rv === true) rev = 'TRUE'; else if (rv === false) rev = 'FALSE';
    else { var t = clean_(rv).toUpperCase(); rev = t === 'TRUE' || t === 'FAKE' ? t : (t ? 'OTHER' : 'BLANK'); }
    if (rev === 'OTHER') q.reviewOther++; if (rev === 'BLANK') q.reviewBlank++;
    var grp = c.group != null ? truthy_(row[c.group]) : 0;
    var emp = c.emp != null ? clean_(row[c.emp]) : '';
    var key = [m, branch || 'غير محدد بالمصدر', emp || 'غير محدد بالمصدر', st || 'غير محدد بالمصدر', rev, grp].join('\u0001');
    bump_(facts, key, 1);
    if (date) addSet_(days, m, date);
    if (awb) addSet_(uniq, m, awb);
    trackMonth_(monthRange, m, date);
  }
  var out = Object.keys(facts).map(function (k) { var p = k.split('\u0001'); return [p[0], p[1], p[2], p[3], p[4], +p[5], facts[k]]; });
  var dayCnt = {}, uniqCnt = {};
  Object.keys(days).forEach(function (k) { dayCnt[k] = Object.keys(days[k]).length; });
  Object.keys(uniq).forEach(function (k) { uniqCnt[k] = Object.keys(uniq[k]).length; });
  return { facts: out, days: dayCnt, uniq: uniqCnt, monthRange: monthRange, quality: q };
}

/** ورقة round: صف 1 = أوقات، صف 2 = Round 1..5 + Total، البيانات من الصف 3 */
function aggregateRounds_(values) {
  var hr = -1, i;
  for (i = 0; i < Math.min(values.length, 6); i++) {
    if (values[i].some(function (v) { return normText_(v) === 'round 1'; })) { hr = i; break; }
  }
  if (hr < 0) throw new Error('Rounds sheet: header row with "Round 1" not found');
  var h = values[hr].map(normText_);
  var rc = [1, 2, 3, 4, 5].map(function (n) { return h.indexOf('round ' + n); });
  var tc = h.indexOf('total'), mc = 0, dc = 1;
  var labels = rc.map(function (ci, k) { return ci >= 0 && hr > 0 ? clean_(values[hr - 1][ci]) || ('Round ' + (k + 1)) : 'Round ' + (k + 1); });
  var byM = {}, mismatch = 0;
  for (i = hr + 1; i < values.length; i++) {
    var row = values[i], m = clean_(row[mc]).toUpperCase();
    if (!m) continue;
    var o = byM[m] || (byM[m] = { m: m, r: [0, 0, 0, 0, 0], total: 0, days: 0 });
    var sum = 0;
    rc.forEach(function (ci, k) { var v = ci >= 0 ? Number(row[ci]) || 0 : 0; o.r[k] += v; sum += v; });
    var tot = tc >= 0 ? Number(row[tc]) || 0 : sum;
    if (tc >= 0 && tot !== sum) mismatch++;
    o.total += tot; if (sum > 0) o.days++;
  }
  return { labels: labels, byMonth: Object.keys(byM).map(function (k) { return byM[k]; }), totalMismatchRows: mismatch };
}

function buildSnapshotObject_(sheetValues, fmtDate, nowIso) {
  var ops = aggregateOps_(sheetValues.delivery, fmtDate);
  var unc = aggregateUnconfirmed_(sheetValues.unconfirmed, fmtDate);
  var rounds = sheetValues.rounds ? aggregateRounds_(sheetValues.rounds) : null;
  var months = {};
  [ops.monthRange, unc.monthRange].forEach(function (mr) {
    Object.keys(mr).forEach(function (m) {
      var o = months[m] || (months[m] = { m: m, from: mr[m].from, to: mr[m].to });
      if (mr[m].from < o.from) o.from = mr[m].from; if (mr[m].to > o.to) o.to = mr[m].to;
    });
  });
  var monthList = Object.keys(months).map(function (k) { return months[k]; })
    .sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
  return {
    version: CFG.VERSION, generatedAt: nowIso,
    months: monthList,
    opsCols: ['m', 'sec', 'br', 'emp', 'rnd', 'fin', 'sol', 'ready', 'fake', 'cr', 'n'],
    ops: ops.facts,
    uncCols: ['m', 'br', 'emp', 'st', 'rev', 'grp', 'n'],
    unc: unc.facts,
    days: { ops: ops.days, unc: unc.days },
    uniq: { ops: ops.uniq, unc: unc.uniq },
    rounds: rounds,
    quality: { ops: ops.quality, unc: unc.quality, otherClasses: ops.otherClasses },
    assumptions: {
      cancelClassRe: String(CFG.CANCEL_CLASS_RE), deliveryClassRe: String(CFG.DELIVERY_CLASS_RE), fakeRe: String(CFG.FAKE_RE)
    }
  };
}

/* ======================= طبقة Apps Script ======================= */

function findSheet_(ss, name) {
  var want = normText_(name), sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) if (normText_(sheets[i].getName()) === want) return sheets[i];
  return null;
}
/** قراءة على دفعات: قراءة الورقة كلها مرة واحدة تفشل (Requested data exceeds the maximum allowed size) */
function readAll_(sh) {
  var lr = sh.getLastRow(), lc = sh.getLastColumn(), STEP = 3000;
  if (lr < 1) return [];
  var out = [];
  for (var r = 1; r <= lr; r += STEP) {
    var n = Math.min(STEP, lr - r + 1);
    var part = sh.getRange(r, 1, n, lc).getValues();
    for (var i = 0; i < part.length; i++) out.push(part[i]);
  }
  return out;
}

function buildSnapshot() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another build is running');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), tz = ss.getSpreadsheetTimeZone();
    var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
    var sd = findSheet_(ss, CFG.SHEETS.delivery), su = findSheet_(ss, CFG.SHEETS.unconfirmed), sr = findSheet_(ss, CFG.SHEETS.rounds);
    if (!sd || !su) throw new Error('Source sheet not found (delivery / unconfirmed)');
    var snap = buildSnapshotObject_({ delivery: readAll_(sd), unconfirmed: readAll_(su), rounds: sr ? readAll_(sr) : null }, fmt, new Date().toISOString());
    var json = JSON.stringify(snap), rows = [];
    for (var i = 0; i < json.length; i += CFG.CHUNK) rows.push([json.substr(i, CFG.CHUNK)]);
    var out = findSheet_(ss, CFG.SNAPSHOT_SHEET) || ss.insertSheet(CFG.SNAPSHOT_SHEET);
    out.clearContents();
    out.getRange(1, 1, 1, 3).setValues([[snap.generatedAt, rows.length, json.length]]);
    out.getRange(2, 1, rows.length, 1).setNumberFormat('@').setValues(rows);
    SpreadsheetApp.flush();
    return { ok: true, chunks: rows.length, chars: json.length };
  } finally { lock.releaseLock(); }
}

function readSnapshot_() {
  var out = findSheet_(SpreadsheetApp.getActiveSpreadsheet(), CFG.SNAPSHOT_SHEET);
  if (!out || out.getLastRow() < 2) return null;
  var n = Number(out.getRange(1, 2).getValue());
  return out.getRange(2, 1, n, 1).getValues().map(function (r) { return r[0]; }).join('');
}

function doGet(e) {
  var body, warn = '';
  try {
    // ?action=refresh -> يعيد بناء الـ Snapshot أولًا ثم يرجّعه (زر «تحديث» في الداشبورد)
    if (e && e.parameter && e.parameter.action === 'refresh') {
      try { buildSnapshot(); }
      catch (err) {
        // لو بناء آخر شغّال حاليًا نرجّع آخر Snapshot متاح مع تنبيه، وأي خطأ آخر يُرجَّع كما هو
        if (String(err && err.message) !== 'Another build is running') throw err;
        warn = 'build-in-progress';
      }
    }
    var json = readSnapshot_();
    body = json
      ? '{"ok":true' + (warn ? ',"warn":"' + warn + '"' : '') + ',"data":' + json + '}'
      : JSON.stringify({ ok: false, error: 'snapshot-missing: run setupAll() or buildSnapshot()' });
  } catch (err) { body = JSON.stringify({ ok: false, error: String(err && err.message || err) }); }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function installHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'buildSnapshot') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('buildSnapshot').timeBased().everyHours(1).create();
}
function setupAll() { var r = buildSnapshot(); installHourlyTrigger(); return r; }
