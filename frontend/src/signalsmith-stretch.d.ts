// signalsmith-stretch 官方包未带类型声明，这里定义用到的最小接口
declare module 'signalsmith-stretch' {
  export interface StretchScheduleOptions {
    output?: number;        // audioContext 时间
    active?: boolean;       // 是否处理音频（false = 静音，非直通）
    rate?: number;          // 播放速率
    semitones?: number;     // 移调半音
    tonalityHz?: number;    // 音调限制
    formantSemitones?: number;
    formantCompensation?: boolean;
  }

  export interface StretchNode extends AudioWorkletNode {
    schedule(opts: StretchScheduleOptions): Promise<unknown>;
    start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    inputTime: number;
    setUpdateInterval(seconds: number, callback?: (t: number) => void): Promise<unknown>;
  }

  const SignalsmithStretch: (audioContext: AudioContext, options?: {
    numberOfInputs?: number;
    numberOfOutputs?: number;
    outputChannelCount?: number[];
  }) => Promise<StretchNode>;

  export default SignalsmithStretch;
}
