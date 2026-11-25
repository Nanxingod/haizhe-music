# 依赖安装路径的关键边界测试（V15.5）
#
# 对应的真实问题（评审 OPTIMIZATION_REVIEW 第 2 节）：
#   ① 界面装到 %LOCALAPPDATA%\Haizhe\deps，README 却让人装到 .venv，
#      两条路径会互相遮蔽 —— deps 里若有 CPU torch，.venv 的 CUDA 版永远用不上
#   ② Windows 上从 PyPI/镜像拿到的 torch 一定是 CPU 版，
#      必须走 download.pytorch.org 才可能拿到 CUDA 版
#   ③ 只探测包名不校验版本，装错变体也不提示

import json

import deps
import pytest


@pytest.fixture(autouse=True)
def _restore_globals(monkeypatch):
    """测试会改模块全局（DEPS_DIR / CONFIG_FILE），跑完要还原"""
    old_dir, old_source = deps.DEPS_DIR, deps._dir_source
    old_cfg = deps.CONFIG_FILE
    old_ver_at = deps._ver_cache["at"]
    yield
    deps.DEPS_DIR, deps._dir_source = old_dir, old_source
    deps.CONFIG_FILE = old_cfg
    deps._ver_cache["at"] = old_ver_at


def test_cuda_plan_splits_torch_from_mirror():
    """CUDA：torch 单独一条走官方 index，其余包必须走镜像"""
    meta = deps.FEATURES["stems"]
    cmds = deps._pip_cmds(meta, "cuda")
    assert len(cmds) == 2

    torch_cmd, rest_cmd = cmds
    assert deps.TORCH_CUDA_INDEX in torch_cmd
    assert any(a.startswith("torch") for a in torch_cmd)
    # torch 那条不能带清华镜像，否则又变回 CPU 版
    assert deps.MIRROR not in torch_cmd

    assert deps.MIRROR in rest_cmd
    assert "audio-separator" in rest_cmd
    assert not any(a == "torch" for a in rest_cmd)


def test_cpu_plan_never_touches_pytorch_index():
    meta = deps.FEATURES["stems"]
    cmds = deps._pip_cmds(meta, "cpu")
    assert cmds, "至少要有一条命令"
    for cmd in cmds:
        assert deps.TORCH_CUDA_INDEX not in cmd
        assert deps.MIRROR in cmd


def test_melody_also_isolates_torch():
    """torchcrepe 依赖 torch，同样要拆开，否则会把已有 CUDA 版覆盖成 CPU 版"""
    cmds = deps._pip_cmds(deps.FEATURES["melody"], "cuda")
    assert deps.TORCH_CUDA_INDEX in cmds[0]
    assert "librosa" in cmds[1] and "torchcrepe" in cmds[1]


def test_npm_feature_has_no_pip_plan():
    """desktop 是 npm 组件，不该生成 pip 命令"""
    assert deps.FEATURES["desktop"]["kind"] == "npm"
    assert deps.resolve_variant(deps.FEATURES["desktop"]) == ""


def test_variant_auto_prefers_cuda_only_when_gpu_exists(monkeypatch):
    meta = deps.FEATURES["stems"]
    monkeypatch.setattr(deps, "gpu_info", lambda force=False: {"available": True})
    assert deps.resolve_variant(meta, "auto") == "cuda"

    monkeypatch.setattr(deps, "gpu_info", lambda force=False: {"available": False})
    assert deps.resolve_variant(meta, "auto") == "cpu"
    # 显式指定优先于探测
    assert deps.resolve_variant(meta, "cpu") == "cpu"


def test_env_var_overrides_config_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("HAIZHE_DEPS_DIR", str(tmp_path / "deps_env"))
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"deps_dir": str(tmp_path / "from_cfg")}), encoding="utf-8")
    monkeypatch.setattr(deps, "CONFIG_FILE", cfg)

    d, source = deps.resolve_deps_dir()
    assert source == "env"
    assert d == tmp_path / "deps_env"


def test_config_dir_used_without_env(tmp_path, monkeypatch):
    monkeypatch.delenv("HAIZHE_DEPS_DIR", raising=False)
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"deps_dir": str(tmp_path / "from_cfg")}), encoding="utf-8")
    monkeypatch.setattr(deps, "CONFIG_FILE", cfg)

    d, source = deps.resolve_deps_dir()
    assert source == "config"
    assert d == tmp_path / "from_cfg"


def test_bad_config_falls_back_to_default(tmp_path, monkeypatch):
    monkeypatch.delenv("HAIZHE_DEPS_DIR", raising=False)
    cfg = tmp_path / "config.json"
    cfg.write_text("{ 这不是 json", encoding="utf-8")
    monkeypatch.setattr(deps, "CONFIG_FILE", cfg)

    d, source = deps.resolve_deps_dir()
    assert source == "default"
    assert d == deps.DEFAULT_DEPS_DIR


def test_installed_version_reads_dist_info(tmp_path, monkeypatch):
    """不 import 包也能读出版本 —— 探测 torch 版本不该花 2 秒"""
    meta_dir = tmp_path / "torch-2.8.0+cu126.dist-info"
    meta_dir.mkdir()
    (meta_dir / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: torch\nVersion: 2.8.0+cu126\n", encoding="utf-8")

    monkeypatch.setattr(deps, "DEPS_DIR", tmp_path)
    monkeypatch.setattr(deps, "LEGACY_DIR", tmp_path / "vendor_none")
    deps._ver_cache["at"] = 0.0

    ver, where = deps.installed_version("torch")
    assert ver == "2.8.0+cu126"
    assert where == str(tmp_path)


def test_torch_version_gate():
    """audio-separator 0.18 要求 torch>=2.0，1.x 要明确判不通过"""
    assert deps.torch_ok("2.8.0+cu126")
    assert deps.torch_ok("2.0.1")
    assert not deps.torch_ok("1.13.1")
    assert not deps.torch_ok("")


def test_clean_rejects_unknown_target():
    r = deps.clean("no_such_cache")
    assert not r["ok"]


def test_clean_refuses_path_outside_allowed_roots(tmp_path, monkeypatch):
    """清理只允许音乐目录与 backend/cache，防止误删"""
    bad = tmp_path / "not_allowed"
    bad.mkdir()
    (bad / "keep.txt").write_text("x", encoding="utf-8")

    monkeypatch.setattr(deps, "_cache_targets", lambda: {"evil": ("坏目标", lambda: bad)})
    r = deps.clean("evil")
    assert not r["ok"]
    assert (bad / "keep.txt").exists()
