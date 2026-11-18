"""核心逻辑单测（V14.9）

只测"纯函数 + 无副作用"的部分，这些都是改动时最容易悄悄坏掉、又最难手测的：
- LRC 解析（时间标签、空行、无标签行）
- 搜索（中文 / 全拼 / 首字母）
- 收藏 / 歌单 / 播放历史的增删与去重

运行：  cd backend && python -m pytest tests -q
"""
import sys
from pathlib import Path

import pytest

from models import Song
import scanner
import library as lib


# ── 工具 ──────────────────────────────────────────────────────────

def make_song(sid: str, title: str, artist: str) -> Song:
    return Song(id=sid, title=title, artist=artist, artists=[artist],
                file_path=f"D:/fake/{title}.mp3", duration=200.0)


SONGS = [
    make_song("1", "晴天", "周杰伦"),
    make_song("2", "七里香", "周杰伦"),
    make_song("3", "小半", "陈粒"),
    make_song("4", "Faded", "Alan Walker"),
]


@pytest.fixture()
def temp_music_dir(tmp_path, monkeypatch):
    """把 library 的落盘目录换到临时目录，绝不碰真实曲库"""
    monkeypatch.setattr(scanner, "MUSIC_DIR", tmp_path)
    lib.clear_cache()
    yield tmp_path
    lib.clear_cache()


# ── 搜索 ──────────────────────────────────────────────────────────

def test_search_chinese_substring():
    assert [s.id for s in scanner.search_songs(SONGS, "晴天")] == ["1"]
    assert sorted(s.id for s in scanner.search_songs(SONGS, "周杰伦")) == ["1", "2"]


def test_search_by_full_pinyin():
    # 陈粒 → chenli；晴天 → qingtian
    assert [s.id for s in scanner.search_songs(SONGS, "chenli")] == ["3"]
    assert [s.id for s in scanner.search_songs(SONGS, "qingtian")] == ["1"]


def test_search_by_initials():
    # zjl → 周杰伦（歌手首字母）
    assert sorted(s.id for s in scanner.search_songs(SONGS, "zjl")) == ["1", "2"]
    # qlx → 七里香（歌名首字母）
    assert [s.id for s in scanner.search_songs(SONGS, "qlx")] == ["2"]


def test_search_is_case_insensitive_and_ignores_spaces():
    assert [s.id for s in scanner.search_songs(SONGS, "FADED")] == ["4"]
    assert [s.id for s in scanner.search_songs(SONGS, "zhou jielun")] != []


def test_search_single_char_does_not_explode():
    """单字不应触发首字母/拼音匹配（否则 "z" 会命中一大片）"""
    res = scanner.search_songs(SONGS, "z")
    assert res == []


def test_search_empty_query_returns_all():
    assert len(scanner.search_songs(SONGS, "")) == len(SONGS)


# ── LRC 解析 ──────────────────────────────────────────────────────

def test_parse_lrc_basic(tmp_path):
    from lyrics import parse_lrc
    p = tmp_path / "a.lrc"
    p.write_text(
        "[ti:测试]\n[00:01.00]第一句\n[00:03.50]第二句\n\n[00:10.20]第三句\n",
        encoding="utf-8",
    )
    ly = parse_lrc(str(p))
    texts = [l.text for l in ly.lines if l.text.strip()]
    times = [l.time for l in ly.lines if l.text.strip()]
    assert texts == ["第一句", "第二句", "第三句"]
    assert times == pytest.approx([1.0, 3.5, 10.2])


def test_parse_lrc_ignores_garbage_lines(tmp_path):
    from lyrics import parse_lrc
    p = tmp_path / "b.lrc"
    p.write_text("[00:02.00]真的歌词\n这一行没有时间标签\n[ar:某人]\n", encoding="utf-8")
    ly = parse_lrc(str(p))
    assert [l.text for l in ly.lines if l.text.strip()] == ["真的歌词"]


# ── 收藏 / 歌单 ────────────────────────────────────────────────────

def test_favorite_toggle(temp_music_dir):
    assert lib.is_favorite("s1") is False
    assert lib.toggle_favorite("s1") is True
    assert lib.is_favorite("s1") is True
    assert lib.toggle_favorite("s1") is False
    assert lib.is_favorite("s1") is False


def test_playlist_add_is_idempotent(temp_music_dir):
    pid = lib.create_playlist("通勤")["id"]
    assert lib.add_to_playlist(pid, "s1") is True
    assert lib.add_to_playlist(pid, "s1") is True        # 再加一次不应重复
    assert lib.playlist_songs(pid) == ["s1"]
    assert lib.playlists_of("s1") == [pid]


def test_playlist_remove_is_idempotent(temp_music_dir):
    pid = lib.create_playlist("健身")["id"]
    lib.add_to_playlist(pid, "s1")
    assert lib.remove_from_playlist(pid, "s1") is True
    assert lib.playlist_songs(pid) == []
    assert lib.remove_from_playlist(pid, "s1") is True    # 移除不存在的也算成功
    assert lib.playlist_songs(pid) == []


def test_playlist_missing_returns_none(temp_music_dir):
    assert lib.add_to_playlist("pl_nope", "s1") is None
    assert lib.remove_from_playlist("pl_nope", "s1") is None
    assert lib.playlist_songs("pl_nope") is None


def test_playlist_rename_and_delete(temp_music_dir):
    pid = lib.create_playlist("旧名")["id"]
    assert lib.rename_playlist(pid, "新名") is True
    assert lib.playlist_name(pid) == "新名"
    assert lib.delete_playlist(pid) is True
    assert lib.playlist_name(pid) is None
    assert lib.delete_playlist(pid) is False


def test_song_in_multiple_playlists(temp_music_dir):
    """歌单模型：一首歌可以同时属于多个歌单"""
    a = lib.create_playlist("A")["id"]
    b = lib.create_playlist("B")["id"]
    lib.add_to_playlist(a, "s1")
    lib.add_to_playlist(b, "s1")
    assert sorted(lib.playlists_of("s1")) == sorted([a, b])
    lib.remove_from_playlist(a, "s1")
    assert lib.playlists_of("s1") == [b]


# ── 播放历史 ──────────────────────────────────────────────────────

def test_history_dedupes_and_keeps_recent_first(temp_music_dir):
    lib.record_play("a")
    lib.record_play("b")
    lib.record_play("a")                 # 再听一次 a → 提到最前，且不重复
    assert lib.recent_ids() == ["a", "b"]


def test_history_caps_at_limit(temp_music_dir, monkeypatch):
    monkeypatch.setattr(lib, "HISTORY_MAX", 3)
    for i in range(6):
        lib.record_play(f"s{i}")
    ids = lib.recent_ids()
    assert len(ids) == 3
    assert ids[0] == "s5"


def test_summary_counts(temp_music_dir):
    pl = lib.create_playlist("X")["id"]
    lib.add_to_playlist(pl, "s1")
    lib.toggle_favorite("s2")
    lib.record_play("s3")
    s = lib.summary()
    assert s["favorites"] == 1
    assert s["playlists"][0]["count"] == 1
    assert s["recent"] == 1


# ── 数据安全 ──────────────────────────────────────────────────────

def test_data_file_survives_corruption(temp_music_dir):
    """数据文件被写成垃圾时，不能崩，应该按空数据继续"""
    (temp_music_dir / lib.FILE_NAME).write_text("{ 这不是 json ", encoding="utf-8")
    lib.clear_cache()
    assert lib.summary()["favorites"] == 0
