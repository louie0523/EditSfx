/* =========================================================================
 * EditSfx · waveform.js
 * 캔버스에 파형을 그리고, 마우스/터치 드래그로 구간(start~end)을 선택한다.
 * 선택이 바뀌면 onSelect(startSec, endSec) 콜백을 호출한다.
 * ========================================================================= */
(function (global) {
  'use strict';

  const NS = (global.EditSfx = global.EditSfx || {});
  const Engine = NS.Engine;

  function Waveform(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.buffer = null;
    this.peaks = null;
    this.duration = 0;
    this.selStart = 0; // 초
    this.selEnd = 0; // 초
    this.playhead = -1; // 초, -1이면 숨김
    this._dragging = false;
    this._bind();
  }

  Waveform.prototype.setBuffer = function (buffer) {
    this.buffer = buffer;
    this.duration = buffer ? buffer.duration : 0;
    this.selStart = 0;
    this.selEnd = this.duration;
    this.playhead = -1;
    this._resize();
    this.draw();
  };

  Waveform.prototype._resize = function () {
    const dpr = global.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 600;
    const h = rect.height || 120;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w;
    this._h = h;
    if (this.buffer) {
      this.peaks = Engine.computePeaks(this.buffer, Math.round(w));
    }
  };

  Waveform.prototype._xToSec = function (x) {
    const r = Math.max(0, Math.min(1, x / this._w));
    return r * this.duration;
  };
  Waveform.prototype._secToX = function (s) {
    return this.duration ? (s / this.duration) * this._w : 0;
  };

  Waveform.prototype.draw = function () {
    const ctx = this.ctx;
    const w = this._w || this.canvas.width;
    const h = this._h || this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 배경
    ctx.fillStyle = '#0b2a4a';
    ctx.fillRect(0, 0, w, h);

    // 중앙선
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!this.peaks) return;

    // 선택 영역 음영
    const xs = this._secToX(this.selStart);
    const xe = this._secToX(this.selEnd);
    ctx.fillStyle = 'rgba(120, 180, 255, 0.22)';
    ctx.fillRect(xs, 0, Math.max(1, xe - xs), h);

    // 파형
    const bins = this.peaks.length / 2;
    const mid = h / 2;
    const scale = (h / 2) * 0.92;
    ctx.strokeStyle = '#7fd0ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < bins; i++) {
      const min = this.peaks[i * 2];
      const max = this.peaks[i * 2 + 1];
      const x = (i / bins) * w + 0.5;
      ctx.moveTo(x, mid - max * scale);
      ctx.lineTo(x, mid - min * scale);
    }
    ctx.stroke();

    // 선택 경계선
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 1;
    [xs, xe].forEach(function (x) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    });

    // 플레이헤드(재생 위치) — 항상 잘 보이도록 굵게 + 대비 외곽선 + 상단 손잡이
    if (this.playhead >= 0) {
      let px = Math.round(this._secToX(this.playhead));
      px = Math.max(1, Math.min(w - 2, px));
      // 1) 어두운 외곽선(어떤 파형 위에서도 대비 확보)
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(px - 2, 0, 5, h);
      // 2) 밝은 본선(2px, 정수 좌표라 흐려지지 않음)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px, 0, 2, h);
      // 3) 상단 손잡이 삼각형
      ctx.beginPath();
      ctx.moveTo(px - 4, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px + 1, 8);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  };

  Waveform.prototype.setPlayhead = function (sec) {
    this.playhead = sec;
    this.draw();
  };

  /** 캔버스 크기에 맞춰 다시 측정하고 그린다(탭 전환·레이아웃 변경 후 호출). */
  Waveform.prototype.redraw = function () {
    this._resize();
    this.draw();
  };

  Waveform.prototype.getSelection = function () {
    return { start: this.selStart, end: this.selEnd };
  };

  Waveform.prototype.setSelection = function (start, end) {
    this.selStart = Math.max(0, Math.min(this.duration, start));
    this.selEnd = Math.max(this.selStart, Math.min(this.duration, end));
    this.draw();
    if (this.opts.onSelect) this.opts.onSelect(this.selStart, this.selEnd);
  };

  Waveform.prototype._bind = function () {
    const self = this;
    function pos(e) {
      const rect = self.canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      return clientX - rect.left;
    }
    function down(e) {
      if (!self.buffer) return;
      // 가운데(휠) 클릭: 그 지점부터 재생
      if (e.type === 'mousedown' && e.button === 1) {
        e.preventDefault(); // 가운데 클릭 자동스크롤 방지
        const sec = self._xToSec(pos(e));
        if (self.opts.onSeekPlay) self.opts.onSeekPlay(sec);
        return;
      }
      // 왼쪽 버튼(또는 터치)만 구간 선택 드래그
      if (e.type === 'mousedown' && e.button !== 0) return;
      self._dragging = true;
      self._anchor = self._xToSec(pos(e));
      self.selStart = self._anchor;
      self.selEnd = self._anchor;
      self.draw();
      e.preventDefault();
    }
    function move(e) {
      if (!self._dragging) return;
      const s = self._xToSec(pos(e));
      self.selStart = Math.min(self._anchor, s);
      self.selEnd = Math.max(self._anchor, s);
      self.draw();
      e.preventDefault();
    }
    function up() {
      if (!self._dragging) return;
      self._dragging = false;
      // 클릭만 한 경우(거의 0폭) 전체 선택으로 복원
      if (self.selEnd - self.selStart < 0.005) {
        self.selStart = 0;
        self.selEnd = self.duration;
      }
      self.draw();
      if (self.opts.onSelect) self.opts.onSelect(self.selStart, self.selEnd);
    }
    this.canvas.addEventListener('mousedown', down);
    // 일부 브라우저의 가운데 클릭 기본동작(자동스크롤/붙여넣기) 차단
    this.canvas.addEventListener('auxclick', function (e) { if (e.button === 1) e.preventDefault(); });
    global.addEventListener('mousemove', move);
    global.addEventListener('mouseup', up);
    this.canvas.addEventListener('touchstart', down, { passive: false });
    this.canvas.addEventListener('touchmove', move, { passive: false });
    global.addEventListener('touchend', up);
    global.addEventListener('resize', function () {
      self._resize();
      self.draw();
    });
  };

  NS.Waveform = Waveform;

  /**
   * 선택 기능 없이 버퍼 파형만 캔버스에 그린다(결과 미리보기·썸네일용).
   * @param {HTMLCanvasElement} canvas
   * @param {AudioBuffer} buffer
   * @param {Object} [opts] { bg, wave, mid } 색상 커스터마이즈
   */
  NS.drawStaticWaveform = function (canvas, buffer, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const dpr = global.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 600;
    const h = rect.height || 80;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = opts.bg || '#0b2a4a';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    if (!buffer) return;
    const peaks = (NS.Engine || Engine).computePeaks(buffer, Math.round(w));
    const bins = peaks.length / 2;
    const mid = h / 2;
    const scale = (h / 2) * 0.92;
    ctx.strokeStyle = opts.wave || '#7fd0ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < bins; i++) {
      const mn = peaks[i * 2];
      const mx = peaks[i * 2 + 1];
      const x = (i / bins) * w + 0.5;
      ctx.moveTo(x, mid - mx * scale);
      ctx.lineTo(x, mid - mn * scale);
    }
    ctx.stroke();
  };
})(typeof window !== 'undefined' ? window : globalThis);
