"""让 pytest 能直接 import backend 下的模块（scanner / lyrics / library ...）"""
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
