# -*- coding: utf-8 -*-
"""
一键部署人声分离高配模型：BS PolarFormer（2025，arXiv:2509.10534，MVSEP Multisong vocals SDR 11.00）。

与 audio-separator 0.18.0 集成，包含三件事（全部幂等，可重复运行）：
  1. 给 audio-separator 打 PoPE 推理补丁（bs_roformer.py + separator.py），
     使 PolarFormer 权重能正确加载/推理（原库仅支持 RoPE 的 BS-RoFormer）。
  2. 下载 PolarFormer 权重（102MB，float16）与 yaml 到 backend/cache/stem_models/，带 sha256 校验。
  3. 生成修正版 yaml（对齐 audio-separator 推理所需的 hop_length / inference / stem 命名）。

用法：
  python backend/setup_stem_models.py

模型与补丁均不进入 git（backend/vendor、backend/cache 已被 .gitignore 排除），
新环境 clone 后运行本脚本一次即可获得与开发机一致的分离能力。
"""

import hashlib
import os
import shutil
import sys
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).parent
VENDOR = BACKEND / "vendor"
MODEL_DIR = BACKEND / "cache" / "stem_models"

# ── 模型源（GitHub release，ZFTurbo/Music-Source-Separation-Training v1.0.20）──
MODEL_NAME = "model_bs_polarformer_float16"
MODEL_URL = "https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.20/model_bs_polarformer_float16.ckpt"
MODEL_SHA256 = "fc8b72c3beb92caad4e14f180979c02ddf18a330182176cf6c7bb0eb6c685e87"
YAML_URL = "https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.20/model_bs_polarformer_float16.yaml"
YAML_SHA256 = "0348205cb562a58e9724870a4cf43e5d2c49ae87258159b2827c4e42ed51b00d"

# ── 补丁标记（vendor 里打补丁后写入，用于幂等判定）──
PATCH_MARK = "--- PolarFormer PoPE patch applied by setup_stem_models.py ---"

BS_ROFORMER_PY = VENDOR / "audio_separator" / "separator" / "uvr_lib_v5" / "bs_roformer.py"
SEPARATOR_PY = VENDOR / "audio_separator" / "separator" / "separator.py"

