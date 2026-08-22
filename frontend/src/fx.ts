// 音效引擎 - 倍速 / 小黄人 / 升降 KEY
// V12.2：移调处理器从 SoundTouch(ScriptProcessor/主线程) 升级为
//        Signalsmith Stretch(WASM + AudioWorklet/音频线程)。
//
// 架构分两层：
//   1) 原生属性层（无需用户手势，零音质代价）：
//      playbackRate/defaultPlaybackRate 管速度，preservesPitch 管小黄人变调
//   2) WebAudio 层（仅升降 KEY ≠ 0 时启用，音频线程运行不受主线程阻塞）：
//      MediaElementSource → SignalsmithStretch(AudioWorklet) → destination
//      谐波保真 + 瞬态处理，质量显著优于 WSOLA 类算法（SoundTouch）
//
// ⚠ 音质保护（沿用 V12.1 原则）：
//   - createMediaElementSource 不可逆：一旦建立，元素输出永久改道进 AudioContext。
//   - 移调 ≠ 0 才建管线；移调回 0 立即切直通（src → destination，位透明）；
//     从未移调过则完全不建管线，原曲走浏览器原生路径，零处理零损失。
//   - 非手势上下文不建图：suspended 的 AudioContext 会吞掉音频导致静音，
//     持久化恢复的移调等首次手势后再激活（期间直通播放，不静音）。
import SignalsmithStretch from 'signalsmith-stretch';
import type { StretchNode } from 'signalsmith-stretch';

export interface FxParams {
  rate: number;       // 播放速度 0.5~2
  semitones: number;  // 移调半音 -12~+12
  chipmunk: boolean;  // 小黄人模式（变调变速）
}

export class FxEngine {
  private ctx: AudioContext | null = null;
  private srcNode: MediaElementAudioSourceNode | null = null;
  private stretch: StretchNode | null = null;
  private graphPromise: Promise<boolean> | null = null; // WASM 加载防重入
  private audio: HTMLAudioElement | null = null;
  private params: FxParams = { rate: 1, semitones: 0, chipmunk: false };
  private bypass = true; // true = 直通/未建管线（音质无损）

  /** 绑定音频元素。只记引用 + 补设原生属性，无需用户手势（倍速/小黄人随即可用）。 */
  bind(audio: HTMLAudioElement | null) {
    if (!audio || this.audio === audio) return;
    this.audio = audio;
    // 元素更换（如 HMR 重挂载）且管线已建：MediaElementSource 只能一对一，无法迁移，
    // 这种情况放弃旧管线（移调退回直通，避免旧元素引用泄漏）
    if (this.ctx) {
      try { this.srcNode?.disconnect(); } catch {}
      this.ctx = null;
      this.srcNode = null;
      this.stretch = null;
      this.bypass = true;
    }
    this.apply(this.params);
  }

  /** 建立 WebAudio 管线（异步：WASM/AudioWorklet 加载）。仅在移调 ≠ 0 时调用。 */
  private ensureGraph(): Promise<boolean> {
    if (this.ctx && this.stretch) return Promise.resolve(true);
    if (this.graphPromise) return this.graphPromise;
    if (!this.audio) return Promise.resolve(false);
    this.graphPromise = (async () => {
      try {
        const audio = this.audio;
        if (!audio) return false;
        const ctx = new AudioContext();
        const srcNode = ctx.createMediaElementSource(audio);
        const stretch = await SignalsmithStretch(ctx);
        stretch.connect(ctx.destination);
        this.ctx = ctx;
        this.srcNode = srcNode;
        this.stretch = stretch;
        this.route(); // 按当前 bypass 状态接线
        return true;
      } catch (err) {
        console.warn('[Fx] Signalsmith Stretch 管线初始化失败，移调不可用（倍速/小黄人不受影响）:', err);
        return false;
      } finally {
        this.graphPromise = null;
      }
    })();
    return this.graphPromise;
  }

  /** 接线：bypass 时 src 直连 destination（浮点直通，位透明），否则经 Stretch 处理。 */
  private route() {
    if (!this.ctx || !this.srcNode) return;
    try {
      this.srcNode.disconnect();
      if (this.bypass || !this.stretch) {
        this.srcNode.connect(this.ctx.destination);
      } else {
        this.srcNode.connect(this.stretch);
      }
    } catch {}
  }

  resume() {
    this.ctx?.resume().catch(() => {});
  }

  /** 手势时调用：若管线未建但参数需要移调（如重启后恢复的持久化移调），此时补建 */
  gestureApply() {
    if (!this.ctx && this.params.semitones !== 0) this.apply(this.params);
  }

  /** 应用音效参数（原生属性始终立即生效；移调仅在 ≠ 0 时占用 WebAudio 管线） */
  apply(p: FxParams) {
    this.params = p;
    // 原生：速度 + 小黄人变调（无需手势，零音质代价）
    const a = this.audio;
    if (a) {
      // 关键：src 变更触发 load 算法时，playbackRate 会重置为 defaultPlaybackRate，
      // 同步设置 default 可让切音轨/换歌后倍速自动保持，不再静默回落到 1x
      a.defaultPlaybackRate = p.rate;
      a.playbackRate = p.rate;
      (a as any).preservesPitch = !p.chipmunk;
      (a as any).webkitPreservesPitch = !p.chipmunk;
    }
    // 升降 KEY：只在真正移调时建立/启用 Stretch 管线
    if (p.semitones !== 0) {
      // 非手势上下文不建图：suspended AudioContext 会导致静音，
      // 持久化恢复的移调等首次手势（store 的 gesture handler 会补 apply）
      const activated = (navigator as any).userActivation?.isActive;
      if (!this.ctx && !activated) return;
      this.ensureGraph().then(ok => {
        if (!ok || !this.stretch) return;
        // 竞态防护：图建好时用户可能已把移调归零
        if (this.params.semitones === 0) return;
        if (this.bypass) { this.bypass = false; this.route(); }
        // schedule 平滑调度移调；active:true 必须显式传（false 时输出静音而非直通）
        this.stretch.schedule({ semitones: this.params.semitones, active: true }).catch?.(() => {});
        this.resume();
      });
    } else if (this.ctx && !this.bypass) {
      // 移调归零：切回直通，音质恢复无损
      this.bypass = true;
      this.route();
    }
  }

  /** 切歌/切音轨时调用：临时切直通，冲掉 Stretch 内部 STFT 残留，
   *  元数据就绪后 store 会重新 apply（仍在移调则重新接线） */
  clear() {
    if (this.ctx && !this.bypass) {
      this.bypass = true;
      this.route();
    }
  }

  /** 调试/自检：管线当前状态（测试用，只读） */
  get debug() {
    return {
      attached: !!this.ctx,          // WebAudio 管线是否已建立
      bypass: this.bypass,           // true = 直通（无损）
      engine: this.stretch ? 'signalsmith-stretch' : 'none',
      audioBound: !!this.audio,
      params: { ...this.params },
    };
  }
}
