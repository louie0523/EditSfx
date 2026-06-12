/* =========================================================================
 * EditSfx · audio-engine.js
 * Web Audio API 위에서 동작하는 고수준 오디오 엔진.
 * dsp.js / wav.js 의 순수 함수를 조합해 실제 편집 기능을 제공한다.
 *
 * 외부에 노출하는 핵심 API
 *   Engine.decodeFile(file)                       -> AudioBuffer
 *   Engine.trim(buffer, startSec, endSec)         -> AudioBuffer
 *   Engine.applyEffects(buffer, opts)             -> Promise<AudioBuffer>
 *   Engine.concat(segments)                       -> Promise<AudioBuffer>
 *   Engine.mix(layers)                            -> Promise<AudioBuffer>
 *   Engine.exportWav(buffer)                      -> Blob
 *   Engine.exportMp3(buffer)                      -> Blob | null
 *   Engine.MIN_DURATION                           -> 0.026 (초)
 *
 * 새 기능을 붙일 때는 이 파일에 함수를 추가하고 UI에서 호출하면 된다.
 * ========================================================================= */
(function (global) {
  'use strict';

  const NS = (global.EditSfx = global.EditSfx || {});
  const DSP = NS.DSP;
  const WAV = NS.WAV;

  const Engine = {};

  /** 사이트 정책상 최소 사운드 길이(초). 이보다 짧게는 자를 수 없다. */
  Engine.MIN_DURATION = 0.026;

  let _ctx = null;
  /** 재생/디코딩용 AudioContext (지연 생성, 사용자 제스처 후 resume). */
  Engine.getContext = function () {
    if (!_ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      _ctx = new AC();
    }
    if (_ctx.state === 'suspended' && _ctx.resume) {
      _ctx.resume();
    }
    return _ctx;
  };

  /* ---------- 버퍼 <-> 채널 배열 변환 ---------- */

  Engine.bufferToChannels = function (buffer) {
    const chs = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      chs.push(buffer.getChannelData(c).slice());
    }
    return chs;
  };

  Engine.channelsToBuffer = function (channels, sampleRate) {
    const ctx = Engine.getContext();
    const len = channels[0] ? channels[0].length : 1;
    const buffer = ctx.createBuffer(channels.length, len, sampleRate);
    for (let c = 0; c < channels.length; c++) {
      buffer.copyToChannel(channels[c], c);
    }
    return buffer;
  };

  /* ---------- 디코딩 ---------- */

  Engine.decodeFile = function (file) {
    const ctx = Engine.getContext();
    return file.arrayBuffer().then(function (arr) {
      return new Promise(function (resolve, reject) {
        ctx.decodeAudioData(
          arr,
          function (buf) {
            resolve(buf);
          },
          function (err) {
            reject(
              new Error('오디오를 디코딩하지 못했습니다. 지원되는 mp3/wav/ogg 파일인지 확인해 주세요.')
            );
          }
        );
      });
    });
  };

  /* ---------- 샘플레이트 변환(고품질, OfflineAudioContext) ---------- */

  Engine.resampleBuffer = function (buffer, targetRate) {
    if (buffer.sampleRate === targetRate) return Promise.resolve(buffer);
    const OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    const frames = Math.ceil(buffer.duration * targetRate);
    const offline = new OAC(buffer.numberOfChannels, frames, targetRate);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start();
    return offline.startRendering();
  };

  /* ---------- 자르기(트림) ---------- */

  /**
   * [startSec, endSec) 구간만 남긴다. 최소 길이(0.026초) 미만이면 예외.
   */
  Engine.trim = function (buffer, startSec, endSec) {
    const sr = buffer.sampleRate;
    let start = Math.max(0, Math.floor(startSec * sr));
    let end = Math.min(buffer.length, Math.floor(endSec * sr));
    if (end <= start) {
      throw new Error('선택 구간이 비어 있습니다. 시작점과 끝점을 다시 지정해 주세요.');
    }
    const durSec = (end - start) / sr;
    if (durSec < Engine.MIN_DURATION) {
      throw new Error(
        '선택 구간이 너무 짧습니다. 최소 ' +
          Engine.MIN_DURATION +
          '초(약 ' +
          Math.ceil(Engine.MIN_DURATION * 1000) +
          'ms) 이상이어야 합니다.'
      );
    }
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c).slice(start, end));
    }
    return Engine.channelsToBuffer(channels, sr);
  };

  /* ---------- 효과 적용 ---------- */

  /**
   * @param {AudioBuffer} buffer
   * @param {Object} opts
   *   opts.semitones  반음 단위 피치(길이 유지). 기본 0
   *   opts.speed      속도/템포 배율(음정 유지). 기본 1
   *   opts.gain       음량 배율(1=원본). 기본 1
   *   opts.fadeInSec  페이드인 길이(초). 기본 0
   *   opts.fadeOutSec 페이드아웃 길이(초). 기본 0
   *   opts.reverse    true면 좌우 반전(역재생). 기본 false
   */
  Engine.applyEffects = function (buffer, opts) {
    opts = opts || {};
    const sr = buffer.sampleRate;
    const semitones = Number(opts.semitones) || 0;
    const speed = Number(opts.speed) || 1;
    const gain = opts.gain == null ? 1 : Number(opts.gain);
    const fadeInSec = Number(opts.fadeInSec) || 0;
    const fadeOutSec = Number(opts.fadeOutSec) || 0;
    const reverse = !!opts.reverse;

    return new Promise(function (resolve) {
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        let data = buffer.getChannelData(c).slice();
        if (reverse) data.reverse();
        if (semitones) data = DSP.pitchShiftChannel(data, sr, semitones);
        if (speed !== 1) data = DSP.timeStretch(data, sr, 1 / speed);
        if (gain !== 1) DSP.applyGain(data, gain);
        if (fadeInSec > 0) DSP.applyFadeIn(data, Math.round(fadeInSec * sr));
        if (fadeOutSec > 0) DSP.applyFadeOut(data, Math.round(fadeOutSec * sr));
        channels.push(data);
      }
      resolve(Engine.channelsToBuffer(channels, sr));
    });
  };

  /* ---------- 피크 정규화 ---------- */

  /** 가장 큰 진폭이 target(기본 0.99)이 되도록 음량을 맞춘 새 버퍼를 만든다. */
  Engine.normalize = function (buffer, target) {
    const channels = Engine.bufferToChannels(buffer);
    DSP.normalize(channels, target == null ? 0.99 : target);
    return Engine.channelsToBuffer(channels, buffer.sampleRate);
  };

  /* ---------- 양끝 무음 자동 제거 ---------- */

  /**
   * 앞뒤의 (거의) 무음 구간을 잘라낸다. threshold는 0~1 진폭 기준.
   * 결과가 최소 길이보다 짧아지면 예외를 던진다.
   */
  Engine.trimSilence = function (buffer, threshold) {
    const channels = Engine.bufferToChannels(buffer);
    const b = DSP.findSilenceBounds(channels, threshold == null ? 0.003 : threshold);
    if (b.end <= b.start) {
      throw new Error('전체가 무음에 가까워 잘라낼 부분을 찾지 못했습니다.');
    }
    const sr = buffer.sampleRate;
    if ((b.end - b.start) / sr < Engine.MIN_DURATION) {
      throw new Error('남는 구간이 너무 짧습니다(최소 ' + Engine.MIN_DURATION + '초).');
    }
    const out = channels.map(function (ch) { return ch.slice(b.start, b.end); });
    return Engine.channelsToBuffer(out, sr);
  };

  /* ---------- 공통 정규화: 여러 버퍼를 같은 SR/채널수로 맞춤 ---------- */

  function unifyBuffers(buffers) {
    let targetRate = 0;
    let targetChannels = 1;
    buffers.forEach(function (b) {
      if (b.sampleRate > targetRate) targetRate = b.sampleRate;
      if (b.numberOfChannels > targetChannels) targetChannels = b.numberOfChannels;
    });
    targetRate = targetRate || 44100;

    return Promise.all(
      buffers.map(function (b) {
        return Engine.resampleBuffer(b, targetRate);
      })
    ).then(function (resampled) {
      // 채널 수를 targetChannels로 통일(모노->스테레오 복제 등)
      const unified = resampled.map(function (b) {
        const chs = [];
        for (let c = 0; c < targetChannels; c++) {
          const srcIndex = c < b.numberOfChannels ? c : 0;
          chs.push(b.getChannelData(srcIndex));
        }
        return { channels: chs, length: b.length };
      });
      return { rate: targetRate, channels: targetChannels, items: unified };
    });
  }

  /* ---------- 이어붙이기(순차 연결 + 사이 간격) ---------- */

  /**
   * @param {Array} segments [{ buffer, gapAfterSec, crossfadeAfterSec }]
   *   gapAfterSec: 이 세그먼트 뒤 무음 간격(초).
   *   crossfadeAfterSec: 0보다 크면 다음 세그먼트와 그만큼 겹쳐 등파워
   *     크로스페이드한다(이 경우 해당 경계의 gap은 무시).
   * 예) A 재생 → 0.2초 무음 → B 재생, 또는 A 끝과 B 시작을 0.1초 겹치기.
   */
  Engine.concat = function (segments) {
    if (!segments.length) {
      return Promise.reject(new Error('이어붙일 사운드가 없습니다.'));
    }
    const buffers = segments.map(function (s) { return s.buffer; });
    return unifyBuffers(buffers).then(function (u) {
      const sr = u.rate;
      const n = u.items.length;
      const len = u.items.map(function (it) { return it.length; });

      // 경계별 겹침/간격 프레임 수
      const xfFrames = segments.map(function (s, i) {
        if (i >= n - 1) return 0;
        const x = Math.max(0, Math.round((Number(s.crossfadeAfterSec) || 0) * sr));
        return Math.min(x, len[i], len[i + 1]);
      });
      const gapFrames = segments.map(function (s, i) {
        if (i >= n - 1 || xfFrames[i] > 0) return 0;
        return Math.max(0, Math.round((Number(s.gapAfterSec) || 0) * sr));
      });

      // 각 아이템 시작 위치 계산
      const starts = new Array(n);
      starts[0] = 0;
      for (let i = 1; i < n; i++) {
        starts[i] = starts[i - 1] + len[i - 1] + gapFrames[i - 1] - xfFrames[i - 1];
      }
      let total = 0;
      for (let i = 0; i < n; i++) total = Math.max(total, starts[i] + len[i]);

      const out = [];
      for (let c = 0; c < u.channels; c++) out.push(new Float32Array(total));

      // 등파워 크로스페이드를 적용하며 가산 배치
      u.items.forEach(function (item, i) {
        const leadXf = i > 0 ? xfFrames[i - 1] : 0;     // 앞 경계 겹침(나타남)
        const trailXf = i < n - 1 ? xfFrames[i] : 0;    // 뒤 경계 겹침(사라짐)
        const offset = starts[i];
        for (let c = 0; c < u.channels; c++) {
          const src = item.channels[c];
          const dst = out[c];
          for (let k = 0; k < item.length; k++) {
            let g = 1;
            if (leadXf > 0 && k < leadXf) {
              g *= DSP.crossfadeGains(k / leadXf).gIn;
            }
            if (trailXf > 0 && k >= item.length - trailXf) {
              const m = k - (item.length - trailXf);
              g *= DSP.crossfadeGains(m / trailXf).gOut;
            }
            dst[offset + k] += src[k] * g;
          }
        }
      });
      for (let c = 0; c < u.channels; c++) {
        const ch = out[c];
        for (let k = 0; k < ch.length; k++) ch[k] = DSP.clampSample(ch[k]);
      }
      return Engine.channelsToBuffer(out, sr);
    });
  };

  /* ---------- 합성/믹스(겹쳐 쌓기) ---------- */

  /**
   * @param {Array} layers [{ buffer, startSec, gain, pan }]
   *   startSec: 시작 위치(초). gain: 음량 배율(기본 1).
   *   pan: -1(왼쪽)~0(가운데)~+1(오른쪽). 0이 아니면 결과는 스테레오.
   * @param {Object} [opts] { normalize:boolean } true면 클리핑 대신 피크 정규화.
   * 여러 사운드를 같은 타임라인 위에 겹쳐 하나로 합친다.
   */
  Engine.mix = function (layers, opts) {
    if (!layers.length) {
      return Promise.reject(new Error('합성할 사운드가 없습니다.'));
    }
    opts = opts || {};
    const buffers = layers.map(function (l) { return l.buffer; });
    const usePan = layers.some(function (l) { return Number(l.pan) || 0; });

    return unifyBuffers(buffers).then(function (u) {
      const sr = u.rate;
      // 패닝을 쓰면 출력은 최소 스테레오로 둔다.
      const outCh = usePan ? Math.max(2, u.channels) : u.channels;

      const starts = layers.map(function (l) {
        return Math.max(0, Math.round((Number(l.startSec) || 0) * sr));
      });
      let total = 0;
      u.items.forEach(function (item, i) {
        total = Math.max(total, starts[i] + item.length);
      });

      const out = [];
      for (let c = 0; c < outCh; c++) out.push(new Float32Array(total));

      u.items.forEach(function (item, i) {
        const g = layers[i].gain == null ? 1 : Number(layers[i].gain);
        const pan = Number(layers[i].pan) || 0;
        const pg = DSP.equalPowerPan(pan);
        const offset = starts[i];
        if (outCh >= 2) {
          // 스테레오 출력: 소스 L/R(모노면 동일)을 패닝 게인으로 분배
          const srcL = item.channels[0];
          const srcR = item.channels[1] || item.channels[0];
          const dstL = out[0], dstR = out[1];
          for (let k = 0; k < item.length; k++) {
            dstL[offset + k] += srcL[k] * g * (usePan ? pg.left * 1.41421 : 1);
            dstR[offset + k] += srcR[k] * g * (usePan ? pg.right * 1.41421 : 1);
          }
          // 3채널 이상이면 나머지는 단순 합산
          for (let c = 2; c < outCh; c++) {
            const src = item.channels[c] || item.channels[0];
            const dst = out[c];
            for (let k = 0; k < item.length; k++) dst[offset + k] += src[k] * g;
          }
        } else {
          const src = item.channels[0];
          const dst = out[0];
          for (let k = 0; k < item.length; k++) dst[offset + k] += src[k] * g;
        }
      });

      if (opts.normalize) {
        DSP.normalize(out, 0.99);
      } else {
        for (let c = 0; c < outCh; c++) {
          const ch = out[c];
          for (let k = 0; k < ch.length; k++) ch[k] = DSP.clampSample(ch[k]);
        }
      }
      return Engine.channelsToBuffer(out, sr);
    });
  };

  /* ---------- 내보내기 ---------- */

  Engine.exportWav = function (buffer) {
    const channels = Engine.bufferToChannels(buffer);
    const arr = WAV.encodeWav(channels, buffer.sampleRate);
    return new Blob([arr], { type: 'audio/wav' });
  };

  /**
   * MP3 내보내기. lamejs(전역 lamejs)가 로드되어 있어야 한다.
   * 로드되지 않았으면 null을 반환하므로 호출부에서 WAV로 대체한다.
   * @param {number} kbps 비트레이트(기본 192)
   */
  Engine.exportMp3 = function (buffer, kbps) {
    if (typeof global.lamejs === 'undefined') return null;
    kbps = kbps || 192;
    const channels = Engine.bufferToChannels(buffer);
    const numCh = Math.min(2, channels.length);
    const sr = buffer.sampleRate;
    const encoder = new global.lamejs.Mp3Encoder(numCh, sr, kbps);

    const left = floatTo16(channels[0]);
    const right = numCh > 1 ? floatTo16(channels[1]) : null;

    const blockSize = 1152;
    const data = [];
    for (let i = 0; i < left.length; i += blockSize) {
      const lChunk = left.subarray(i, i + blockSize);
      let mp3buf;
      if (right) {
        const rChunk = right.subarray(i, i + blockSize);
        mp3buf = encoder.encodeBuffer(lChunk, rChunk);
      } else {
        mp3buf = encoder.encodeBuffer(lChunk);
      }
      if (mp3buf.length > 0) data.push(new Uint8Array(mp3buf));
    }
    const end = encoder.flush();
    if (end.length > 0) data.push(new Uint8Array(end));
    return new Blob(data, { type: 'audio/mpeg' });
  };

  function floatTo16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  /** 파형 표시 등에 쓸 피크 데이터 추출(다운샘플된 min/max 쌍). */
  Engine.computePeaks = function (buffer, targetBins) {
    const ch0 = buffer.getChannelData(0);
    const total = ch0.length;
    const bins = Math.min(targetBins, total);
    const blockSize = Math.floor(total / bins) || 1;
    const peaks = new Float32Array(bins * 2);
    for (let b = 0; b < bins; b++) {
      let min = 1.0;
      let max = -1.0;
      const startI = b * blockSize;
      const endI = Math.min(total, startI + blockSize);
      for (let i = startI; i < endI; i++) {
        const v = ch0[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks[b * 2] = min;
      peaks[b * 2 + 1] = max;
    }
    return peaks;
  };

  NS.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
