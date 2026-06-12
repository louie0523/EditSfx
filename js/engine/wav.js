/* =========================================================================
 * EditSfx · wav.js
 * Float32 채널 데이터를 16비트 PCM WAV(Blob 원천 바이트)로 인코딩한다.
 * Web Audio API에 의존하지 않으므로 Node에서도 검증 가능.
 *
 * encodeWav(channels, sampleRate) -> ArrayBuffer
 *   channels: Float32Array[] (모노=1개, 스테레오=2개)
 * ========================================================================= */
(function (global) {
  'use strict';

  const WAV = {};

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  /** 여러 채널을 인터리브하며 16비트 PCM WAV ArrayBuffer로 변환. */
  WAV.encodeWav = function (channels, sampleRate) {
    const numChannels = channels.length;
    const numFrames = channels[0] ? channels[0].length : 0;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // fmt 청크 크기
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // byteRate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 8 * bytesPerSample, true); // bitsPerSample
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let frame = 0; frame < numFrames; frame++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channels[ch][frame] || 0;
        sample = Math.max(-1, Math.min(1, sample));
        // -1~1 부동소수 -> 16비트 정수
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, intSample | 0, true);
        offset += 2;
      }
    }
    return buffer;
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WAV;
  }
  global.EditSfx = global.EditSfx || {};
  global.EditSfx.WAV = WAV;
})(typeof window !== 'undefined' ? window : globalThis);
