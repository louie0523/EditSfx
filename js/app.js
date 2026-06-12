/* =========================================================================
 * EditSfx · app.js
 * UI 전체를 조립하는 컨트롤러. 엔진/파형 모듈을 호출만 한다.
 * 세 가지 작업 모드를 관리한다:
 *   1) 개별 파일 편집 : 자르기 + 효과 + 선택구간 미리듣기 + 노멀라이즈 + 무음제거
 *   2) 이어붙이기     : 순서 + 사이 간격/크로스페이드 + 트랙별 효과
 *   3) 합성/믹스      : 시작 시점 + 음량 + 좌우 팬 + 트랙별 효과 + 자동 정규화
 * 두 목록 모드는 결과 파형 미리보기와 "편집기로 보내기"를 공유한다.
 * ========================================================================= */
(function (global) {
  'use strict';

  const NS = global.EditSfx;
  const Engine = NS.Engine;
  const Waveform = NS.Waveform;

  /* ----------------------------- 공통 유틸 ----------------------------- */
  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  let uid = 0;
  const nextId = function () { return 'id' + (++uid); };

  function fmtTime(sec) {
    if (!isFinite(sec)) return '0.000s';
    return sec.toFixed(3) + 's';
  }
  function fmtMeta(buffer) {
    return (
      buffer.duration.toFixed(3) + 's · ' +
      (buffer.numberOfChannels === 1 ? '모노' : '스테레오') + ' · ' +
      Math.round(buffer.sampleRate / 100) / 10 + 'kHz'
    );
  }

  let toastTimer = null;
  function toast(msg, type) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  function setStatus(text, state) {
    const led = $('#status-led');
    const txt = $('#status-text');
    if (txt) txt.textContent = text;
    if (led) led.className = 'led' + (state ? ' ' + state : '');
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function sanitizeName(name) {
    return (name || 'sound').replace(/\.[^.]+$/, '').replace(/[^\w가-힣\-]+/g, '_').slice(0, 40) || 'sound';
  }

  /* ----------------------------- 재생 관리 ----------------------------- */
  let currentSource = null;
  let rafId = 0;
  function stopPlayback() {
    if (currentSource) {
      try { currentSource.stop(); } catch (e) {}
      currentSource = null;
    }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }
  function playBuffer(buffer, onTick, onEnd) {
    stopPlayback();
    const ctx = Engine.getContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = ctx.currentTime;
    src.start();
    currentSource = src;
    src.onended = function () {
      if (currentSource === src) currentSource = null;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (onEnd) onEnd();
    };
    if (onTick) {
      const tick = function () {
        if (currentSource !== src) return;
        onTick(ctx.currentTime - startAt);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }
  }

  /* ----------------------------- 파일 디코딩 ----------------------------- */
  function decodeFiles(fileList) {
    const files = Array.prototype.slice.call(fileList).filter(function (f) {
      return /audio|\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.type + f.name);
    });
    if (!files.length) {
      toast('지원하는 오디오 파일(mp3, wav, ogg 등)을 올려 주세요.', 'error');
      return Promise.resolve([]);
    }
    setStatus('파일 디코딩 중…', 'busy');
    return Promise.all(
      files.map(function (f) {
        return Engine.decodeFile(f).then(
          function (buf) { return { id: nextId(), name: f.name, buffer: buf }; },
          function (err) { toast(f.name + ': ' + err.message, 'error'); return null; }
        );
      })
    ).then(function (tracks) {
      setStatus('준비 완료', '');
      return tracks.filter(Boolean);
    });
  }

  function bindDrop(zone, input, handler) {
    zone.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      handler(input.files);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('dragover'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handler(e.dataTransfer.files);
    });
  }

  /* ----------------------------- 탭 ----------------------------- */
  function activateTab(name) {
    $$('.xp-tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name); });
    $$('.xp-tabpanel').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
    stopPlayback();
  }
  function initTabs() {
    $$('.xp-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { activateTab(tab.getAttribute('data-tab')); });
    });
  }

  /* ----------------------------- 트랙별 효과(공통) ----------------------------- */
  function defaultFx() {
    return { speed: 1, semitones: 0, gain: 1, fadeInSec: 0, fadeOutSec: 0, reverse: false };
  }
  function fxIsIdentity(fx) {
    return fx.speed === 1 && fx.semitones === 0 && fx.gain === 1 &&
      !fx.fadeInSec && !fx.fadeOutSec && !fx.reverse;
  }
  /** 트랙 효과를 적용한 버퍼를 돌려준다(동일 설정이면 캐시 재사용). */
  function applyTrackFx(track) {
    const fx = track.fx || (track.fx = defaultFx());
    if (fxIsIdentity(fx)) return Promise.resolve(track.buffer);
    const key = JSON.stringify(fx);
    if (track._fxKey === key && track._fxBuf) return Promise.resolve(track._fxBuf);
    return Engine.applyEffects(track.buffer, fx).then(function (buf) {
      track._fxKey = key; track._fxBuf = buf; return buf;
    });
  }

  /** 접이식 효과 컨트롤(속도/피치/음량/페이드/역재생)을 만든다. */
  function buildFxBox(track, onChange) {
    const fx = track.fx || (track.fx = defaultFx());
    const d = document.createElement('details');
    d.className = 'track-fx';
    const sum = document.createElement('summary');
    sum.textContent = '효과 (피치·속도·음량·페이드·역재생) ▾';
    d.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'track-fx-body';
    d.appendChild(body);

    function invalidate() { track._fxKey = null; if (onChange) onChange(); }

    function rangeField(label, key, min, max, step, fmt) {
      const f = document.createElement('label'); f.className = 'fx-field';
      const cap = document.createElement('span'); cap.className = 'fx-cap';
      const r = document.createElement('input');
      r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = fx[key];
      function upd() { cap.textContent = label + ': ' + fmt(r.value); }
      r.addEventListener('input', function () { fx[key] = parseFloat(r.value); upd(); invalidate(); });
      upd(); f.appendChild(cap); f.appendChild(r); body.appendChild(f);
    }
    function numField(label, key) {
      const f = document.createElement('label'); f.className = 'fx-field fx-inline';
      const cap = document.createElement('span'); cap.textContent = label;
      const r = document.createElement('input');
      r.type = 'number'; r.min = '0'; r.step = '0.05'; r.value = fx[key]; r.style.width = '64px';
      r.addEventListener('change', function () { fx[key] = Math.max(0, parseFloat(r.value) || 0); invalidate(); });
      f.appendChild(cap); f.appendChild(r); body.appendChild(f);
    }
    rangeField('속도', 'speed', 0.5, 2, 0.01, function (v) { return Number(v).toFixed(2) + '×'; });
    rangeField('피치', 'semitones', -12, 12, 1, function (v) { return (v > 0 ? '+' : '') + v + '반음'; });
    rangeField('음량', 'gain', 0, 3, 0.05, function (v) { return Number(v).toFixed(2) + '×'; });
    numField('페이드인(초)', 'fadeInSec');
    numField('페이드아웃(초)', 'fadeOutSec');
    const rev = document.createElement('label'); rev.className = 'fx-field fx-inline';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!fx.reverse;
    cb.addEventListener('change', function () { fx.reverse = cb.checked; invalidate(); });
    rev.appendChild(cb); rev.appendChild(document.createTextNode(' 역재생')); body.appendChild(rev);
    return d;
  }

  /** 트랙 원본 파형 썸네일 캔버스. */
  function makeThumb(buffer) {
    const c = document.createElement('canvas');
    c.className = 'thumb';
    // 레이아웃 후 그려야 폭이 잡히므로 다음 프레임에 렌더
    requestAnimationFrame(function () { NS.drawStaticWaveform(c, buffer); });
    return c;
  }

  /** 디코딩된 버퍼를 편집기로 보낸다. */
  function sendToEditor(buffer, name) {
    loadIntoEditor({ buffer: buffer, name: name });
    activateTab('edit');
    toast('편집기로 보냈습니다. 자르기·효과를 이어서 적용하세요.', 'success');
  }

  /* ========================================================================
   * 모드 1: 개별 파일 편집
   * ====================================================================== */
  const editor = { original: null, working: null, wave: null, name: 'sound' };

  function initEditor() {
    bindDrop($('#edit-drop'), $('#edit-file'), function (files) {
      decodeFiles(files).then(function (tracks) {
        if (!tracks.length) return;
        loadIntoEditor(tracks[0]);
      });
    });

    editor.wave = new Waveform($('#edit-canvas'), {
      onSelect: function (s, e) {
        $('#sel-start').textContent = fmtTime(s);
        $('#sel-end').textContent = fmtTime(e);
        $('#sel-dur').textContent = fmtTime(e - s);
      }
    });

    bindRangeLabel('#fx-speed', '#fx-speed-val', function (v) { return Number(v).toFixed(2) + '×'; });
    bindRangeLabel('#fx-pitch', '#fx-pitch-val', function (v) { return (v > 0 ? '+' : '') + v + ' 반음'; });
    bindRangeLabel('#fx-gain', '#fx-gain-val', function (v) {
      const db = 20 * Math.log10(Number(v) || 0.0001);
      return Number(v).toFixed(2) + '× (' + (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB)';
    });

    $('#btn-play').addEventListener('click', previewEdit);
    $('#btn-preview-sel').addEventListener('click', previewSelection);
    $('#btn-stop').addEventListener('click', function () { stopPlayback(); editor.wave.setPlayhead(-1); });
    $('#btn-trim').addEventListener('click', applyTrim);
    $('#btn-apply-fx').addEventListener('click', bakeEffects);
    $('#btn-normalize').addEventListener('click', normalizeEditor);
    $('#btn-trim-silence').addEventListener('click', trimSilenceEditor);
    $('#btn-reset').addEventListener('click', resetEditor);
    $('#btn-export-edit').addEventListener('click', exportEdit);
  }

  function bindRangeLabel(rangeSel, labelSel, fmt) {
    const r = $(rangeSel), l = $(labelSel);
    const update = function () { l.textContent = fmt(r.value); };
    r.addEventListener('input', update);
    update();
  }

  function loadIntoEditor(track) {
    editor.original = track.buffer;
    editor.working = track.buffer;
    editor.name = sanitizeName(track.name);
    $('#edit-empty').hidden = true;
    $('#edit-canvas').hidden = false;
    $('#edit-tools').hidden = false;
    $('#edit-info').textContent = track.name + '  —  ' + fmtMeta(track.buffer);
    editor.wave.setBuffer(track.buffer);
    setStatus('불러옴: ' + track.name, '');
    toast('불러왔습니다. 파형을 드래그하면 구간을 선택할 수 있어요.', 'success');
  }

  function getFx() {
    return {
      speed: parseFloat($('#fx-speed').value),
      semitones: parseFloat($('#fx-pitch').value),
      gain: parseFloat($('#fx-gain').value),
      fadeInSec: parseFloat($('#fx-fadein').value) || 0,
      fadeOutSec: parseFloat($('#fx-fadeout').value) || 0,
      reverse: $('#fx-reverse').checked
    };
  }

  function previewEdit() {
    if (!editor.working) return;
    setStatus('효과 적용 중…', 'busy');
    Engine.applyEffects(editor.working, getFx()).then(function (buf) {
      setStatus('재생 중', '');
      const dur = buf.duration;
      playBuffer(
        buf,
        function (t) { editor.wave.setPlayhead((t / dur) * editor.working.duration); },
        function () { setStatus('준비 완료', ''); editor.wave.setPlayhead(-1); }
      );
    });
  }

  /** 선택 구간(=잘릴 부분)만 효과까지 적용해 미리 들려준다. */
  function previewSelection() {
    if (!editor.working) return;
    const sr = editor.working.sampleRate;
    const sel = editor.wave.getSelection();
    let s = Math.max(0, Math.floor(sel.start * sr));
    let e = Math.min(editor.working.length, Math.floor(sel.end * sr));
    if (e - s < Math.round(0.005 * sr)) { s = 0; e = editor.working.length; } // 선택 없으면 전체
    const channels = [];
    for (let c = 0; c < editor.working.numberOfChannels; c++) {
      channels.push(editor.working.getChannelData(c).slice(s, e));
    }
    const seg = Engine.channelsToBuffer(channels, sr);
    const baseStart = s / sr, baseDur = (e - s) / sr;
    setStatus('선택 구간 효과 적용 중…', 'busy');
    Engine.applyEffects(seg, getFx()).then(function (buf) {
      setStatus('재생 중(선택 구간)', '');
      const dur = buf.duration;
      playBuffer(
        buf,
        function (t) { editor.wave.setPlayhead(baseStart + (t / dur) * baseDur); },
        function () { setStatus('준비 완료', ''); editor.wave.setPlayhead(-1); }
      );
    });
  }

  function applyTrim() {
    if (!editor.working) return;
    const sel = editor.wave.getSelection();
    try {
      const trimmed = Engine.trim(editor.working, sel.start, sel.end);
      editor.working = trimmed;
      editor.wave.setBuffer(trimmed);
      $('#edit-info').textContent = '자른 결과  —  ' + fmtMeta(trimmed);
      toast('선택 구간으로 잘랐습니다. ‘자른 부분 미리듣기’로 확인해 보세요.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function bakeEffects() {
    if (!editor.working) return;
    setStatus('효과 굽는 중…', 'busy');
    Engine.applyEffects(editor.working, getFx()).then(function (buf) {
      editor.working = buf;
      editor.wave.setBuffer(buf);
      resetFxControls();
      $('#edit-info').textContent = '효과 적용됨  —  ' + fmtMeta(buf);
      setStatus('준비 완료', '');
      toast('현재 효과를 파형에 적용했습니다.', 'success');
    });
  }

  function normalizeEditor() {
    if (!editor.working) { toast('먼저 사운드를 불러오세요.', 'error'); return; }
    editor.working = Engine.normalize(editor.working, 0.99);
    editor.wave.setBuffer(editor.working);
    $('#edit-info').textContent = '노멀라이즈됨  —  ' + fmtMeta(editor.working);
    toast('가장 큰 소리가 최대치에 닿도록 음량을 맞췄습니다.', 'success');
  }

  function trimSilenceEditor() {
    if (!editor.working) { toast('먼저 사운드를 불러오세요.', 'error'); return; }
    try {
      const out = Engine.trimSilence(editor.working);
      editor.working = out;
      editor.wave.setBuffer(out);
      $('#edit-info').textContent = '양끝 무음 제거됨  —  ' + fmtMeta(out);
      toast('앞뒤의 무음 구간을 잘라냈습니다.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }

  function resetFxControls() {
    $('#fx-speed').value = 1; $('#fx-pitch').value = 0; $('#fx-gain').value = 1;
    $('#fx-fadein').value = 0; $('#fx-fadeout').value = 0; $('#fx-reverse').checked = false;
    ['#fx-speed', '#fx-pitch', '#fx-gain'].forEach(function (s) {
      $(s).dispatchEvent(new Event('input'));
    });
  }

  function resetEditor() {
    if (!editor.original) return;
    editor.working = editor.original;
    editor.wave.setBuffer(editor.original);
    resetFxControls();
    $('#edit-info').textContent = '원본으로 복원됨  —  ' + fmtMeta(editor.original);
    toast('원본으로 되돌렸습니다.', 'success');
  }

  function exportEdit() {
    if (!editor.working) { toast('먼저 사운드를 불러오세요.', 'error'); return; }
    setStatus('내보내는 중…', 'busy');
    Engine.applyEffects(editor.working, getFx()).then(function (buf) {
      exportBuffer(buf, $('#edit-format').value, editor.name + '_edit');
    });
  }

  /* ========================================================================
   * 모드 2: 이어붙이기
   * ====================================================================== */
  const concatTracks = [];

  function initConcat() {
    bindDrop($('#concat-drop'), $('#concat-file'), function (files) {
      decodeFiles(files).then(function (tracks) {
        tracks.forEach(function (t) {
          t.gapAfterSec = 0.2;
          t.crossfadeAfterSec = 0;
          t.fx = defaultFx();
          concatTracks.push(t);
        });
        renderConcatList();
        hideConcatResult();
      });
    });
    $('#btn-concat-play').addEventListener('click', playConcat);
    $('#btn-concat-wave').addEventListener('click', showConcatWave);
    $('#btn-concat-toedit').addEventListener('click', concatToEditor);
    $('#btn-concat-export').addEventListener('click', exportConcat);
    $('#btn-concat-clear').addEventListener('click', function () {
      concatTracks.length = 0; renderConcatList(); hideConcatResult(); stopPlayback();
    });
  }

  function hideConcatResult() { $('#concat-result-wrap').hidden = true; }

  function renderConcatList() {
    const list = $('#concat-list');
    list.innerHTML = '';
    $('#concat-empty').hidden = concatTracks.length > 0;
    $('#concat-actions').hidden = concatTracks.length === 0;

    concatTracks.forEach(function (t, idx) {
      const li = document.createElement('li');
      li.className = 'track-item';
      li.draggable = true;
      li.dataset.id = t.id;

      const row = document.createElement('div');
      row.className = 'track-row';
      row.innerHTML =
        '<span class="grip" title="드래그로 순서 변경">⠿</span>' +
        '<span class="tname">' + (idx + 1) + '. ' + escapeHtml(t.name) + '</span>' +
        '<span class="meta">' + fmtMeta(t.buffer) + '</span>';
      const rm = document.createElement('button');
      rm.className = 'xp-btn'; rm.textContent = '삭제';
      rm.addEventListener('click', function () {
        const i = concatTracks.indexOf(t);
        if (i >= 0) concatTracks.splice(i, 1);
        renderConcatList(); hideConcatResult();
      });
      row.appendChild(rm);
      li.appendChild(row);

      li.appendChild(makeThumb(t.buffer));

      // 경계 옵션(마지막 항목 제외): 뒤 간격 + 크로스페이드
      if (idx < concatTracks.length - 1) {
        const opts = document.createElement('div');
        opts.className = 'track-opts';

        const gapL = document.createElement('label');
        gapL.appendChild(document.createTextNode('뒤 간격(초) '));
        const gap = document.createElement('input');
        gap.type = 'number'; gap.step = '0.05'; gap.min = '0'; gap.value = t.gapAfterSec; gap.style.width = '64px';
        gap.addEventListener('change', function () {
          t.gapAfterSec = Math.max(0, parseFloat(gap.value) || 0); hideConcatResult();
        });
        gapL.appendChild(gap);
        opts.appendChild(gapL);

        const xfL = document.createElement('label');
        xfL.title = '0보다 크면 다음 소리와 그만큼 겹쳐 부드럽게 섞입니다(간격 대신 적용).';
        xfL.appendChild(document.createTextNode('크로스페이드(초) '));
        const xf = document.createElement('input');
        xf.type = 'number'; xf.step = '0.05'; xf.min = '0'; xf.value = t.crossfadeAfterSec; xf.style.width = '64px';
        xf.addEventListener('change', function () {
          t.crossfadeAfterSec = Math.max(0, parseFloat(xf.value) || 0); hideConcatResult();
        });
        xfL.appendChild(xf);
        opts.appendChild(xfL);

        li.appendChild(opts);
      } else {
        const last = document.createElement('div');
        last.className = 'track-opts';
        last.innerHTML = '<span class="hint">(마지막 소리)</span>';
        li.appendChild(last);
      }

      li.appendChild(buildFxBox(t, hideConcatResult));
      bindReorder(li, concatTracks, function () { renderConcatList(); hideConcatResult(); });
      list.appendChild(li);
    });
  }

  function buildConcat() {
    return Promise.all(concatTracks.map(applyTrackFx)).then(function (buffers) {
      return Engine.concat(concatTracks.map(function (t, i) {
        return { buffer: buffers[i], gapAfterSec: t.gapAfterSec, crossfadeAfterSec: t.crossfadeAfterSec };
      }));
    });
  }

  function playConcat() {
    if (!concatTracks.length) return;
    setStatus('이어붙이는 중…', 'busy');
    buildConcat().then(function (buf) {
      setStatus('재생 중', '');
      playBuffer(buf, null, function () { setStatus('준비 완료', ''); });
    }, function (err) { toast(err.message, 'error'); });
  }

  function showConcatWave() {
    if (!concatTracks.length) return;
    setStatus('결과 파형 만드는 중…', 'busy');
    buildConcat().then(function (buf) {
      $('#concat-result-wrap').hidden = false;
      $('#concat-result-meta').textContent = '— ' + fmtMeta(buf);
      requestAnimationFrame(function () { NS.drawStaticWaveform($('#concat-canvas'), buf); });
      setStatus('준비 완료', '');
    }, function (err) { toast(err.message, 'error'); });
  }

  function concatToEditor() {
    if (!concatTracks.length) return;
    setStatus('편집기로 보내는 중…', 'busy');
    buildConcat().then(function (buf) {
      setStatus('준비 완료', '');
      sendToEditor(buf, 'editsfx_joined');
    }, function (err) { toast(err.message, 'error'); });
  }

  function exportConcat() {
    if (concatTracks.length < 1) { toast('이어붙일 사운드를 올려 주세요.', 'error'); return; }
    setStatus('내보내는 중…', 'busy');
    buildConcat().then(function (buf) {
      exportBuffer(buf, $('#concat-format').value, 'editsfx_joined');
    }, function (err) { toast(err.message, 'error'); });
  }

  /* ========================================================================
   * 모드 3: 합성/믹스
   * ====================================================================== */
  const mixTracks = [];

  function initMix() {
    bindDrop($('#mix-drop'), $('#mix-file'), function (files) {
      decodeFiles(files).then(function (tracks) {
        tracks.forEach(function (t) {
          t.startSec = 0; t.gain = 1; t.pan = 0;
          t.fx = defaultFx();
          mixTracks.push(t);
        });
        renderMixList();
        hideMixResult();
      });
    });
    $('#btn-mix-play').addEventListener('click', playMix);
    $('#btn-mix-wave').addEventListener('click', showMixWave);
    $('#btn-mix-toedit').addEventListener('click', mixToEditor);
    $('#btn-mix-export').addEventListener('click', exportMix);
    $('#mix-normalize').addEventListener('change', hideMixResult);
    $('#btn-mix-clear').addEventListener('click', function () {
      mixTracks.length = 0; renderMixList(); hideMixResult(); stopPlayback();
    });
  }

  function hideMixResult() { $('#mix-result-wrap').hidden = true; }

  function renderMixList() {
    const list = $('#mix-list');
    list.innerHTML = '';
    $('#mix-empty').hidden = mixTracks.length > 0;
    $('#mix-actions').hidden = mixTracks.length === 0;

    mixTracks.forEach(function (t) {
      const li = document.createElement('li');
      li.className = 'track-item';

      const row = document.createElement('div');
      row.className = 'track-row';
      row.innerHTML =
        '<span class="tname">' + escapeHtml(t.name) + '</span>' +
        '<span class="meta">' + fmtMeta(t.buffer) + '</span>';
      const rm = document.createElement('button');
      rm.className = 'xp-btn'; rm.textContent = '삭제';
      rm.addEventListener('click', function () {
        const i = mixTracks.indexOf(t);
        if (i >= 0) mixTracks.splice(i, 1);
        renderMixList(); hideMixResult();
      });
      row.appendChild(rm);
      li.appendChild(row);

      li.appendChild(makeThumb(t.buffer));

      const opts = document.createElement('div');
      opts.className = 'track-opts';

      const startL = document.createElement('label');
      startL.appendChild(document.createTextNode('시작(초) '));
      const start = document.createElement('input');
      start.type = 'number'; start.step = '0.05'; start.min = '0'; start.value = t.startSec; start.style.width = '64px';
      start.addEventListener('change', function () { t.startSec = Math.max(0, parseFloat(start.value) || 0); hideMixResult(); });
      startL.appendChild(start); opts.appendChild(startL);

      const gainL = document.createElement('label');
      gainL.appendChild(document.createTextNode('음량(×) '));
      const gain = document.createElement('input');
      gain.type = 'number'; gain.step = '0.1'; gain.min = '0'; gain.value = t.gain; gain.style.width = '60px';
      gain.addEventListener('change', function () { t.gain = Math.max(0, parseFloat(gain.value) || 0); hideMixResult(); });
      gainL.appendChild(gain); opts.appendChild(gainL);

      const panL = document.createElement('label');
      panL.title = '왼쪽(-1) ~ 가운데(0) ~ 오른쪽(+1). 좌우 위치를 정합니다.';
      const panCap = document.createElement('span');
      function panText(v) { v = Number(v); return v === 0 ? '가운데' : (v < 0 ? '왼쪽 ' + Math.round(-v * 100) + '%' : '오른쪽 ' + Math.round(v * 100) + '%'); }
      panCap.textContent = '팬: ' + panText(t.pan) + ' ';
      const pan = document.createElement('input');
      pan.type = 'range'; pan.min = '-1'; pan.max = '1'; pan.step = '0.1'; pan.value = t.pan; pan.style.width = '120px';
      pan.addEventListener('input', function () { t.pan = parseFloat(pan.value); panCap.textContent = '팬: ' + panText(t.pan) + ' '; hideMixResult(); });
      panL.appendChild(panCap); panL.appendChild(pan); opts.appendChild(panL);

      li.appendChild(opts);
      li.appendChild(buildFxBox(t, hideMixResult));
      list.appendChild(li);
    });
  }

  function buildMix() {
    return Promise.all(mixTracks.map(applyTrackFx)).then(function (buffers) {
      return Engine.mix(
        mixTracks.map(function (t, i) {
          return { buffer: buffers[i], startSec: t.startSec, gain: t.gain, pan: t.pan };
        }),
        { normalize: $('#mix-normalize').checked }
      );
    });
  }

  function playMix() {
    if (!mixTracks.length) return;
    setStatus('합성 중…', 'busy');
    buildMix().then(function (buf) {
      setStatus('재생 중', '');
      playBuffer(buf, null, function () { setStatus('준비 완료', ''); });
    }, function (err) { toast(err.message, 'error'); });
  }

  function showMixWave() {
    if (!mixTracks.length) return;
    setStatus('결과 파형 만드는 중…', 'busy');
    buildMix().then(function (buf) {
      $('#mix-result-wrap').hidden = false;
      $('#mix-result-meta').textContent = '— ' + fmtMeta(buf);
      requestAnimationFrame(function () { NS.drawStaticWaveform($('#mix-canvas'), buf); });
      setStatus('준비 완료', '');
    }, function (err) { toast(err.message, 'error'); });
  }

  function mixToEditor() {
    if (!mixTracks.length) return;
    setStatus('편집기로 보내는 중…', 'busy');
    buildMix().then(function (buf) {
      setStatus('준비 완료', '');
      sendToEditor(buf, 'editsfx_mixed');
    }, function (err) { toast(err.message, 'error'); });
  }

  function exportMix() {
    if (mixTracks.length < 1) { toast('합성할 사운드를 올려 주세요.', 'error'); return; }
    setStatus('내보내는 중…', 'busy');
    buildMix().then(function (buf) {
      exportBuffer(buf, $('#mix-format').value, 'editsfx_mixed');
    }, function (err) { toast(err.message, 'error'); });
  }

  /* ----------------------------- 내보내기 공통 ----------------------------- */
  function exportBuffer(buffer, format, baseName) {
    try {
      let blob, ext;
      if (format === 'mp3') {
        blob = Engine.exportMp3(buffer, 192);
        if (!blob) {
          toast('MP3 인코더를 불러오지 못해 WAV로 저장합니다.', 'error');
          blob = Engine.exportWav(buffer); ext = 'wav';
        } else { ext = 'mp3'; }
      } else {
        blob = Engine.exportWav(buffer); ext = 'wav';
      }
      download(blob, baseName + '.' + ext);
      setStatus('저장 완료: ' + baseName + '.' + ext, '');
      toast('저장했습니다: ' + baseName + '.' + ext, 'success');
    } catch (err) {
      setStatus('오류', 'err');
      toast('내보내기 실패: ' + err.message, 'error');
    }
  }

  /* ----------------------------- 드래그 정렬 ----------------------------- */
  function bindReorder(li, arr, rerender) {
    li.addEventListener('dragstart', function (e) {
      li.classList.add('dragging');
      e.dataTransfer.setData('text/plain', li.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', function () { li.classList.remove('dragging'); });
    li.addEventListener('dragover', function (e) { e.preventDefault(); li.classList.add('dragover'); });
    li.addEventListener('dragleave', function () { li.classList.remove('dragover'); });
    li.addEventListener('drop', function (e) {
      e.preventDefault();
      li.classList.remove('dragover');
      const fromId = e.dataTransfer.getData('text/plain');
      const fromIdx = arr.findIndex(function (t) { return t.id === fromId; });
      const toIdx = arr.findIndex(function (t) { return t.id === li.dataset.id; });
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const moved = arr.splice(fromIdx, 1)[0];
      arr.splice(toIdx, 0, moved);
      rerender();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ----------------------------- 시계 + 부팅 ----------------------------- */
  function startClock() {
    const el = $('#clock');
    if (!el) return;
    const tick = function () {
      const d = new Date();
      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      const ap = h < 12 ? '오전' : '오후';
      h = h % 12 || 12;
      el.textContent = ap + ' ' + h + ':' + m;
    };
    tick();
    setInterval(tick, 15000);
  }

  function boot() {
    initTabs();
    initEditor();
    initConcat();
    initMix();
    startClock();
    setStatus('준비 완료', '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
