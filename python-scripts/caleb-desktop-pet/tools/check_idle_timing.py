"""Check varied idle timing and shortest-path gaze with a virtual clock."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from calm_motion import CalmMotion

motion = CalmMotion()
now = 100.0
for _ in range(30):
    previous = motion.variant
    motion.reset(now)
    assert motion.variant != previous
    assert 4500 <= motion.frames[0] <= 6500
    assert 1600 <= sum(motion.frames[1:]) <= 1940
    assert motion.idle_frame(now + 4) == 0
    for expected in range(1, 6):
        now = motion.deadline + .001
        assert motion.idle_frame(now) == expected
    now = motion.deadline + .001
    assert motion.idle_frame(now) == 0
assert motion.look_frame(15, 0) == 15
assert motion.look_frame(1, .2) == 0
assert motion.look_frame(1, .21) == 0
assert motion.look_frame(1, .4) == 1
assert motion.look_frame(9, .6) in (0, 2)
print('PASS: varied idle groups, neutral holds, ordered gestures and rate-limited shortest-path gaze')