# PoPE 实现（移植自 lucidrains/PoPE-pytorch，MIT；Python 3.9 兼容，纯 PyTorch，无外部依赖）
POPE_IMPL = '''# ═══ PoPE（极坐标位置编码）—— 供 PolarFormer 模型使用 ═══
# 移植自 lucidrains/PoPE-pytorch（MIT License），对应论文：
#   Gopalakrishnan et al. "Decoupling the 'What' and 'Where' with Polar Coordinate Positional Embeddings" (arXiv:2509.10534)
# 与 RoPE 的差别：每层每 Attention 一个独立 PoPE 模块（含可学习 bias），
# 权重键为 pope_embed.{bias, inv_freqs}，且 q/k 幅度先过 softplus 再旋转。
# 此实现不依赖 PoPE-pytorch 包（该包要求 Python>=3.10），纯 PyTorch 内嵌。

class PoPE(Module):
    def __init__(
            self,
            dim,
            *,
            heads,
            theta=10000.0,
            bias_uniform_init=False,
            inv_freqs: Optional[Tensor] = None
    ):
        super().__init__()

        # freqs
        if not exists(inv_freqs):
            inv_freqs = theta ** (-(torch.arange(dim).float()) / dim)

        self.register_buffer('inv_freqs', inv_freqs)

        # the learned bias on the keys
        self.bias = nn.Parameter(torch.zeros(heads, dim))

        if bias_uniform_init:
            self.bias.uniform_(-2. * math.pi, 0.)

    @property
    def device(self):
        return self.inv_freqs.device

    def forward(self, pos_or_seq_len, offset=0):
        # get positions depending on input
        if isinstance(pos_or_seq_len, int):
            pos = torch.arange(pos_or_seq_len, device=self.device, dtype=self.inv_freqs.dtype)
        else:
            pos = pos_or_seq_len

        pos = pos + offset

        # freqs
        freqs = torch.einsum('... i, j -> ... i j', pos, self.inv_freqs)

        # the bias, with clamping
        bias = self.bias.clamp(-2. * math.pi, 0.)

        return freqs, bias

    @staticmethod
    def apply_pope_to_qk(pope, q, k, to_magnitude=F.softplus, return_complex=False):
        freqs, bias = pope

        q_len, k_len, qk_dim, rotate_dim = q.shape[-2], k.shape[-2], q.shape[-1], freqs.shape[-1]

        assert q_len <= k_len and rotate_dim <= qk_dim

        is_partial_rotate = rotate_dim < qk_dim

        if is_partial_rotate:
            q, q_rest = q[..., :rotate_dim], q[..., rotate_dim:]
            k, k_rest = k[..., :rotate_dim], k[..., rotate_dim:]

            if return_complex:
                q_rest = torch.polar(q_rest, torch.zeros_like(q_rest))
                k_rest = torch.polar(k_rest, torch.zeros_like(k_rest))

        if freqs.ndim == 3:
            freqs = rearrange(freqs, 'b n d -> b 1 n d')

        freqs_with_bias = freqs + rearrange(bias, 'h d -> h 1 d')

        # convert q and k to polar magnitude with activation
        q, k = to_magnitude(q), to_magnitude(k)

        # apply rotations
        freqs = freqs[..., :q_len, :]

        if return_complex:
            q = torch.polar(q, freqs)
        else:
            qcos, qsin = freqs.cos(), freqs.sin()
            q = rearrange([q * qcos, q * qsin], 'two ... d -> ... (d two)')

        # handle inference
        if return_complex:
            k = torch.polar(k, freqs_with_bias)
        else:
            kcos, ksin = freqs_with_bias.cos(), freqs_with_bias.sin()
            k = rearrange([k * kcos, k * ksin], 'two ... d -> ... (d two)')

        # concat
        if is_partial_rotate:
            q = torch.cat((q, q_rest), dim=-1)
            k = torch.cat((k, k_rest), dim=-1)

        return q, k

'''


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dst: Path, expected_sha256: str) -> None:
    """下载并校验 sha256；已存在且校验通过则跳过。"""
    if dst.exists() and sha256_file(dst) == expected_sha256:
        print(f"  ✓ {dst.name} 已存在且校验通过")
        return
    print(f"  下载 {dst.name} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    tmp = dst.with_suffix(dst.suffix + ".part")
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    if sha256_file(tmp) != expected_sha256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{dst.name} sha256 校验失败，已删除")
    tmp.replace(dst)
    print(f"  ✓ {dst.name} 下载完成（{dst.stat().st_size // 1024 // 1024} MB）")


def patch_bs_roformer() -> None:
    """给 audio-separator 的 BSRoformer 加 PoPE 支持（幂等）。"""
    if not BS_ROFORMER_PY.exists():
        print("  ! 未找到 audio-separator，跳过 bs_roformer.py 补丁")
        return
    src = BS_ROFORMER_PY.read_text(encoding="utf-8")
    # 幂等判定：用特征检测（PoPE 类 + use_pope 支持），不依赖标记文本
    if "class PoPE(Module):" in src and "pope_embed" in src and "use_pope=False" in src:
        print("  ✓ bs_roformer.py 已打过补丁")
        return

    # 1) 引入 math（PoPE 需要）
    if "\nimport math\n" not in src:
        src = src.replace("import torch.nn.functional as F\n",
                          "import torch.nn.functional as F\nimport math\n", 1)

    # 2) 在 RMSNorm 之前插入 PoPE 实现
    anchor = "class RMSNorm(Module):"
    if anchor not in src:
        raise RuntimeError("bs_roformer.py 结构异常，找不到 RMSNorm")
    src = src.replace(anchor, POPE_IMPL + "\n\n" + anchor, 1)

    # 3) Attention 增加 pope_embed 参数与 PoPE 分支
    old_attn_init = """            dropout=0.,
            rotary_embed=None,
            flash=True
    ):
        super().__init__()
        self.heads = heads
        self.scale = dim_head ** -0.5
        dim_inner = heads * dim_head

        self.rotary_embed = rotary_embed

        self.attend = Attend(flash=flash, dropout=dropout)"""
    new_attn_init = """            dropout=0.,
            rotary_embed=None,
            pope_embed=None,
            flash=True
    ):
        super().__init__()
        self.heads = heads
        self.scale = dim_head ** -0.5
        dim_inner = heads * dim_head

        self.rotary_embed = rotary_embed
        self.pope_embed = pope_embed
        assert not (exists(rotary_embed) and exists(pope_embed)), 'cannot have both rotary and pope embeddings'

        self.attend = Attend(flash=flash, dropout=dropout)"""
    if old_attn_init not in src:
        raise RuntimeError("bs_roformer.py Attention.__init__ 结构异常")
    src = src.replace(old_attn_init, new_attn_init, 1)

    # 4) Attention.forward 加 PoPE 分支
    old_attn_fwd = """        if exists(self.rotary_embed):
            q = self.rotary_embed.rotate_queries_or_keys(q)
            k = self.rotary_embed.rotate_queries_or_keys(k)

        out = self.attend(q, k, v)"""
    new_attn_fwd = """        if exists(self.pope_embed):
            q, k = PoPE.apply_pope_to_qk(self.pope_embed(q.shape[-2]), q, k)
        elif exists(self.rotary_embed):
            q = self.rotary_embed.rotate_queries_or_keys(q)
            k = self.rotary_embed.rotate_queries_or_keys(k)

        out = self.attend(q, k, v)"""
    if old_attn_fwd not in src:
        raise RuntimeError("bs_roformer.py Attention.forward 结构异常")
    src = src.replace(old_attn_fwd, new_attn_fwd, 1)

    # 5) Transformer 透传 pope_embed
    old_trans = """            norm_output=True,
            rotary_embed=None,
            flash_attn=True,
            linear_attn=False
    ):"""
    new_trans = """            norm_output=True,
            rotary_embed=None,
            pope_embed=None,
            flash_attn=True,
            linear_attn=False
    ):"""
    if old_trans not in src:
        raise RuntimeError("bs_roformer.py Transformer.__init__ 结构异常")
    src = src.replace(old_trans, new_trans, 1)

    old_trans_attn = """                attn = Attention(dim=dim, dim_head=dim_head, heads=heads, dropout=attn_dropout,
                                 rotary_embed=rotary_embed, flash=flash_attn)"""
    new_trans_attn = """                attn = Attention(dim=dim, dim_head=dim_head, heads=heads, dropout=attn_dropout,
                                 rotary_embed=rotary_embed, pope_embed=pope_embed, flash=flash_attn)"""
    if old_trans_attn not in src:
        raise RuntimeError("bs_roformer.py Transformer 内 Attention 构造结构异常")
    src = src.replace(old_trans_attn, new_trans_attn, 1)

    # 6) BSRoformer：use_pope 参数 + 每层独立 PoPE + 吸收多余键
    old_bsro = """            multi_stft_normalized=False,
            multi_stft_window_fn: Callable = torch.hann_window
    ):
        super().__init__()

        self.stereo = stereo
        self.audio_channels = 2 if stereo else 1
        self.num_stems = num_stems

        self.layers = ModuleList([])

        transformer_kwargs = dict(
            dim=dim,
            heads=heads,
            dim_head=dim_head,
            attn_dropout=attn_dropout,
            ff_dropout=ff_dropout,
            flash_attn=flash_attn,
            norm_output=False
        )

        time_rotary_embed = RotaryEmbedding(dim=dim_head)
        freq_rotary_embed = RotaryEmbedding(dim=dim_head)

        for _ in range(depth):
            tran_modules = []
            if linear_transformer_depth > 0:
                tran_modules.append(Transformer(depth=linear_transformer_depth, linear_attn=True, **transformer_kwargs))
            tran_modules.append(
                Transformer(depth=time_transformer_depth, rotary_embed=time_rotary_embed, **transformer_kwargs)
            )
            tran_modules.append(
                Transformer(depth=freq_transformer_depth, rotary_embed=freq_rotary_embed, **transformer_kwargs)
            )
            self.layers.append(nn.ModuleList(tran_modules))"""
    new_bsro = """            multi_stft_normalized=False,
            multi_stft_window_fn: Callable = torch.hann_window,
            use_pope=False,
            **kwargs  # 吸收 PolarFormer yaml 中的训练配置键（use_torch_checkpoint / skip_connection 等）
    ):
        super().__init__()

        self.stereo = stereo
        self.audio_channels = 2 if stereo else 1
        self.num_stems = num_stems

        self.layers = ModuleList([])

        transformer_kwargs = dict(
            dim=dim,
            heads=heads,
            dim_head=dim_head,
            attn_dropout=attn_dropout,
            ff_dropout=ff_dropout,
            flash_attn=flash_attn,
            norm_output=False
        )

        if use_pope:
            # PolarFormer：每层 time/freq 两个 transformer 各持有一个独立 PoPE（可学习 bias）
            time_rotary_embed = freq_rotary_embed = None
        else:
            time_rotary_embed = RotaryEmbedding(dim=dim_head)
            freq_rotary_embed = RotaryEmbedding(dim=dim_head)

        for _ in range(depth):
            tran_modules = []
            if linear_transformer_depth > 0:
                tran_modules.append(Transformer(depth=linear_transformer_depth, linear_attn=True, **transformer_kwargs))
            if use_pope:
                time_pope_embed = PoPE(dim=dim_head, heads=heads)
                freq_pope_embed = PoPE(dim=dim_head, heads=heads)
            else:
                time_pope_embed = freq_pope_embed = None
            tran_modules.append(
                Transformer(depth=time_transformer_depth, rotary_embed=time_rotary_embed,
                            pope_embed=time_pope_embed, **transformer_kwargs)
            )
            tran_modules.append(
                Transformer(depth=freq_transformer_depth, rotary_embed=freq_rotary_embed,
                            pope_embed=freq_pope_embed, **transformer_kwargs)
            )
            self.layers.append(nn.ModuleList(tran_modules))"""
    if old_bsro not in src:
        raise RuntimeError("bs_roformer.py BSRoformer.__init__ 结构异常")
    src = src.replace(old_bsro, new_bsro, 1)

    # 标记
    src = src.replace("from functools import partial\n",
                      "from functools import partial\n\n# " + PATCH_MARK + "\n", 1)
    BS_ROFORMER_PY.write_text(src, encoding="utf-8")
    print("  ✓ bs_roformer.py 补丁完成（PoPE 支持）")


def patch_separator() -> None:
    """给 audio-separator 的 Separator 加白名单放行 + is_roformer 内容判定（幂等）。"""
    if not SEPARATOR_PY.exists():
        print("  ! 未找到 audio-separator，跳过 separator.py 补丁")
        return
    src = SEPARATOR_PY.read_text(encoding="utf-8")
    # 幂等判定：用特征检测（本地预置模型放行 + is_roformer 内容判定）
    if "本地预置模型" in src and "freqs_per_bands" in src:
        print("  ✓ separator.py 已打过补丁")
        return

    # 1) 白名单放行：本地已有 ckpt + 同名 yaml 则直接加载
    old_dl = """        model_path = os.path.join(self.model_file_dir, f"{model_filename}")

        supported_model_files_grouped = self.list_supported_model_files()"""
    new_dl = """        model_path = os.path.join(self.model_file_dir, f"{model_filename}")

        # 白名单外模型放行：若 ckpt 与同名 yaml 已在本地 model_file_dir 中，
        # 视为"预置模型"直接加载（供 PolarFormer 等社区模型使用，配合 setup_stem_models.py 部署）。
        if os.path.isfile(model_path) and not model_filename.endswith(".yaml"):
            yaml_config_filename = os.path.splitext(model_filename)[0] + ".yaml"
            if os.path.isfile(os.path.join(self.model_file_dir, yaml_config_filename)):
                self.logger.info(f"本地预置模型 {model_filename}（含配套 {yaml_config_filename}），跳过注册表校验直接加载")
                self.model_friendly_name = f"Local model: {model_filename}"
                return model_filename, "MDXC", self.model_friendly_name, model_path, yaml_config_filename

        supported_model_files_grouped = self.list_supported_model_files()"""
    if old_dl not in src:
        raise RuntimeError("separator.py download_model_files 结构异常")
    src = src.replace(old_dl, new_dl, 1)

    # 2) is_roformer 判定：优先看 yaml 内容（PolarFormer 文件名不含 "roformer" 子串）
    old_ir = """        if "roformer" in model_data_yaml_filepath:
            model_data["is_roformer"] = True

        return model_data"""
    new_ir = """        # 架构判定：优先看 yaml 内容（model 段是否含 BSRoformer/MelBand 特征键），
        # 文件名含 "roformer" 作为兜底。这样 PolarFormer 等新架构文件名不含 roformer 也能正确走 MDXC 分支。
        if "freqs_per_bands" in model_data.get("model", {}) or "num_bands" in model_data.get("model", {}):
            model_data["is_roformer"] = True
        elif "roformer" in model_data_yaml_filepath:
            model_data["is_roformer"] = True

        return model_data"""
    if old_ir not in src:
        raise RuntimeError("separator.py load_model_data_from_yaml 结构异常")
    src = src.replace(old_ir, new_ir, 1)

    # 标记
    src = src.replace('""" This file contains the Separator class',
                      '""" This file contains the Separator class\n\n# ' + PATCH_MARK + "\n", 1)
    SEPARATOR_PY.write_text(src, encoding="utf-8")
    print("  ✓ separator.py 补丁完成（白名单放行 + is_roformer 判定）")


def patch_bs_roformer_mark_missing() -> None:
    """若 bs_roformer.py 不可用，保证标记仍写入 vendor 根，便于幂等判断。"""
    pass


def fix_yaml() -> None:
    """生成修正版 yaml：对齐 audio-separator 推理需求。
    - audio.hop_length 必须 = model.stft_hop_length（推理 chunk 计算用）
    - 补 inference.dim_t / num_overlap（mdxc_separator 需要）
    - training 的 stem 名用 audio-separator 期望的 Vocals/Instrumental（大小写敏感）
    """
    import yaml
    raw_path = MODEL_DIR / f"{MODEL_NAME}.yaml"
    if not raw_path.exists():
        print("  ! yaml 不存在，跳过修正")
        return
    raw = yaml.load(raw_path.read_text(encoding="utf-8"), Loader=yaml.FullLoader)

    hop = raw["model"]["stft_hop_length"]  # 512
    raw["audio"]["hop_length"] = hop
    raw["audio"]["chunk_size"] = hop * 800  # 512*800=409600，dim_t=801
    inf = raw.setdefault("inference", {})
    # 强制修正（原始 yaml 的 inference 是训练残留，dim_t=1101 与 stft_hop_length 不自洽）
    inf["dim_t"] = 801
    inf["num_overlap"] = 4
    inf.setdefault("batch_size", 1)
    raw["training"]["instruments"] = ["Vocals", "Instrumental"]
    raw["training"]["target_instrument"] = "Vocals"
    raw_path.write_text(yaml.dump(raw, allow_unicode=True), encoding="utf-8")
    print("  ✓ yaml 已修正（hop_length=512, dim_t=801, stems=Vocals/Instrumental）")


def main():
    print("== 人声分离高配模型部署：BS PolarFormer ==")

    # 1) 模型下载
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    print("[1/3] 下载模型权重（102MB）")
    download(MODEL_URL, MODEL_DIR / f"{MODEL_NAME}.ckpt", MODEL_SHA256)
    print("[2/3] 下载模型配置 yaml")
    download(YAML_URL, MODEL_DIR / f"{MODEL_NAME}.yaml", YAML_SHA256)

    # 2) 补丁
    print("[3/3] 应用 audio-separator 补丁")
    patch_bs_roformer()
    patch_separator()

    # 3) yaml 修正
    fix_yaml()

    print("\n完成。GPU 高质量档现已使用 BS PolarFormer。")
    print("清理旧模型（可选，释放约 640MB）：删除 backend/cache/stem_models/model_bs_roformer_ep_317_sdr_12.9755.ckpt")


if __name__ == "__main__":
    main()
