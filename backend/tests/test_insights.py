# 曲库画像的关键边界测试（2026-11-17）
#
# 这两条都是真实踩过的坑，不是假想：
#   ① 批次失败仍写"其他" → 一次网络抖动把整库标签永久固化，下次不再重试
#   ② 模型输出被截断 → 按"最外层大括号闭合"提取会一个对象都拿不到

from dataclasses import dataclass

import insights
import pytest


@dataclass
class FakeSong:
    id: str
    title: str
    artist: str
    artists: list
    duration: float = 200.0
    has_lrc: bool = True


@pytest.fixture()
def music_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(insights.scanner, "MUSIC_DIR", tmp_path)
    monkeypatch.setattr(insights, "has_key", lambda: True)
    return tmp_path


def _songs(n: int) -> list[FakeSong]:
    return [FakeSong(f"id{i}", f"歌{i}", f"歌手{i % 5}", [f"歌手{i % 5}"]) for i in range(n)]


def test_all_batches_failed_writes_nothing(music_dir, monkeypatch):
    """全部批次失败：必须报错，且不留下标签/画像文件（避免生成假饼图）"""
    def boom(_items):
        raise RuntimeError("network down")

    monkeypatch.setattr(insights, "_classify_batch", boom)
    insights._run(_songs(90), 0)

    job = insights.job()
    assert job["running"] is False
    assert "全部失败" in job["error"]
    assert not (music_dir / "曲库分析" / "标签.json").exists()
    assert not (music_dir / "曲库分析" / "画像.json").exists()


def test_partial_failure_keeps_only_successful_batch(music_dir, monkeypatch):
    """第一批持续失败、第二批成功：只缓存 45 条，画像标记 45 首未分类"""
    calls = {"n": 0}

    def flaky(items):
        calls["n"] += 1
        if calls["n"] <= 2:            # 第一批的两次尝试都失败
            raise RuntimeError("network down")
        return {i: ["流行"] for i, _, _ in items}

    monkeypatch.setattr(insights, "_classify_batch", flaky)
    insights._run(_songs(90), 0)

    import json
    labels = json.loads((music_dir / "曲库分析" / "标签.json").read_text(encoding="utf-8"))
    assert len(labels["labels"]) == 45

    profile = json.loads((music_dir / "曲库分析" / "画像.json").read_text(encoding="utf-8"))
    assert profile["stats"]["labeled"] == 45
    assert profile["stats"]["unlabeled"] == 45


def test_parse_picks_survives_truncated_json():
    """模型输出被截断时，前面完整的对象仍要能取出来"""
    raw = (
        '{"picks":['
        '{"title":"年轮","artist":"张碧晨","genre":"流行","reason":"雨夜","kind":"safe"},'
        '{"title":"体面","artist":"于文文","genre":"流行","reason":"通勤","kind":"safe"},'
        '{"title":"水星记","artist":"郭顶","genre":"电子","rea'
    )
    picks = insights._parse_picks(raw)
    assert [p["title"] for p in picks] == ["年轮", "体面"]
    assert picks[0]["kind"] == "safe"


def test_parse_labels_salvages_valid_tags():
    """标签 JSON 有个别脏值时，合法标签仍要保留"""
    raw = '{"labels":{"1":["流行","摇滚"],"2":["不存在的标签"],"3":["民谣"]}}'
    out = insights._parse_labels(raw)
    assert out[1] == ["流行", "摇滚"]
    assert 2 not in out          # 不在词表里的直接丢掉
    assert out[3] == ["民谣"]
