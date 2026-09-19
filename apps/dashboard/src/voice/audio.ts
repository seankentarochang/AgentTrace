/**
 * Browser audio for the Gemini Live voice layer.
 * Mic: AudioWorklet -> Float32 chunks -> downsample to 16-bit PCM @ 16kHz.
 * Out: 24kHz PCM16 chunks scheduled gapless on a shared AudioContext.
 */

const IN_RATE = 16000;
const OUT_RATE = 24000;

const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

function floatTo16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Starts the mic; calls onChunk with base64 PCM16 @16kHz. Returns stop(). */
export async function startMic(
  onChunk: (b64: string) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);

  const blobUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
  );
  await ctx.audioWorklet.addModule(blobUrl);
  const node = new AudioWorkletNode(ctx, "pcm-capture");

  // Downsample ctx.sampleRate -> 16kHz by linear decimation.
  let pending = new Float32Array(0);
  const ratio = ctx.sampleRate / IN_RATE;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const merged = new Float32Array(pending.length + e.data.length);
    merged.set(pending);
    merged.set(e.data, pending.length);
    const outLen = Math.floor(merged.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = merged[Math.floor(i * ratio)];
    pending = merged.slice(Math.floor(outLen * ratio));
    if (outLen > 0) onChunk(floatTo16Base64(out));
  };

  source.connect(node);
  node.connect(ctx.destination); // keep the worklet pumping (silent tap)

  return () => {
    node.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    URL.revokeObjectURL(blobUrl);
    void ctx.close();
  };
}

/** Gapless playback queue for 24kHz PCM16 chunks; reset() = barge-in. */
export function createPlayer(): {
  push: (b64: string) => void;
  reset: () => void;
  close: () => void;
} {
  const ctx = new AudioContext({ sampleRate: OUT_RATE });
  let nextTime = 0;
  let active: AudioBufferSourceNode[] = [];

  return {
    push(b64) {
      const bin = atob(b64);
      const pcm = new Int16Array(bin.length / 2);
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      }
      const buffer = ctx.createBuffer(1, pcm.length, OUT_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const when = Math.max(ctx.currentTime, nextTime);
      src.start(when);
      nextTime = when + buffer.duration;
      active.push(src);
      src.onended = () => {
        active = active.filter((s) => s !== src);
      };
    },
    reset() {
      for (const s of active) {
        try {
          s.stop();
        } catch {
          // already ended
        }
      }
      active = [];
      nextTime = 0;
    },
    close() {
      for (const s of active) {
        try {
          s.stop();
        } catch {
          // already ended
        }
      }
      active = [];
      void ctx.close();
    },
  };
}
