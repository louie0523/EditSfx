/* =========================================================================
 * EditSfx · dsp.js
 * 순수 신호처리(DSP) 함수 모음. Float32Array 단위로 동작하며 Web Audio API에
 * 의존하지 않는다. 덕분에 Node 환경에서 단위 테스트가 가능하고, 다른 기능을
 * 추가할 때도 이 파일의 함수들을 재사용할 수 있다.
 *
 * 모든 함수는 부수효과 없이 새 배열을 반환하거나(변환 계열),
 * 전달받은 배열을 제자리에서 수정한다(apply 계열). 이름으로 구분한다.
 * ========================================================================= */
(function (global) {
  'use strict';

  const DSP = {};

  /** 클리핑 방지를 위해 [-1, 1] 범위로 샘플을 가둔다. */
  DSP.clampSample = function (v) {
    if (v > 1) return 1;
    if (v < -1) return -1;
    return v;
  };

  /** 한 채널 전체에 일정 배율(gain)을 곱한다. 제자리 수정. */
  DSP.applyGain = function (channel, gain) {
    for (let i = 0; i < channel.length; i++) {
      channel[i] = DSP.clampSample(channel[i] * gain);
    }
    return channel;
  };

  /**
   * 채널 앞부분에 선형 페이드인을 적용한다. 제자리 수정.
   * @param {Float32Array} channel
   * @param {number} fadeSamples 페이드 구간 샘플 수
   */
  DSP.applyFadeIn = function (channel, fadeSamples) {
    const n = Math.min(fadeSamples, channel.length);
    for (let i = 0; i < n; i++) {
      channel[i] *= i / n;
    }
    return channel;
  };

  /** 채널 뒷부분에 선형 페이드아웃을 적용한다. 제자리 수정. */
  DSP.applyFadeOut = function (channel, fadeSamples) {
    const n = Math.min(fadeSamples, channel.length);
    const len = channel.length;
    for (let i = 0; i < n; i++) {
      channel[len - n + i] *= 1 - i / n;
    }
    return channel;
  };

  /** Hann 윈도우 생성(겹침-합산 시 매끄러운 연결을 위해 사용). */
  DSP.hannWindow = function (size) {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return w;
  };

  /**
   * 선형 보간 리샘플. ratio > 1 이면 짧아지고(빨라짐), < 1 이면 길어진다.
   * 길이 = round(data.length / ratio)
   */
  DSP.resampleLinear = function (data, ratio) {
    if (ratio === 1) return data.slice();
    const outLength = Math.max(1, Math.round(data.length / ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const a = data[idx] || 0;
      const b = idx + 1 < data.length ? data[idx + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  };

  /**
   * 겹침-합산(OLA) 기반 타임 스트레치.
   * 피치는 유지한 채 길이만 stretch 배만큼 바꾼다(>1 길게, <1 짧게).
   * 짧은 효과음 용도로 충분한 품질이며 위상 정렬은 하지 않는다.
   */
  DSP.timeStretch = function (data, sampleRate, stretch) {
    if (stretch === 1 || data.length === 0) return data.slice();

    const grainSize = Math.max(256, Math.round(sampleRate * 0.04)); // 40ms
    const overlap = 0.5;
    const analysisHop = Math.max(1, Math.round(grainSize * (1 - overlap)));
    const synthesisHop = Math.max(1, Math.round(analysisHop * stretch));
    const window = DSP.hannWindow(grainSize);

    const outLength =
      Math.ceil(data.length * stretch) + grainSize + synthesisHop;
    const out = new Float32Array(outLength);
    const norm = new Float32Array(outLength);

    let inPos = 0;
    let outPos = 0;
    while (inPos + grainSize <= data.length) {
      for (let i = 0; i < grainSize; i++) {
        const w = window[i];
        out[outPos + i] += data[inPos + i] * w;
        norm[outPos + i] += w;
      }
      inPos += analysisHop;
      outPos += synthesisHop;
    }

    // 정규화(겹친 윈도우 가중치로 나눔) 후 실제 길이로 잘라낸다.
    const finalLength = Math.max(1, Math.round(data.length * stretch));
    const result = new Float32Array(finalLength);
    for (let i = 0; i < finalLength; i++) {
      result[i] = norm[i] > 1e-6 ? out[i] / norm[i] : out[i];
    }
    return result;
  };

  /**
   * 반음(semitone) 단위 피치 시프트. 길이는 그대로 두고 음정만 바꾼다.
   * 원리: stretch 배 늘린 뒤 같은 비율로 리샘플해 원래 길이로 되돌린다.
   * @param {number} semitones 양수=높게, 음수=낮게
   */
  DSP.pitchShiftChannel = function (data, sampleRate, semitones) {
    if (!semitones) return data.slice();
    const ratio = Math.pow(2, semitones / 12);
    const stretched = DSP.timeStretch(data, sampleRate, ratio);
    return DSP.resampleLinear(stretched, ratio);
  };

  /** 무음 채널 생성. */
  DSP.silence = function (samples) {
    return new Float32Array(Math.max(0, Math.round(samples)));
  };

  /** 여러 채널에 걸친 최대 절대 진폭(피크)을 구한다. */
  DSP.peak = function (channels) {
    let p = 0;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = 0; i < ch.length; i++) {
        const a = ch[i] < 0 ? -ch[i] : ch[i];
        if (a > p) p = a;
      }
    }
    return p;
  };

  /**
   * 피크 정규화. 가장 큰 진폭이 target(기본 0.99)이 되도록 모든 채널을 같은
   * 배율로 키운다(이미 더 크면 줄인다). 무음이면 그대로 둔다. 제자리 수정.
   */
  DSP.normalize = function (channels, target) {
    target = target == null ? 0.99 : target;
    const p = DSP.peak(channels);
    if (p < 1e-6) return channels;
    const g = target / p;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = 0; i < ch.length; i++) ch[i] = ch[i] * g;
    }
    return channels;
  };

  /**
   * 진폭이 threshold(0~1)를 처음/마지막으로 넘는 지점을 찾아
   * 앞뒤 무음 구간을 제외한 [start, end) 샘플 인덱스를 돌려준다.
   * 전부 무음이면 start=end=0.
   */
  DSP.findSilenceBounds = function (channels, threshold) {
    threshold = threshold == null ? 0.003 : threshold;
    const len = channels[0] ? channels[0].length : 0;
    let start = 0, end = len;
    // 앞에서부터
    outerA: for (; start < len; start++) {
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][start];
        if ((v < 0 ? -v : v) > threshold) break outerA;
      }
    }
    // 뒤에서부터
    outerB: for (; end > start; end--) {
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][end - 1];
        if ((v < 0 ? -v : v) > threshold) break outerB;
      }
    }
    if (end <= start) { start = 0; end = 0; }
    return { start: start, end: end };
  };

  /**
   * 등파워(equal-power) 패닝 게인. pan: -1(왼쪽) ~ 0(가운데) ~ +1(오른쪽).
   * left^2 + right^2 = 1 을 유지해 가운데에서 음량이 솟지 않는다.
   */
  DSP.equalPowerPan = function (pan) {
    const p = (Math.max(-1, Math.min(1, pan)) + 1) / 2; // 0..1
    const a = (p * Math.PI) / 2;
    return { left: Math.cos(a), right: Math.sin(a) };
  };

  /**
   * 등파워 크로스페이드 게인. p: 0~1.
   * gOut: 사라지는 쪽(끝으로 갈수록 0), gIn: 나타나는 쪽(끝으로 갈수록 1).
   */
  DSP.crossfadeGains = function (p) {
    const a = (Math.max(0, Math.min(1, p)) * Math.PI) / 2;
    return { gOut: Math.cos(a), gIn: Math.sin(a) };
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DSP; // Node 테스트용
  }
  global.EditSfx = global.EditSfx || {};
  global.EditSfx.DSP = DSP;
})(typeof window !== 'undefined' ? window : globalThis);
